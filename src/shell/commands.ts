import type { Command, ExecResult } from 'just-bash/browser';
import { defineCommand } from 'just-bash/browser';
import type { App } from 'obsidian';
import { requestUrl } from 'obsidian';
import { AWAY_UNKNOWN, wasHiddenSince, whenVisible } from '../visibility';

export const NO_CLI = 'obsidian: the command registry is not available in this version';

/** Verbs that reach the whole app or the developer tools, making every permission meaningless. */
const WITHHELD = (verb: string) =>
	verb === 'eval' || verb === 'devtools' || verb.startsWith('dev:');

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
	ctx: {
		fs: {
			writeFile: (p: string, c: string) => Promise<void>;
			resolvePath: (b: string, p: string) => string;
		};
		cwd: string;
	},
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
		const body = args.method === 'HEAD' ? '' : bodyOf(response);
		if (args.output) {
			await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, args.output), head + body);
			return { stdout: '', stderr: '', exitCode: 0 };
		}
		if (args.failOnError && response.status >= 400)
			return {
				stdout: head,
				stderr: args.silent ? '' : `curl: (22) HTTP ${response.status}\n`,
				exitCode: 22,
			};
		return { stdout: head + body, stderr: '', exitCode: 0 };
	}
}

function bodyOf(response: { text?: string; arrayBuffer?: ArrayBuffer }): string {
	if (typeof response.text === 'string') return response.text;
	if (!response.arrayBuffer) return '';
	return new TextDecoder().decode(new Uint8Array(response.arrayBuffer));
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
	return defineCommand('obsidian', async (argv): Promise<ExecResult> => {
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
