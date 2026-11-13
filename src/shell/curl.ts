import type { Command, CommandContext, ExecResult } from 'just-bash/browser';
import { defineCommand } from 'just-bash/browser';
import { requestUrl } from 'obsidian';
import { AWAY_UNKNOWN, wasHiddenSince, whenVisible } from '../visibility';
import type { CommandDeps } from './commands';
import { latin1, toBytes } from './vault-fs';

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** One `-d`: its text, or the file it names, and how that goes into the request. */
interface CurlData {
	/** What comes before the value, such as `name=` for --data-urlencode. */
	name: string;
	value: string;
	/** `value` is a path to read when the command runs, or `-` for stdin. */
	file: boolean;
	encode: boolean;
	/** -d drops a file's line breaks, as curl does; --data-binary keeps them. */
	oneLine: boolean;
}

export interface CurlArgs {
	url: string;
	method: string;
	headers: Record<string, string>;
	/** The request body. With a -d that reads a file it is put together when the command runs. */
	body?: string;
	data: CurlData[];
	/** -G: the data goes in the query string. */
	query: boolean;
	silent: boolean;
	showError: boolean;
	include: boolean;
	verbose: boolean;
	output?: string;
	dumpHeader?: string;
	writeOut?: string;
	failOnError: boolean;
	failWithBody: boolean;
	maxTimeMs?: number;
}

export class CurlUsageError extends Error {}

/** Short options by their long name. */
const SHORT: Record<string, string> = {
	s: 'silent',
	S: 'show-error',
	i: 'include',
	f: 'fail',
	I: 'head',
	v: 'verbose',
	G: 'get',
	O: 'remote-name',
	X: 'request',
	o: 'output',
	m: 'max-time',
	H: 'header',
	d: 'data',
	A: 'user-agent',
	e: 'referer',
	u: 'user',
	b: 'cookie',
	r: 'range',
	w: 'write-out',
	D: 'dump-header',
	L: 'location',
	k: 'insecure',
	N: 'no-buffer',
	'#': 'progress-bar',
	g: 'globoff',
};

/** Options that take the next word, or the rest of a short cluster as in `-XPOST`. */
const VALUED = new Set([
	'request',
	'output',
	'max-time',
	'header',
	'data',
	'data-ascii',
	'data-raw',
	'data-binary',
	'data-urlencode',
	'json',
	'user-agent',
	'referer',
	'user',
	'cookie',
	'range',
	'write-out',
	'dump-header',
	'url',
	'connect-timeout',
	'max-redirs',
	'retry',
	'retry-delay',
	'retry-max-time',
]);

/**
 * Options that change nothing here: requestUrl follows redirects, unpacks a compressed body and
 * checks certificates on its own, has no progress meter, and asks once.
 */
const NO_EFFECT = new Set([
	'location',
	'location-trusted',
	'compressed',
	'insecure',
	'no-buffer',
	'progress-bar',
	'no-progress-meter',
	'globoff',
	'http1.1',
	'http2',
	'connect-timeout',
	'max-redirs',
	'retry',
	'retry-delay',
	'retry-max-time',
	'retry-all-errors',
	'retry-connrefused',
]);

function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some((h) => h.toLowerCase() === name);
}

/** Puts the -d parts where they go: the query with -G, else the body, a form unless said. */
function place(out: CurlArgs, parts: string[]): void {
	if (!parts.length) return;
	const joined = parts.join('&');
	if (out.query) out.url += (out.url.includes('?') ? '&' : '?') + joined;
	else {
		out.body = joined;
		if (!hasHeader(out.headers, 'content-type'))
			out.headers['Content-Type'] = 'application/x-www-form-urlencoded';
	}
}

function partOf(d: CurlData, value: string): string {
	const text = d.oneLine && d.file ? value.replace(/[\r\n]/g, '') : value;
	return d.name + (d.encode ? encodeURIComponent(text) : text);
}

/**
 * Parses the curl options we support; anything else is an error rather than a silent difference.
 * Short options may be clustered and carry their value, as in `-sSL` and `-XPOST`.
 */
export function parseCurl(argv: string[]): CurlArgs {
	const out: CurlArgs = {
		url: '',
		method: '',
		headers: {},
		data: [],
		query: false,
		silent: false,
		showError: false,
		include: false,
		verbose: false,
		failOnError: false,
		failWithBody: false,
	};
	const urls: string[] = [];
	let remoteName = false;
	let json = false;
	const plain = (value: string, oneLine: boolean): CurlData =>
		value.startsWith('@')
			? { name: '', value: value.slice(1), file: true, encode: false, oneLine }
			: { name: '', value, file: false, encode: false, oneLine };
	const apply = (name: string, value = ''): void => {
		switch (name) {
			case 'silent':
				out.silent = true;
				break;
			case 'show-error':
				out.showError = true;
				break;
			case 'include':
				out.include = true;
				break;
			case 'fail':
				out.failOnError = true;
				break;
			case 'fail-with-body':
				out.failOnError = true;
				out.failWithBody = true;
				break;
			case 'head':
				out.method = 'HEAD';
				out.include = true;
				break;
			case 'verbose':
				out.verbose = true;
				break;
			case 'get':
				out.query = true;
				break;
			case 'remote-name':
				remoteName = true;
				break;
			case 'request':
				out.method = value.toUpperCase();
				break;
			case 'output':
				out.output = value;
				break;
			case 'max-time':
				out.maxTimeMs = Number(value) * 1000;
				break;
			case 'header': {
				const at = value.indexOf(':');
				if (at > 0) out.headers[value.slice(0, at).trim()] = value.slice(at + 1).trim();
				break;
			}
			case 'user-agent':
				out.headers['User-Agent'] = value;
				break;
			case 'referer':
				out.headers.Referer = value;
				break;
			case 'cookie':
				// curl reads a value without `=` as a cookie file, which there is none of here.
				if (!value.includes('='))
					throw new CurlUsageError('cookie files are not supported; pass name=value');
				out.headers.Cookie = value;
				break;
			case 'range':
				out.headers.Range = `bytes=${value}`;
				break;
			case 'user':
				out.headers.Authorization = `Basic ${btoa(latin1(toBytes(value)))}`;
				break;
			case 'write-out':
				out.writeOut = value;
				break;
			case 'dump-header':
				out.dumpHeader = value;
				break;
			case 'url':
				urls.push(value);
				break;
			case 'data':
			case 'data-ascii':
				out.data.push(plain(value, true));
				break;
			case 'data-binary':
				out.data.push(plain(value, false));
				break;
			case 'data-raw':
				out.data.push({ name: '', value, file: false, encode: false, oneLine: false });
				break;
			case 'json':
				json = true;
				out.data.push(plain(value, false));
				break;
			case 'data-urlencode': {
				// content, =content, name=content, @file or name@file.
				const eq = value.indexOf('=');
				const at = value.indexOf('@');
				if (eq >= 0)
					out.data.push({
						name: eq > 0 ? value.slice(0, eq + 1) : '',
						value: value.slice(eq + 1),
						file: false,
						encode: true,
						oneLine: false,
					});
				else if (at >= 0)
					out.data.push({
						name: at > 0 ? `${value.slice(0, at)}=` : '',
						value: value.slice(at + 1),
						file: true,
						encode: true,
						oneLine: false,
					});
				else out.data.push({ name: '', value, file: false, encode: true, oneLine: false });
				break;
			}
			default:
				if (!NO_EFFECT.has(name)) throw new CurlUsageError(`unknown option --${name}`);
		}
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		const next = (flag: string): string => {
			const v = argv[++i];
			if (v === undefined) throw new CurlUsageError(`option ${flag} needs a value`);
			return v;
		};
		if (arg.startsWith('--')) {
			const name = arg.slice(2);
			apply(name, VALUED.has(name) ? next(arg) : '');
		} else if (arg.startsWith('-') && arg.length > 1) {
			for (let j = 1; j < arg.length; j++) {
				const name = SHORT[arg[j] as string];
				if (!name) throw new CurlUsageError(`unknown option -${arg[j]}`);
				if (!VALUED.has(name)) {
					apply(name);
					continue;
				}
				apply(name, arg.slice(j + 1) || next(`-${arg[j]}`));
				break;
			}
		} else urls.push(arg);
	}
	if (urls.length > 1)
		throw new CurlUsageError('one URL per command here; run curl once for each');
	out.url = urls[0] ?? '';
	if (!out.url) throw new CurlUsageError('no URL specified');
	let parsed: URL;
	try {
		parsed = new URL(out.url);
	} catch {
		throw new CurlUsageError(`could not resolve host: ${out.url}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
		throw new CurlUsageError(`unsupported protocol: ${parsed.protocol.replace(':', '')}`);
	if (remoteName && !out.output) {
		out.output = decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
		if (!out.output) throw new CurlUsageError('remote file name has no length');
	}
	if (json) {
		if (!hasHeader(out.headers, 'content-type'))
			out.headers['Content-Type'] = 'application/json';
		if (!hasHeader(out.headers, 'accept')) out.headers.Accept = 'application/json';
	}
	if (!out.method) out.method = out.data.length && !out.query ? 'POST' : 'GET';
	if (!out.data.some((d) => d.file))
		place(
			out,
			out.data.map((d) => partOf(d, d.value)),
		);
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

type Io = Pick<CommandContext, 'fs' | 'cwd' | 'stdin'>;

/** The parts of -d that name a file, read through the shell's filesystem; `-` is stdin. */
async function readData(args: CurlArgs, ctx: Io): Promise<void> {
	const parts: string[] = [];
	for (const d of args.data) {
		if (!d.file) parts.push(partOf(d, d.value));
		else if (d.value === '-')
			parts.push(partOf(d, new TextDecoder().decode(toBytes(ctx.stdin, 'binary'))));
		else parts.push(partOf(d, await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, d.value))));
	}
	place(args, parts);
}

/** `-w`: the variables curl knows that a request here can answer, and its escapes. */
function written(format: string, values: Record<string, string>): string {
	return format
		.replace(/%\{(\w+)\}/g, (_m, name: string) => values[name] ?? '')
		.replace(/\\([nrt])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : '\t'));
}

async function fetchIt(args: CurlArgs, deps: CommandDeps, ctx: Io): Promise<ExecResult> {
	const quiet = args.silent && !args.showError;
	if (args.data.some((d) => d.file)) {
		try {
			await readData(args, ctx);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { stdout: '', stderr: quiet ? '' : `curl: (26) ${reason}\n`, exitCode: 26 };
		}
	}
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
		if (!away || !IDEMPOTENT.has(args.method)) return fail(error, args, away, quiet);
		try {
			// Stop ends this wait too, even one that starts after Stop released the others.
			await whenVisible(deps.signal);
			response = await send();
		} catch (retryError) {
			return fail(retryError, args, away, quiet);
		}
	}
	const headerLines = Object.entries(response.headers ?? {}).map(
		([k, v]) => `${k}: ${String(v)}`,
	);
	const head = `HTTP ${response.status}\n${headerLines.join('\n')}\n\n`;
	const failed = args.failOnError && response.status >= 400;
	const body =
		args.method === 'HEAD' || (failed && !args.failWithBody)
			? new Uint8Array()
			: bodyOf(response);
	// Bytes, not text: an image read as text comes out with U+FFFD in place of its bytes.
	const shown = args.include ? joined(toBytes(head), body) : body;
	const resolve = (path: string) => ctx.fs.resolvePath(ctx.cwd, path);
	let stdout = '';
	if (args.dumpHeader === '-') stdout += latin1(toBytes(head));
	else if (args.dumpHeader) await ctx.fs.writeFile(resolve(args.dumpHeader), toBytes(head));
	if (!args.output) stdout += latin1(shown);
	// -f leaves the file alone; /dev/null is nowhere, as in a real shell.
	else if (args.output !== '/dev/null' && (!failed || args.failWithBody))
		await ctx.fs.writeFile(resolve(args.output), shown);
	if (args.writeOut) {
		const type = Object.entries(response.headers ?? {}).find(
			([k]) => k.toLowerCase() === 'content-type',
		);
		stdout += latin1(
			toBytes(
				written(args.writeOut, {
					http_code: String(response.status),
					response_code: String(response.status),
					size_download: String(body.length),
					content_type: type ? String(type[1]) : '',
					url_effective: args.url,
					time_total: ((Date.now() - startedAt) / 1000).toFixed(6),
				}),
			),
		);
	}
	const trace = args.verbose
		? `> ${args.method} ${args.url}\n${Object.entries(args.headers)
				.map(([k, v]) => `> ${k}: ${v}\n`)
				.join('')}>\n< HTTP ${response.status}\n${headerLines
				.map((l) => `< ${l}\n`)
				.join('')}<\n`
		: '';
	if (failed)
		return {
			stdout,
			stdoutKind: 'bytes',
			stderr: `${trace}${quiet ? '' : `curl: (22) The requested URL returned error: ${response.status}\n`}`,
			exitCode: 22,
		};
	return { stdout, stdoutKind: 'bytes', stderr: trace, exitCode: 0 };
}

function joined(a: Uint8Array, b: Uint8Array): Uint8Array {
	const all = new Uint8Array(a.length + b.length);
	all.set(a);
	all.set(b, a.length);
	return all;
}

/** Obsidian's response decodes `text` on read; the raw bytes are in `arrayBuffer`. */
function bodyOf(response: { text?: string; arrayBuffer?: ArrayBuffer }): Uint8Array {
	if (response.arrayBuffer) return new Uint8Array(response.arrayBuffer);
	return toBytes(response.text ?? '');
}

function fail(error: unknown, args: CurlArgs, away: boolean, quiet: boolean): ExecResult {
	const reason = error instanceof Error ? error.message : String(error);
	const timedOut = reason === TIMED_OUT;
	const note = away && !IDEMPOTENT.has(args.method) ? `\ncurl: ${AWAY_UNKNOWN}` : '';
	return {
		stdout: '',
		stderr: quiet ? '' : `curl: (${timedOut ? 28 : 7}) ${reason}${note}\n`,
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
