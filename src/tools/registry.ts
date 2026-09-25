import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { type App, parseFrontMatterAliases, TFile, TFolder } from 'obsidian';
import { type TSchema, Type } from 'typebox';
import type { LibrarianSettings, ToolName } from '../types';
import { withFileMutationQueue } from './mutation-queue';
import { checkPath, isBinaryPath, isHiddenPath } from './path-policy';

/** Opens files the vault index does not list (skill folders). Null means "not one of mine". */
export interface HiddenReader {
	read(path: string): Promise<{ text: string; extra?: Record<string, unknown> } | null>;
}

/** Runs inside the per-file mutation queue, around the change: the rewind snapshot lives here. */
export interface MutationHooks {
	before(toolCallId: string, path: string): Promise<void>;
	after(toolCallId: string, path: string): Promise<void>;
}

export interface ToolDeps {
	app: App;
	settings: () => LibrarianSettings;
	hidden?: HiddenReader;
	mutation?: MutationHooks;
}

/** Keeps the typed parameters inside each tool while the registry hands out the erased shape. */
export function tool<T extends TSchema>(t: AgentTool<T>): AgentTool {
	return t;
}

export function ok(result: unknown): AgentToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result as never };
}

/**
 * Characters one result may take. The controller cuts anything longer, which would chop a JSON
 * result in the middle and drop where to read on, so the tools fit their own results inside it.
 */
export function resultBudget(settings: LibrarianSettings): number {
	return Math.max(1000, settings.toolResultMaxChars - 100);
}

/**
 * The most of `total` items whose result fits `budget`: `build(n)` is the result with the first n,
 * measured as the JSON the model gets. 0 when not even one fits.
 */
export function fitCount(total: number, budget: number, build: (n: number) => unknown): number {
	const fits = (n: number) => JSON.stringify(build(n)).length <= budget;
	if (fits(total)) return total;
	let lo = 0;
	let hi = total;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (fits(mid)) lo = mid;
		else hi = mid;
	}
	return lo;
}

/** The first `n` characters, one less when that would split a surrogate pair. */
export function cutAt(text: string, n: number): string {
	const code = text.charCodeAt(n - 1);
	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/** A long line cut to `max` characters around `at`, with an ellipsis where text was left out. */
function clip(text: string, max: number, at = 0): string {
	if (text.length <= max) return text;
	const start = Math.max(0, Math.min(at - Math.floor(max / 3), text.length - max));
	const end = start + max;
	return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** Single-quoted for the shell. */
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

const GREP_LINE_MAX = 300;
const GREP_CONTEXT_MAX = 160;

export function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error('Operation aborted');
}

/** The edit rule the vault and storage edit tools share: one exact match unless replace_all. */
export function replaceExact(
	data: string,
	oldText: string,
	newText: string,
	replaceAll?: boolean,
): { text: string; replacements: number } | { failure: string } {
	const count = data.split(oldText).length - 1;
	// A file saved with Windows line ends never matches the model's \n; match it in the file's own.
	if (count === 0 && oldText.includes('\n') && !oldText.includes('\r') && data.includes('\r\n')) {
		const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
		return replaceExact(data, crlf(oldText), crlf(newText), replaceAll);
	}
	if (count === 0)
		return { failure: 'old_text was not found in the note. Reread the note and retry.' };
	if (count > 1 && !replaceAll)
		return { failure: `old_text matches ${count} places. Make it unique or set replace_all.` };
	return replaceAll
		? { text: data.split(oldText).join(newText), replacements: count }
		: { text: data.replace(oldText, () => newText), replacements: 1 };
}

const yieldToUi = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

function vaultFile(app: App, path: string): TFile {
	const file = app.vault.getFileByPath(path);
	if (!file) throw new Error(`File not found: ${path}`);
	return file;
}

/** A file the tools can read: indexed ones carry their TFile, hidden ones only a path. */
export interface Entry {
	path: string;
	file: TFile | null;
}

function basenameOf(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

/** Every file under a hidden folder, read from disk because the index does not hold them. */
async function hiddenFilesUnder(app: App, path: string, signal?: AbortSignal): Promise<Entry[]> {
	const stat = await app.vault.adapter.stat(path);
	if (stat?.type === 'file') return [{ path, file: null }];
	if (!stat) throw new Error(`Folder not found: ${path}`);
	const out: Entry[] = [];
	const pending = [path];
	let batch = 0;
	while (pending.length) {
		throwIfAborted(signal);
		if (++batch % 20 === 0) await yieldToUi();
		const listing = await app.vault.adapter.list(pending.pop()!);
		for (const f of listing.files) out.push({ path: f, file: null });
		pending.push(...listing.folders);
	}
	return out;
}

/** Every file of any type under a folder, or the one file a path names. */
export async function filesUnder(
	app: App,
	folderPath: string | undefined,
	signal?: AbortSignal,
): Promise<Entry[]> {
	const indexed = (files: TFile[]) => files.map((file) => ({ path: file.path, file }));
	if (!folderPath) return indexed(app.vault.getFiles());
	if (isHiddenPath(folderPath, app.vault.configDir))
		return hiddenFilesUnder(app, folderPath, signal);
	const abstract = app.vault.getAbstractFileByPath(folderPath);
	if (abstract instanceof TFile) return indexed([abstract]);
	if (!(abstract instanceof TFolder)) throw new Error(`Folder not found: ${folderPath}`);
	const prefix = `${abstract.path}/`;
	return indexed(app.vault.getFiles().filter((f) => f.path.startsWith(prefix)));
}

async function readEntry(app: App, entry: Entry): Promise<string> {
	return entry.file ? app.vault.cachedRead(entry.file) : app.vault.adapter.read(entry.path);
}

export function rejectHiddenWrite(app: App, path: string): void {
	if (isHiddenPath(path, app.vault.configDir))
		throw new Error(`Hidden paths are read-only: ${path}`);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function ensureFolder(app: App, path: string): Promise<void> {
	const parts = path.split('/').filter(Boolean);
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
	}
}

export function createLsTool(deps: ToolDeps): AgentTool {
	return tool({
		name: 'ls',
		label: 'List folder',
		description:
			'List files and folders in the Obsidian vault, including hidden folders such as the config folder. Use this to inspect vault structure or a folder.',
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description: 'Vault-relative folder path. Empty string means vault root.',
				}),
			),
			offset: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: 'Entries to skip. Default 0. Pass nextOffset to list more.',
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 200,
					description: `Maximum entries. Default ${deps.settings().listLimit}.`,
				}),
			),
		}),
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const path = checkPath(params.path ?? '', {
				allowRoot: true,
				configDir: deps.app.vault.configDir,
			});
			// The adapter, not the index: the index leaves out dot folders and the config folder.
			const stat = path === '' ? null : await deps.app.vault.adapter.stat(path);
			if (path !== '' && stat?.type !== 'folder')
				throw new Error(`Folder not found: ${params.path}`);
			const listing = await deps.app.vault.adapter.list(path);
			const entries = [
				...listing.folders.map((p) => ({ type: 'folder' as const, path: p })),
				...listing.files.map((p) => ({ type: 'file' as const, path: p })),
			].sort((a, b) => a.path.localeCompare(b.path));
			return ok(
				pageOf(
					entries,
					params.offset ?? 0,
					params.limit ?? deps.settings().listLimit,
					resultBudget(deps.settings()),
					{ path },
				),
			);
		},
	});
}

/**
 * The ls result shape, shared with the storage listing: `head`, then as many entries from
 * `offset` as fit in `budget`, and `nextOffset` while more are left.
 */
export function pageOf<T>(
	items: T[],
	offset: number,
	limit: number,
	budget = Number.POSITIVE_INFINITY,
	head: Record<string, unknown> = {},
) {
	const window = items.slice(offset, offset + limit);
	const page = (n: number) => {
		const entries = window.slice(0, n);
		const next = offset + entries.length;
		return {
			...head,
			entries,
			offset,
			...(next < items.length ? { nextOffset: next } : {}),
			total: items.length,
		};
	};
	return page(Math.max(1, fitCount(window.length, budget, page)));
}

/**
 * The read result shape, shared with the storage read. `offset` is 1-based. As many lines as fit
 * in `budget` come back, with `nextOffset` to read on; a first line longer than that alone comes
 * back cut, and `longLine` says how to get the rest of it.
 */
export function lineWindow(
	text: string,
	offset: number,
	limit: number,
	budget = Number.POSITIVE_INFINITY,
	head: Record<string, unknown> = {},
	longLine: (line: number, length: number, shown: number) => string = (line, length, shown) =>
		`Line ${line} has ${length} characters; only the first ${shown} are shown.`,
) {
	const all = text.split('\n');
	if (offset > all.length)
		throw new Error(
			`offset ${offset} is past the end of the file, which has ${all.length} lines`,
		);
	const window = all.slice(offset - 1, offset - 1 + limit);
	const page = (lines: { line: number; text: string }[], note?: string) => {
		const next = offset + lines.length;
		return {
			...head,
			offset,
			lines,
			totalLines: all.length,
			...(next <= all.length ? { nextOffset: next } : {}),
			...(note ? { note } : {}),
		};
	};
	const numbered = (n: number) =>
		window.slice(0, n).map((t, i) => ({ line: offset + i, text: t }));
	// Cut by the size of a result rather than by limit: said, so the model reads on.
	const sized = (n: number) =>
		page(
			numbered(n),
			n < window.length
				? `Stopped at the size limit of one result. Continue with offset ${offset + n}.`
				: undefined,
		);
	const n = fitCount(window.length, budget, sized);
	if (n > 0) return sized(n);
	const first = window[0] ?? '';
	// Room for the note, which names the line and may carry a path.
	const shown = fitCount(first.length, budget - 400, (c) =>
		page([{ line: offset, text: first.slice(0, c) }]),
	);
	const cut = cutAt(first, shown);
	return page([{ line: offset, text: cut }], longLine(offset, first.length, cut.length));
}

export function createFindTool(deps: ToolDeps): AgentTool {
	return tool({
		name: 'find',
		label: 'Find note',
		description:
			'Find files by filename, path, title, or alias. Use this when the user names or approximately names a note or file. Every word of the query must appear, in any order and any case.',
		parameters: Type.Object({
			query: Type.String({ minLength: 1 }),
			path: Type.Optional(Type.String({ description: 'Optional folder restriction.' })),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 100, description: 'Default 20.' }),
			),
		}),
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const folder = params.path
				? checkPath(params.path, { allowRoot: true, configDir: deps.app.vault.configDir })
				: undefined;
			const q = params.query.trim().toLowerCase();
			// "librarian plugin" finds "Obsidian Librarian 플러그인 개발/Librarian plugin notes.md".
			const words = q.split(/\s+/).filter(Boolean);
			const hasAll = (s: string) => words.every((w) => s.includes(w));
			const limit = params.limit ?? 20;
			const scored: { score: number; path: string; title?: string; aliases?: string[] }[] =
				[];
			for (const { path, file } of await filesUnder(deps.app, folder || undefined, signal)) {
				const fm = file
					? deps.app.metadataCache.getFileCache(file)?.frontmatter
					: undefined;
				const title = typeof fm?.title === 'string' ? fm.title : undefined;
				const aliases = parseFrontMatterAliases(fm) ?? undefined;
				const base = basenameOf(path).toLowerCase();
				let score = 0;
				if (base === q) score = 5;
				else if (base.includes(q)) score = 4;
				else if (hasAll(base)) score = 3;
				else if ([title, ...(aliases ?? [])].some((t) => t && hasAll(t.toLowerCase())))
					score = 2;
				else if (hasAll(path.toLowerCase())) score = 1;
				if (score > 0) scored.push({ score, path, title, aliases });
			}
			scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
			const found = scored.slice(0, limit).map(({ path, title, aliases }) => ({
				path,
				...(title ? { title } : {}),
				...(aliases?.length ? { aliases } : {}),
			}));
			const result = (n: number) => ({
				query: params.query,
				matches: found.slice(0, n),
				truncated: scored.length > n,
			});
			return ok(result(fitCount(found.length, resultBudget(deps.settings()), result)));
		},
	});
}

export function createGrepTool(deps: ToolDeps): AgentTool {
	return tool({
		name: 'grep',
		label: 'Search contents',
		description:
			'Search text file contents in the vault and return matching lines with paths and line numbers. Use this when the relevant note is not already known. The query matches within one line; regex mode uses JavaScript syntax. Long lines come back cut around the match; read the note to see them whole.',
		parameters: Type.Object({
			query: Type.String({ minLength: 1 }),
			path: Type.Optional(
				Type.String({ description: 'Optional folder or file restriction.' }),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal('literal'), Type.Literal('regex')], {
					description: 'Default literal.',
				}),
			),
			case_sensitive: Type.Optional(Type.Boolean({ description: 'Default false.' })),
			context_lines: Type.Optional(
				Type.Integer({ minimum: 0, maximum: 5, description: 'Default 2.' }),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 100,
					description: `Default ${deps.settings().grepLimit}.`,
				}),
			),
		}),
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const scope = params.path
				? checkPath(params.path, { allowRoot: true, configDir: deps.app.vault.configDir })
				: undefined;
			const flags = params.case_sensitive ? '' : 'i';
			const source = params.mode === 'regex' ? params.query : escapeRegExp(params.query);
			let re: RegExp;
			try {
				re = new RegExp(source, flags);
			} catch (e) {
				throw new Error(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
			}
			const ctx = params.context_lines ?? 2;
			const limit = params.limit ?? deps.settings().grepLimit;
			const matches: {
				path: string;
				line: number;
				text: string;
				before?: string[];
				after?: string[];
			}[] = [];
			let truncated = false;
			const files = (await filesUnder(deps.app, scope || undefined, signal)).filter(
				(f) => !isBinaryPath(f.path),
			);
			let batch = 0;
			// A paragraph is one line in Markdown; a whole one per match would crowd out the rest.
			const around = (lines: string[]) => lines.map((l) => clip(l, GREP_CONTEXT_MAX));
			// ponytail: full scan with a yield every 20 files; add an index if real vaults measure slow.
			for (const file of files) {
				throwIfAborted(signal);
				if (++batch % 20 === 0) await yieldToUi();
				const lines = (await readEntry(deps.app, file)).split('\n');
				for (let i = 0; i < lines.length; i++) {
					const hit = re.exec(lines[i]!);
					if (!hit) continue;
					if (matches.length >= limit) {
						truncated = true;
						break;
					}
					matches.push({
						path: file.path,
						line: i + 1,
						text: clip(lines[i]!, GREP_LINE_MAX, hit.index),
						...(ctx > 0
							? { before: around(lines.slice(Math.max(0, i - ctx), i)) }
							: {}),
						...(ctx > 0 ? { after: around(lines.slice(i + 1, i + 1 + ctx)) } : {}),
					});
				}
				if (truncated) break;
			}
			const result = (n: number) => ({
				query: params.query,
				matches: matches.slice(0, n),
				truncated: truncated || n < matches.length,
			});
			return ok(result(fitCount(matches.length, resultBudget(deps.settings()), result)));
		},
	});
}

export function createReadTool(deps: ToolDeps): AgentTool {
	return tool({
		name: 'read',
		label: 'Read note',
		description:
			'Read a range of lines from a text file. Use this after find or grep to inspect the actual source text. One result holds as many lines as fit in it; when it has nextOffset, call again with that offset to read on.',
		parameters: Type.Object({
			path: Type.String({ description: 'Vault-relative file path.' }),
			offset: Type.Optional(
				Type.Integer({ minimum: 1, description: '1-based first line. Default 1.' }),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 500,
					description: `Maximum lines. Default ${deps.settings().readLineLimit}.`,
				}),
			),
		}),
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const path = checkPath(params.path, { configDir: deps.app.vault.configDir });
			if (isBinaryPath(path)) throw new Error(`Not a text file: ${path}`);
			const file = deps.app.vault.getFileByPath(path);
			let text: string;
			let extra: Record<string, unknown> = {};
			if (file) text = await deps.app.vault.cachedRead(file);
			else {
				// Off the index: a skill file (with its resources) or any other hidden file on disk.
				const hidden = await deps.hidden?.read(path);
				if (hidden) {
					text = hidden.text;
					extra = hidden.extra ?? {};
				} else if ((await deps.app.vault.adapter.stat(path))?.type === 'file') {
					text = await deps.app.vault.adapter.read(path);
				} else throw new Error(`File not found: ${path}`);
			}
			return ok(
				lineWindow(
					text,
					params.offset ?? 1,
					params.limit ?? deps.settings().readLineLimit,
					resultBudget(deps.settings()),
					{ path, ...extra },
					(line, length, shown) =>
						`Line ${line} has ${length} characters; the first ${shown} are shown. Read the rest with bash: sed -n '${line}p' ${shellQuote(path)} | cut -c ${shown + 1}-${shown * 2}`,
				),
			);
		},
	});
}

export function createActiveNoteTool(deps: ToolDeps): AgentTool {
	return tool({
		name: 'get_active_note',
		label: 'Active note',
		description:
			'Return the file currently active in Obsidian. Use when the user refers to this note or the current document.',
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			throwIfAborted(signal);
			const file = deps.app.workspace.getActiveFile();
			if (!file) return ok({ path: null, reason: 'No file is open.' });
			return ok({ path: file.path });
		},
	});
}

export function createWriteTool(deps: ToolDeps): AgentTool {
	return tool({
		name: 'write',
		label: 'Write note',
		description:
			'Create a file or replace the full contents of an existing file. Missing parent folders are created. Give the path with its extension, such as .md for a note. Prefer edit for localized changes.',
		parameters: Type.Object({
			path: Type.String({ description: 'Vault-relative file path.' }),
			content: Type.String({ description: 'Complete file content.' }),
			overwrite: Type.Optional(
				Type.Boolean({
					description: 'Allow full replacement of an existing file. Default false.',
				}),
			),
		}),
		executionMode: 'sequential',
		async execute(id, params, signal) {
			throwIfAborted(signal);
			const path = checkPath(params.path, { configDir: deps.app.vault.configDir });
			rejectHiddenWrite(deps.app, path);
			return withFileMutationQueue(path, async () => {
				throwIfAborted(signal);
				await deps.mutation?.before(id, path);
				const existing = deps.app.vault.getAbstractFileByPath(path);
				if (existing instanceof TFolder) throw new Error(`A folder exists at ${path}`);
				let operation: 'created' | 'overwritten';
				if (existing instanceof TFile) {
					if (!params.overwrite)
						throw new Error(
							`File already exists: ${path}. Set overwrite to true to replace it.`,
						);
					await deps.app.vault.modify(existing, params.content);
					operation = 'overwritten';
				} else {
					const slash = path.lastIndexOf('/');
					if (slash > 0) await ensureFolder(deps.app, path.slice(0, slash));
					await deps.app.vault.create(path, params.content);
					operation = 'created';
				}
				await deps.mutation?.after(id, path);
				return ok({ path, operation, characters: params.content.length });
			});
		},
	});
}

export function createEditTool(deps: ToolDeps): AgentTool {
	return tool({
		name: 'edit',
		label: 'Edit note',
		description:
			'Modify part of an existing text file by replacing exact text. old_text must match the file exactly, whitespace included, and occur once unless replace_all is set. Read the file first unless its current content is already available.',
		parameters: Type.Object({
			path: Type.String({ description: 'Vault-relative file path.' }),
			old_text: Type.String({ minLength: 1, description: 'Exact existing text.' }),
			new_text: Type.String({ description: 'Replacement text.' }),
			replace_all: Type.Optional(
				Type.Boolean({ description: 'Replace all exact occurrences. Default false.' }),
			),
		}),
		executionMode: 'sequential',
		async execute(id, params, signal) {
			throwIfAborted(signal);
			const path = checkPath(params.path, { configDir: deps.app.vault.configDir });
			if (isBinaryPath(path)) throw new Error(`Not a text file: ${path}`);
			rejectHiddenWrite(deps.app, path);
			return withFileMutationQueue(path, async () => {
				throwIfAborted(signal);
				const file = vaultFile(deps.app, path);
				await deps.mutation?.before(id, path);
				let replacements = 0;
				let failure: string | null = null;
				// The match is re-checked inside process() so a note edited after it was read is left alone.
				await deps.app.vault.process(file, (data) => {
					const edit = replaceExact(
						data,
						params.old_text,
						params.new_text,
						params.replace_all,
					);
					if ('failure' in edit) {
						failure = edit.failure;
						return data;
					}
					replacements = edit.replacements;
					return edit.text;
				});
				if (failure) throw new Error(failure);
				await deps.mutation?.after(id, path);
				return ok({ path, replacements, changed: true });
			});
		},
	});
}

/** The seven tools in the fixed order they are declared to the model. */
export function createVaultTools(deps: ToolDeps): AgentTool[] {
	return [
		createLsTool(deps),
		createFindTool(deps),
		createGrepTool(deps),
		createReadTool(deps),
		createActiveNoteTool(deps),
		createWriteTool(deps),
		createEditTool(deps),
	];
}

export const READ_ONLY_TOOLS: readonly ToolName[] = [
	'ls',
	'find',
	'grep',
	'read',
	'get_active_note',
];
export const WRITE_TOOLS: readonly ToolName[] = ['write', 'edit'];
