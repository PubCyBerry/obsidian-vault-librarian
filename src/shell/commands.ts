import type { Command, CommandContext, ExecResult } from 'just-bash/browser';
import { defineCommand } from 'just-bash/browser';
import type { App } from 'obsidian';
import { Platform, requestUrl } from 'obsidian';
import { AWAY_UNKNOWN, wasHiddenSince, whenVisible } from '../visibility';
import { latin1, toBytes } from './vault-fs';

export const NO_CLI = 'obsidian: the command registry is not available in this version';

/** Developer verbs that only look at the app: its DOM, styles, logs and a picture of it. */
const DEV_LOOKS = new Set(['dev:screenshot', 'dev:errors', 'dev:console', 'dev:dom', 'dev:css']);

/**
 * Verbs that reach the whole app or the developer tools, making every permission meaningless:
 * `eval`, and `dev:cdp` which can evaluate through the debugger. Those in DEV_LOOKS stay open.
 */
const WITHHELD = (verb: string) =>
	verb === 'eval' || verb === 'devtools' || (verb.startsWith('dev:') && !DEV_LOOKS.has(verb));

export interface CommandDeps {
	app: App;
	signal?: AbortSignal;
}

/** A command the settings or the user refused. 126 is the shell's "found but not runnable". */
export const REFUSED = 126;

// curl

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

interface CurlArgs {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
	silent: boolean;
	include: boolean;
	output?: string;
	failOnError: boolean;
	maxTimeMs?: number;
}

export class CurlUsageError extends Error {}

/** Parses the curl options we support; anything else is an error rather than a silent difference. */
export function parseCurl(argv: string[]): CurlArgs {
	const out: CurlArgs = {
		url: '',
		method: '',
		headers: {},
		silent: false,
		include: false,
		failOnError: false,
	};
	const value = (i: number, flag: string): string => {
		const v = args[i];
		if (v === undefined) throw new CurlUsageError(`option ${flag} needs a value`);
		return v;
	};
	// curl lets short flags be bundled, as in `curl -sfL`; split them before reading the options.
	const args: string[] = [];
	for (const arg of argv) {
		if (/^-[a-zA-Z]{2,}$/.test(arg)) args.push(...[...arg.slice(1)].map((c) => `-${c}`));
		else args.push(arg);
	}
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		switch (arg) {
			case '-s':
			case '--silent':
				out.silent = true;
				break;
			case '-i':
			case '--include':
				out.include = true;
				break;
			case '-f':
			case '--fail':
				out.failOnError = true;
				break;
			case '-L':
			case '--location':
				break; // requestUrl already follows redirects
			case '-I':
			case '--head':
				out.method = 'HEAD';
				out.include = true;
				break;
			case '-X':
			case '--request':
				out.method = value(++i, arg).toUpperCase();
				break;
			case '-o':
			case '--output':
				out.output = value(++i, arg);
				break;
			case '--max-time':
				out.maxTimeMs = Number(value(++i, arg)) * 1000;
				break;
			case '-H':
			case '--header': {
				const header = value(++i, arg);
				const at = header.indexOf(':');
				if (at > 0) out.headers[header.slice(0, at).trim()] = header.slice(at + 1).trim();
				break;
			}
			case '-d':
			case '--data':
			case '--data-raw':
				out.body = value(++i, arg);
				break;
			default:
				if (arg.startsWith('-')) throw new CurlUsageError(`unknown option ${arg}`);
				out.url = arg;
		}
	}
	if (!out.method) out.method = out.body === undefined ? 'GET' : 'POST';
	if (!out.url) throw new CurlUsageError('no URL specified');
	let parsed: URL;
	try {
		parsed = new URL(out.url);
	} catch {
		throw new CurlUsageError(`could not resolve host: ${out.url}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
		throw new CurlUsageError(`unsupported protocol: ${parsed.protocol.replace(':', '')}`);
	return out;
}

/**
 * curl over Obsidian's requestUrl, which skips CORS on both desktop and phone. The response body
 * reaches stdout exactly as the server sent it: shaping it is the pipeline's job, not ours.
 */
export function createCurl(deps: CommandDeps): Command {
	return defineCommand('curl', async (argv, ctx): Promise<ExecResult> => {
		let args: CurlArgs;
		try {
			args = parseCurl(argv);
		} catch (error) {
			const message = error instanceof CurlUsageError ? error.message : String(error);
			return { stdout: '', stderr: `curl: ${message}\n`, exitCode: 2 };
		}
		// No permission of its own: the bash call that wrote this line was approved with the URL
		// in plain sight, so a second card for the same request would only repeat the question.
		return await fetchIt(args, deps, ctx);
	});
}

async function fetchIt(
	args: CurlArgs,
	deps: CommandDeps,
	ctx: Pick<CommandContext, 'fs' | 'cwd'>,
): Promise<ExecResult> {
	{
		const send = () =>
			withTimeout(
				requestUrl({
					url: args.url,
					method: args.method,
					headers: args.headers,
					body: args.body,
					throw: false,
				}),
				args.maxTimeMs,
				deps.signal,
			);
		const startedAt = Date.now();
		let response: Awaited<ReturnType<typeof send>>;
		try {
			response = await send();
		} catch (error) {
			const away = wasHiddenSince(startedAt);
			// The app was frozen mid-request: repeat it once, but only when repeating is safe.
			if (!away || !IDEMPOTENT.has(args.method)) return fail(error, args, away);
			try {
				// Stop ends this wait too, even one that starts after Stop released the others.
				await whenVisible(deps.signal);
				response = await send();
			} catch (retryError) {
				return fail(retryError, args, away);
			}
		}
		const head = args.include
			? `HTTP ${response.status}\n${Object.entries(response.headers ?? {})
					.map(([k, v]) => `${k}: ${String(v)}`)
					.join('\n')}\n\n`
			: '';
		const body = args.method === 'HEAD' ? new Uint8Array() : bodyOf(response);
		// Bytes, not text: an image read as text comes out with U+FFFD in place of its bytes.
		const out = toBytes(head);
		const all = new Uint8Array(out.length + body.length);
		all.set(out);
		all.set(body, out.length);
		if (args.output) {
			await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, args.output), all);
			return { stdout: '', stderr: '', exitCode: 0 };
		}
		if (args.failOnError && response.status >= 400)
			return {
				stdout: head,
				stderr: args.silent ? '' : `curl: (22) HTTP ${response.status}\n`,
				exitCode: 22,
			};
		return { stdout: latin1(all), stdoutKind: 'bytes', stderr: '', exitCode: 0 };
	}
}

/** Obsidian's response decodes `text` on read; the raw bytes are in `arrayBuffer`. */
function bodyOf(response: { text?: string; arrayBuffer?: ArrayBuffer }): Uint8Array {
	if (response.arrayBuffer) return new Uint8Array(response.arrayBuffer);
	return toBytes(response.text ?? '');
}

function fail(error: unknown, args: CurlArgs, away: boolean): ExecResult {
	const reason = error instanceof Error ? error.message : String(error);
	const timedOut = reason === TIMED_OUT;
	const note = away && !IDEMPOTENT.has(args.method) ? `\ncurl: ${AWAY_UNKNOWN}` : '';
	return {
		stdout: '',
		stderr: args.silent ? '' : `curl: (${timedOut ? 28 : 7}) ${reason}${note}\n`,
		exitCode: timedOut ? 28 : 7,
	};
}

const TIMED_OUT = 'operation timed out';

function withTimeout<T>(
	work: Promise<T>,
	ms: number | undefined,
	signal?: AbortSignal,
): Promise<T> {
	if (!ms && !signal) return work;
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) window.clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			fn();
		};
		const onAbort = () => finish(() => reject(new Error('aborted')));
		const timer = ms
			? window.setTimeout(() => finish(() => reject(new Error(TIMED_OUT))), ms)
			: undefined;
		signal?.addEventListener('abort', onAbort);
		work.then(
			(v) => finish(() => resolve(v)),
			(e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))),
		);
	});
}

// obsidian

interface CliEntry {
	handler: (flags: Record<string, unknown>) => unknown;
	description?: string;
	flags?: Record<string, { value?: string; description?: string; required?: boolean }>;
}

/** Obsidian's own CLI registry. Not in the public API, so it is typed narrowly and checked here. */
export function cliHandlers(app: App): Map<string, CliEntry> | null {
	const cli = (app as unknown as { cli?: { handlers?: unknown } }).cli;
	return cli?.handlers instanceof Map ? (cli.handlers as Map<string, CliEntry>) : null;
}

interface NodeFs {
	readFileSync(path: string): Uint8Array;
	unlinkSync(path: string): void;
}

/**
 * Obsidian's `dev:screenshot` writes the PNG with Node's fs wherever `path` points, past the
 * vault's approval and its read-only folders. So it runs without a path, into the system's temp
 * folder, and the picture moves into the shell's filesystem: to `path`, which asks like any
 * other write when it is in the vault, or to /tmp.
 */
async function screenshot(
	entry: CliEntry,
	flags: Record<string, unknown>,
	ctx: CommandContext,
): Promise<ExecResult> {
	const nodeRequire = Platform.isDesktopApp
		? (window as unknown as { require?: (id: string) => unknown }).require
		: undefined;
	const fs = nodeRequire ? (nodeRequire('fs') as NodeFs) : null;
	if (!fs) return { stdout: '', stderr: 'obsidian: dev:screenshot needs desktop\n', exitCode: 1 };
	const taken = String(await entry.handler({}));
	const bytes = new Uint8Array(fs.readFileSync(taken));
	fs.unlinkSync(taken);
	const wanted =
		typeof flags.path === 'string' ? flags.path : `/tmp/screenshot-${Date.now()}.png`;
	const target = ctx.fs.resolvePath(ctx.cwd, wanted);
	await ctx.fs.writeFile(target, bytes);
	return { stdout: `${target}\n`, stderr: '', exitCode: 0 };
}

function nearest(verb: string, known: string[]): string[] {
	return known
		.filter((k) => k.startsWith(verb.slice(0, 3)) || verb.startsWith(k.slice(0, 3)))
		.slice(0, 5);
}

function helpText(handlers: Map<string, CliEntry>): string {
	const lines: string[] = ['Usage: obsidian <command> [key=value ...]', ''];
	for (const [verb, entry] of [...handlers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		if (WITHHELD(verb) || verb.startsWith('__')) continue;
		lines.push(`  ${verb.padEnd(22)}${entry.description ?? ''}`);
		for (const [flag, meta] of Object.entries(entry.flags ?? {}))
			lines.push(
				`    ${(meta.value ? `${flag}=${meta.value}` : flag).padEnd(20)}${meta.description ?? ''}`,
			);
	}
	return lines.join('\n');
}

/**
 * The Obsidian CLI, in process. The verbs live in the app's own registry and are written against
 * the vault and workspace APIs, so the same ones answer on desktop and on a phone.
 */
export function createObsidian(deps: CommandDeps): Command {
	return defineCommand('obsidian', async (argv, ctx): Promise<ExecResult> => {
		const verb = argv[0];
		if (!verb)
			return {
				stdout: '',
				stderr: 'obsidian: no command given, try `obsidian help`\n',
				exitCode: 2,
			};
		const handlers = cliHandlers(deps.app);
		if (!handlers) return { stdout: '', stderr: `${NO_CLI}\n`, exitCode: 127 };
		if (verb === 'help') return { stdout: `${helpText(handlers)}\n`, stderr: '', exitCode: 0 };
		const entry = WITHHELD(verb) ? undefined : handlers.get(verb);
		if (!entry) {
			const did = nearest(
				verb,
				[...handlers.keys()].filter((k) => !WITHHELD(k)),
			);
			const hint = did.length ? ` Did you mean: ${did.join(', ')}?` : '';
			return {
				stdout: '',
				stderr: `obsidian: unknown command: ${verb}.${hint}\n`,
				exitCode: 127,
			};
		}
		const flags: Record<string, unknown> = {};
		for (const arg of argv.slice(1)) {
			const at = arg.indexOf('=');
			if (at > 0) flags[arg.slice(0, at)] = arg.slice(at + 1);
			else flags[arg] = true;
		}
		try {
			if (verb === 'dev:screenshot') return await screenshot(entry, flags, ctx);
			// The console is captured only while the debugger is attached; attaching twice is a no-op.
			if (verb === 'dev:console') await handlers.get('dev:debug')?.handler({ on: true });
			const result = await entry.handler(flags);
			// Handlers answer with a string; a few return a value, which is clearest as JSON.
			const text =
				typeof result === 'string'
					? result
					: result === undefined || result === null
						? ''
						: JSON.stringify(result);
			return {
				stdout: text.endsWith('\n') || !text ? text : `${text}\n`,
				stderr: '',
				exitCode: 0,
			};
		} catch (error) {
			// The handlers throw plain strings, which is how the real CLI reports a refusal.
			const message = error instanceof Error ? error.message : String(error);
			return { stdout: '', stderr: `obsidian: ${message}\n`, exitCode: 1 };
		}
	});
}
