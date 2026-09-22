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
function tool<T extends TSchema>(t: AgentTool<T>): AgentTool {
	return t;
}

function ok(result: unknown): AgentToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result as never };
}

function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error('Operation aborted');
}

const yieldToUi = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

function vaultFile(app: App, path: string): TFile {
	const file = app.vault.getFileByPath(path);
	if (!file) throw new Error(`File not found: ${path}`);
	return file;
}

/** A file the tools can read: indexed ones carry their TFile, hidden ones only a path. */
interface Entry {
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
async function filesUnder(
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

function rejectHiddenWrite(app: App, path: string): void {
	if (isHiddenPath(path, app.vault.configDir))
		throw new Error(`Hidden paths are read-only: ${path}`);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function ensureFolder(app: App, path: string): Promise<void> {
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
				Type.Integer({ minimum: 0, description: 'Entries to skip. Default 0.' }),
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
			const offset = params.offset ?? 0;
			const limit = params.limit ?? deps.settings().listLimit;
			const page = entries.slice(offset, offset + limit);
			const next = offset + page.length;
			return ok({
				path,
				entries: page,
				offset,
				...(next < entries.length ? { nextOffset: next } : {}),
				total: entries.length,
			});
		},
	});
}

export function createFindTool(deps: ToolDeps): AgentTool {
	return tool({
		name: 'find',
		label: 'Find note',
		description:
			'Find files by filename, path, title, or alias. Use this when the user names or approximately names a note or file.',
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
			const q = params.query.toLowerCase();
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
				if (base === q) score = 4;
				else if (base.includes(q)) score = 3;
				else if (title?.toLowerCase().includes(q)) score = 2;
				else if (aliases?.some((a) => a.toLowerCase().includes(q))) score = 2;
				else if (path.toLowerCase().includes(q)) score = 1;
				if (score > 0) scored.push({ score, path, title, aliases });
			}
			scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
			const matches = scored.slice(0, limit).map(({ path, title, aliases }) => ({
				path,
				...(title ? { title } : {}),
				...(aliases?.length ? { aliases } : {}),
			}));
			return ok({ query: params.query, matches, truncated: scored.length > limit });
		},
	});
}

export function createGrepTool(deps: ToolDeps): AgentTool {
	return tool({
		name: 'grep',
		label: 'Search contents',
		description:
			'Search text file contents in the vault and return matching lines with paths and line numbers. Use this when the relevant note is not already known.',
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
			// ponytail: full scan with a yield every 20 files; add an index if real vaults measure slow.
			for (const file of files) {
				throwIfAborted(signal);
				if (++batch % 20 === 0) await yieldToUi();
				const lines = (await readEntry(deps.app, file)).split('\n');
				for (let i = 0; i < lines.length; i++) {
					if (!re.test(lines[i]!)) continue;
					if (matches.length >= limit) {
						truncated = true;
						break;
					}
					matches.push({
						path: file.path,
						line: i + 1,
						text: lines[i]!,
						...(ctx > 0 ? { before: lines.slice(Math.max(0, i - ctx), i) } : {}),
						...(ctx > 0 ? { after: lines.slice(i + 1, i + 1 + ctx) } : {}),
					});
				}
				if (truncated) break;
			}
			return ok({ query: params.query, matches, truncated });
		},
	});
}

export function createReadTool(deps: ToolDeps): AgentTool {
	return tool({
		name: 'read',
		label: 'Read note',
		description:
			'Read a range of lines from a text file. Use this after find or grep to inspect the actual source text.',
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
			const all = text.split('\n');
			const offset = params.offset ?? 1;
			const limit = params.limit ?? deps.settings().readLineLimit;
			const lines = all
				.slice(offset - 1, offset - 1 + limit)
				.map((text, i) => ({ line: offset + i, text }));
			const next = offset + lines.length;
			return ok({
				path,
				offset,
				lines,
				totalLines: all.length,
				...(next <= all.length ? { nextOffset: next } : {}),
				...extra,
			});
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
			'Create a file or replace the full contents of an existing file. Prefer edit for localized changes.',
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
			'Modify part of an existing text file by replacing exact text. Read the file first unless its current content is already available.',
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
					const count = data.split(params.old_text).length - 1;
					if (count === 0) {
						failure = 'old_text was not found in the note. Reread the note and retry.';
						return data;
					}
					if (count > 1 && !params.replace_all) {
						failure = `old_text matches ${count} places. Make it unique or set replace_all.`;
						return data;
					}
					replacements = params.replace_all ? count : 1;
					return params.replace_all
						? data.split(params.old_text).join(params.new_text)
						: data.replace(params.old_text, () => params.new_text);
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
