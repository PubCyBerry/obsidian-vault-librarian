import type { Command, CommandContext, ExecResult } from 'just-bash/browser';
import { defineCommand } from 'just-bash/browser';
import type { App } from 'obsidian';
import { Platform } from 'obsidian';
import { pdfText } from '../tools/media';

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

// pdftotext

/**
 * pdftotext by Obsidian's own PDF.js (LIB-FEAT-303): `pdftotext FILE.pdf -` writes the text to
 * stdout, a name in place of `-` to that file, and neither to FILE.txt, as the real one does.
 */
export function createPdfToText(): Command {
	return defineCommand('pdftotext', async (argv, ctx): Promise<ExecResult> => {
		let first = 1;
		let last = Number.POSITIVE_INFINITY;
		const operands: string[] = [];
		for (let i = 0; i < argv.length; i++) {
			const arg = argv[i] as string;
			if (arg === '-f') first = Number(argv[++i]);
			else if (arg === '-l') last = Number(argv[++i]);
			// An encoding or a line ending to skip; the text comes out one way here.
			else if (arg === '-enc' || arg === '-eol') i++;
			// -layout, -raw, -nopgbrk, -q: likewise.
			else if (arg === '-' || !arg.startsWith('-')) operands.push(arg);
		}
		const [input, output] = operands;
		if (!input || !(first >= 1) || !(last >= first))
			return {
				stdout: '',
				stderr: 'Usage: pdftotext [-f first] [-l last] FILE.pdf [text file | -]\n',
				exitCode: 99,
			};
		const at = (path: string) => ctx.fs.resolvePath(ctx.cwd, path);
		try {
			const { text } = await pdfText(await ctx.fs.readFileBuffer(at(input)), first, last);
			if (output === '-') return { stdout: `${text}\n`, stderr: '', exitCode: 0 };
			await ctx.fs.writeFile(
				at(output ?? `${input.replace(/\.pdf$/i, '')}.txt`),
				`${text}\n`,
			);
			return { stdout: '', stderr: '', exitCode: 0 };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { stdout: '', stderr: `pdftotext: ${message}\n`, exitCode: 1 };
		}
	});
}
