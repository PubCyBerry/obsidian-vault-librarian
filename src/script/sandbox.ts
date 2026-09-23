import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import {
	newQuickJSWASMModuleFromVariant,
	type QuickJSContext,
	type QuickJSDeferredPromise,
	type QuickJSHandle,
	type QuickJSWASMModule,
} from 'quickjs-emscripten-core';

export const SLICE_STOPPED = (seconds: number) =>
	`The script computed for ${seconds} seconds without waiting and was stopped.`;

/**
 * Stops the script's clock while the user, not the script, is the one taking time (an approval
 * card). Calls nest: the clock runs again when every pause has been resumed.
 */
export interface ScriptClock {
	pause(): void;
	resume(): void;
}

/** A host function the script reaches as `await tools.<name>(args)`. */
export type HostTool = (args: unknown, clock: ScriptClock) => Promise<unknown>;

export interface SandboxRun {
	code: string;
	tools: Record<string, HostTool>;
	timeoutMs: number;
	/** Longest stretch of computing without an await; the app's UI thread waits meanwhile. */
	sliceMs: number;
	memoryBytes: number;
	signal?: AbortSignal;
}

export interface SandboxResult {
	ok: boolean;
	logs: string[];
	value?: unknown;
	error?: string;
}

const MAX_LOG_CHARS = 200_000;
/** A gap this long between watchdog ticks means the app was paused, not that the script ran. */
const PAUSE_GAP_MS = 2000;

let engine: Promise<QuickJSWASMModule> | null = null;

/** The WebAssembly engine, compiled once per app run on first use. */
function quickjs(): Promise<QuickJSWASMModule> {
	engine ??= newQuickJSWASMModuleFromVariant(variant).catch((error: unknown) => {
		engine = null;
		throw error;
	});
	return engine;
}

function show(value: unknown): string {
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function describe(error: unknown): string {
	if (error && typeof error === 'object' && 'message' in error) {
		const e = error as { name?: string; message?: string; stack?: string };
		return `${e.name ?? 'Error'}: ${e.message ?? ''}${e.stack ? `\n${e.stack.trimEnd()}` : ''}`;
	}
	return show(error);
}

function bootstrap(names: string[]): string {
	return `(() => {
	const call = globalThis.__call;
	delete globalThis.__call;
	const tools = {};
	for (const name of ${JSON.stringify(names)}) {
		tools[name] = async (args) => {
			const r = JSON.parse(await call(name, JSON.stringify(args === undefined ? {} : args)));
			if (!r.ok) throw new Error(r.error);
			return r.value;
		};
	}
	globalThis.tools = Object.freeze(tools);
})();`;
}

/**
 * Runs agent-written JavaScript in QuickJS. The global scope holds the standard built-ins,
 * `console` and `tools` only: no fetch, no Obsidian app, no secrets. Every way out goes through
 * a host tool, which applies the same permissions as a tool call from the model.
 */
export async function runSandboxed(run: SandboxRun): Promise<SandboxResult> {
	const QuickJS = await quickjs();
	const runtime = QuickJS.newRuntime();
	runtime.setMemoryLimit(run.memoryBytes);
	runtime.setMaxStackSize(1024 * 1024);
	const vm: QuickJSContext = runtime.newContext();
	const logs: string[] = [];
	let logChars = 0;
	const pending = new Set<QuickJSDeferredPromise>();
	let deadline = Date.now() + run.timeoutMs;
	let sliceStart = Date.now();
	let stop: 'aborted' | 'timeout' | 'slice' | null = null;
	let finished = false;
	let pauses = 0;
	let pausedAt = 0;
	const clock: ScriptClock = {
		pause() {
			if (pauses++ === 0) pausedAt = Date.now();
		},
		resume() {
			if (pauses > 0 && --pauses === 0) deadline += Date.now() - pausedAt;
		},
	};
	const overdue = (now: number) => pauses === 0 && now > deadline;

	// Once set, every later entry into the engine is refused too, so a stopped script stays stopped.
	runtime.setInterruptHandler(() => {
		if (!stop) {
			const now = Date.now();
			if (run.signal?.aborted) stop = 'aborted';
			else if (overdue(now)) stop = 'timeout';
			else if (now - sliceStart > run.sliceMs) stop = 'slice';
		}
		return stop !== null;
	});

	const enter = <T>(fn: () => T): T => {
		sliceStart = Date.now();
		return fn();
	};
	// Runs the promise jobs a resolved host call unblocked. A job that throws rejects its own
	// promise inside the script; the error handle returned here is only a copy.
	const pump = () =>
		enter(() => {
			const jobs = runtime.executePendingJobs();
			if (jobs.error) jobs.error.dispose();
		});

	const consoleObj = vm.newObject();
	for (const level of ['log', 'info', 'warn', 'error'] as const) {
		const fn = vm.newFunction(level, (...args: QuickJSHandle[]) => {
			if (logChars > MAX_LOG_CHARS) return;
			const line = args.map((a) => show(vm.dump(a))).join(' ');
			const prefixed = level === 'warn' || level === 'error' ? `[${level}] ${line}` : line;
			logChars += prefixed.length;
			logs.push(logChars > MAX_LOG_CHARS ? '[console output cut]' : prefixed);
		});
		vm.setProp(consoleObj, level, fn);
		fn.dispose();
	}
	vm.setProp(vm.global, 'console', consoleObj);
	consoleObj.dispose();

	const settle = (deferred: QuickJSDeferredPromise, payload: string) => {
		pending.delete(deferred);
		if (finished || stop) return;
		const handle = vm.newString(payload);
		deferred.resolve(handle);
		handle.dispose();
		pump();
	};
	const call = vm.newFunction('__call', (nameHandle, argsHandle) => {
		const name = vm.getString(nameHandle);
		const args = vm.getString(argsHandle);
		const deferred = vm.newPromise();
		pending.add(deferred);
		const host = run.tools[name];
		(async () => {
			if (!host) throw new Error(`Tool ${name} is not available to scripts`);
			return host(JSON.parse(args), clock);
		})().then(
			(value) => settle(deferred, JSON.stringify({ ok: true, value })),
			(error: unknown) =>
				settle(
					deferred,
					JSON.stringify({
						ok: false,
						error: error instanceof Error ? error.message : show(error),
					}),
				),
		);
		return deferred.handle;
	});
	vm.setProp(vm.global, '__call', call);
	call.dispose();

	let watchdog = 0;
	try {
		const boot = vm.evalCode(bootstrap(Object.keys(run.tools)), 'bootstrap.js');
		vm.unwrapResult(boot).dispose();

		const started = enter(() => vm.evalCode(`(async () => {\n${run.code}\n})()`, 'script.js'));
		if (started.error) {
			const error: unknown = vm.dump(started.error);
			started.error.dispose();
			return { ok: false, logs, error: stopped(stop, run) ?? describe(error) };
		}
		const settled = vm.resolvePromise(started.value);
		started.value.dispose();
		pump();

		// The engine only checks its limits while it runs; this watches the script while it waits.
		const stoppedWhileWaiting = new Promise<null>((resolve) => {
			let lastTick = Date.now();
			const tick = () => {
				const now = Date.now();
				if (now - lastTick > PAUSE_GAP_MS) deadline += now - lastTick;
				lastTick = now;
				if (run.signal?.aborted) stop ??= 'aborted';
				else if (overdue(now)) stop ??= 'timeout';
				if (stop) resolve(null);
				else watchdog = window.setTimeout(tick, 250);
			};
			watchdog = window.setTimeout(tick, 250);
		});
		const outcome = await Promise.race([settled, stoppedWhileWaiting]);
		const reason = stopped(stop, run);
		if (reason) {
			if (outcome) (outcome.error ?? outcome.value)?.dispose();
			return { ok: false, logs, error: reason };
		}
		if (!outcome) return { ok: false, logs, error: 'Script stopped' };
		if (outcome.error) {
			const error: unknown = vm.dump(outcome.error);
			outcome.error.dispose();
			return { ok: false, logs, error: describe(error) };
		}
		const value: unknown = vm.dump(outcome.value);
		outcome.value.dispose();
		return { ok: true, logs, value };
	} finally {
		finished = true;
		window.clearTimeout(watchdog);
		for (const deferred of pending) deferred.dispose();
		try {
			vm.dispose();
			runtime.dispose();
		} catch {
			// A stopped script can leave engine objects behind; the runtime is thrown away either way.
		}
	}
}

function stopped(stop: 'aborted' | 'timeout' | 'slice' | null, run: SandboxRun): string | null {
	if (stop === 'aborted') return 'Script stopped';
	if (stop === 'timeout')
		return `Script timed out after ${Math.round(run.timeoutMs / 1000)} seconds`;
	if (stop === 'slice') return SLICE_STOPPED(Math.round(run.sliceMs / 1000));
	return null;
}
