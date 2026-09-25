import type { AgentTool } from '@earendil-works/pi-agent-core';
import { type App, TFile, TFolder } from 'obsidian';
import { Type } from 'typebox';
import type { ToolGroup } from '../permissions/tool-permission-manager';
import { withFileMutationQueue } from '../tools/mutation-queue';
import { checkPath, isBinaryPath, isHiddenPath } from '../tools/path-policy';
import {
	type Entry,
	ensureFolder,
	filesUnder,
	lineWindow,
	type MutationHooks,
	ok,
	pageOf,
	rejectHiddenWrite,
	replaceExact,
	resultBudget,
	throwIfAborted,
	tool,
} from '../tools/registry';
import type { LibrarianSettings } from '../types';
import { joinPath, parentOf, storagePath, type WebDavClient } from './webdav-client';

export interface WebDavToolDeps {
	app: App;
	settings: () => LibrarianSettings;
	/**
	 * Built from the current settings and this device's password; throws when it is not set up.
	 * Given the call's signal, so Stop ends the call even while a request or the app is stuck.
	 */
	client: (signal?: AbortSignal) => WebDavClient;
	mutation?: MutationHooks;
}

export const WEBDAV_TOOL_NAMES = [
	'webdav_ls',
	'webdav_read',
	'webdav_write',
	'webdav_edit',
	'webdav_mkdir',
	'webdav_move',
	'webdav_delete',
	'webdav_download',
	'webdav_upload',
] as const;

export const WEBDAV_GROUP: ToolGroup = {
	id: 'webdav',
	label: 'WebDAV storage',
	tools: WEBDAV_TOOL_NAMES,
};

const STORAGE_PATH = 'Path inside the storage, relative to its root. Empty string means the root.';

function nameOf(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

function nonRoot(path: string, what: string): string {
	if (!path) throw new Error(`path must name a ${what}, not the storage root`);
	return path;
}

/** Every file below a storage folder, one Depth 1 listing per folder (servers often refuse infinity). */
async function storageFilesUnder(
	client: WebDavClient,
	path: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const files: string[] = [];
	const pending = [path];
	while (pending.length) {
		throwIfAborted(signal);
		for (const entry of await client.list(pending.pop()!)) {
			if (entry.type === 'folder') pending.push(entry.path);
			else files.push(entry.path);
		}
	}
	return files.sort();
}

function lsTool(deps: WebDavToolDeps): AgentTool {
	return tool({
		name: 'webdav_ls',
		label: 'List storage folder',
		description:
			"List files and folders in a folder of the connected WebDAV storage, such as the user's NAS. Entries carry size and last modified time.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: STORAGE_PATH })),
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
			const path = storagePath(params.path ?? '');
			const entries = await deps.client(signal).list(path);
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

function readTool(deps: WebDavToolDeps): AgentTool {
	return tool({
		name: 'webdav_read',
		label: 'Read storage file',
		description: 'Read a range of lines from a text file on the WebDAV storage.',
		parameters: Type.Object({
			path: Type.String({ description: STORAGE_PATH }),
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
			const path = nonRoot(storagePath(params.path), 'file');
			if (isBinaryPath(path)) throw new Error(`Not a text file: ${path}`);
			const { data } = await deps.client(signal).get(path);
			return ok(
				lineWindow(
					new TextDecoder().decode(data),
					params.offset ?? 1,
					params.limit ?? deps.settings().readLineLimit,
					resultBudget(deps.settings()),
					{ path },
					(line, length, shown) =>
						`Line ${line} has ${length} characters; the first ${shown} are shown. To read the rest, copy the file into the vault with webdav_download and read that line with bash.`,
				),
			);
		},
	});
}

function writeTool(deps: WebDavToolDeps): AgentTool {
	return tool({
		name: 'webdav_write',
		label: 'Write storage file',
		description:
			'Create a file on the WebDAV storage or replace its full contents. Missing parent folders are created. Prefer webdav_edit for localized changes.',
		parameters: Type.Object({
			path: Type.String({ description: STORAGE_PATH }),
			content: Type.String({ description: 'Complete file content.' }),
			overwrite: Type.Optional(
				Type.Boolean({
					description: 'Allow full replacement of an existing file. Default false.',
				}),
			),
		}),
		executionMode: 'sequential',
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const path = nonRoot(storagePath(params.path), 'file');
			const client = deps.client(signal);
			const existing = await client.stat(path);
			if (existing?.type === 'folder') throw new Error(`A folder exists at ${path}`);
			if (existing && !params.overwrite)
				throw new Error(
					`File already exists: ${path}. Set overwrite to true to replace it.`,
				);
			if (!existing) await client.mkdir(parentOf(path));
			throwIfAborted(signal);
			await client.put(path, params.content);
			return ok({
				path,
				operation: existing ? 'overwritten' : 'created',
				characters: params.content.length,
			});
		},
	});
}

function editTool(deps: WebDavToolDeps): AgentTool {
	return tool({
		name: 'webdav_edit',
		label: 'Edit storage file',
		description:
			'Modify part of a text file on the WebDAV storage by replacing exact text. Read the file first unless its current content is already available.',
		parameters: Type.Object({
			path: Type.String({ description: STORAGE_PATH }),
			old_text: Type.String({ minLength: 1, description: 'Exact existing text.' }),
			new_text: Type.String({ description: 'Replacement text.' }),
			replace_all: Type.Optional(
				Type.Boolean({ description: 'Replace all exact occurrences. Default false.' }),
			),
		}),
		executionMode: 'sequential',
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const path = nonRoot(storagePath(params.path), 'file');
			if (isBinaryPath(path)) throw new Error(`Not a text file: ${path}`);
			const client = deps.client(signal);
			const { data, etag } = await client.get(path);
			let text: string;
			try {
				// Fatal and BOM-keeping, so writing back changes nothing but the replaced text.
				text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
			} catch {
				throw new Error(`Not a UTF-8 text file: ${path}`);
			}
			const edit = replaceExact(text, params.old_text, params.new_text, params.replace_all);
			if ('failure' in edit) throw new Error(edit.failure);
			throwIfAborted(signal);
			await client.put(path, edit.text, etag);
			return ok({ path, replacements: edit.replacements, changed: true });
		},
	});
}

function mkdirTool(deps: WebDavToolDeps): AgentTool {
	return tool({
		name: 'webdav_mkdir',
		label: 'Create storage folder',
		description: 'Create a folder on the WebDAV storage, with any missing parent folders.',
		parameters: Type.Object({ path: Type.String({ description: STORAGE_PATH }) }),
		executionMode: 'sequential',
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const path = nonRoot(storagePath(params.path), 'folder');
			return ok({ path, created: await deps.client(signal).mkdir(path) });
		},
	});
}

function moveTool(deps: WebDavToolDeps): AgentTool {
	return tool({
		name: 'webdav_move',
		label: 'Move storage item',
		description:
			'Move or rename a file or folder on the WebDAV storage. Missing parent folders of the target are created. Fails when the target already exists.',
		parameters: Type.Object({
			from: Type.String({ description: `Item to move. ${STORAGE_PATH}` }),
			to: Type.String({ description: `New path of the item. ${STORAGE_PATH}` }),
		}),
		executionMode: 'sequential',
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const from = nonRoot(storagePath(params.from), 'file or folder');
			const to = nonRoot(storagePath(params.to), 'file or folder');
			if (to === from || to.startsWith(`${from}/`))
				throw new Error(`Cannot move ${from} onto itself or into itself`);
			const client = deps.client(signal);
			const source = await client.stat(from);
			if (!source) throw new Error(`Not found: ${from}`);
			await client.mkdir(parentOf(to));
			throwIfAborted(signal);
			await client.move(from, to, source.type === 'folder');
			return ok({ from, to });
		},
	});
}

function deleteTool(deps: WebDavToolDeps): AgentTool {
	return tool({
		name: 'webdav_delete',
		label: 'Delete storage item',
		description:
			'Delete a file, or a folder with everything inside it, from the WebDAV storage. Rewinding the chat does not bring it back.',
		parameters: Type.Object({ path: Type.String({ description: STORAGE_PATH }) }),
		executionMode: 'sequential',
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const path = storagePath(params.path);
			if (!path) throw new Error('The storage root cannot be deleted.');
			const client = deps.client(signal);
			const target = await client.stat(path);
			if (!target) throw new Error(`Not found: ${path}`);
			await client.remove(path, target.type === 'folder');
			return ok({ path, deleted: true });
		},
	});
}

function downloadTool(deps: WebDavToolDeps): AgentTool {
	return tool({
		name: 'webdav_download',
		label: 'Download to vault',
		description:
			'Copy a file or folder from the WebDAV storage into the vault, byte for byte, without reading it into the conversation. Existing vault files are skipped, never overwritten. A file copied onto an existing vault folder goes inside it.',
		parameters: Type.Object({
			path: Type.String({ description: `File or folder to copy. ${STORAGE_PATH}` }),
			vault_path: Type.String({
				description:
					'Vault-relative path of the copy: a file path for a file, a folder path for a folder.',
			}),
		}),
		executionMode: 'sequential',
		async execute(id, params, signal) {
			throwIfAborted(signal);
			const { app } = deps;
			const path = storagePath(params.path);
			const vaultPath = checkPath(params.vault_path, {
				allowRoot: true,
				configDir: app.vault.configDir,
			});
			rejectHiddenWrite(app, vaultPath);
			const client = deps.client(signal);
			const source = await client.stat(path);
			if (!source) throw new Error(`Not found: ${path || '/'}`);
			const pairs: { from: string; to: string }[] = [];
			if (source.type === 'file') {
				const intoFolder =
					vaultPath === '' ||
					app.vault.getAbstractFileByPath(vaultPath) instanceof TFolder;
				pairs.push({
					from: path,
					to: intoFolder ? joinPath(vaultPath, nameOf(path)) : vaultPath,
				});
			} else {
				for (const from of await storageFilesUnder(client, path, signal))
					pairs.push({
						from,
						to: joinPath(vaultPath, path ? from.slice(path.length + 1) : from),
					});
			}
			const files: string[] = [];
			const skipped: { path: string; reason: string }[] = [];
			for (const { from, to } of pairs) {
				throwIfAborted(signal);
				// Only new files: a rewind snapshot holds text, so an overwritten binary could not come back.
				if (isHiddenPath(to, app.vault.configDir)) {
					skipped.push({ path: to, reason: 'Hidden paths are read-only' });
					continue;
				}
				const created = await withFileMutationQueue(to, async () => {
					if (app.vault.getAbstractFileByPath(to)) return false;
					// ponytail: whole file in memory (requestUrl cannot stream); chunk if phones choke on big files.
					const { data } = await client.get(from);
					throwIfAborted(signal);
					await deps.mutation?.before(id, to);
					await ensureFolder(app, parentOf(to));
					await app.vault.createBinary(to, data);
					await deps.mutation?.after(id, to);
					return true;
				});
				if (created) files.push(to);
				else skipped.push({ path: to, reason: 'File already exists in the vault' });
			}
			return ok({ path, vault_path: vaultPath, files, skipped });
		},
	});
}

function uploadTool(deps: WebDavToolDeps): AgentTool {
	return tool({
		name: 'webdav_upload',
		label: 'Upload to storage',
		description:
			'Copy a vault file or folder to the WebDAV storage, byte for byte, without reading it into the conversation. Existing storage files are skipped unless overwrite is true. A file copied onto an existing storage folder goes inside it.',
		parameters: Type.Object({
			vault_path: Type.String({
				description: 'Vault-relative path of the file or folder to copy.',
			}),
			path: Type.String({
				description: `Path of the copy: a file path for a file, a folder path for a folder. ${STORAGE_PATH}`,
			}),
			overwrite: Type.Optional(
				Type.Boolean({
					description: 'Replace files that already exist on the storage. Default false.',
				}),
			),
		}),
		executionMode: 'sequential',
		async execute(_id, params, signal) {
			throwIfAborted(signal);
			const { app } = deps;
			const vaultPath = checkPath(params.vault_path, {
				allowRoot: true,
				configDir: app.vault.configDir,
			});
			const path = storagePath(params.path);
			const client = deps.client(signal);
			const indexed = vaultPath
				? app.vault.getAbstractFileByPath(vaultPath)
				: app.vault.getRoot();
			// Hidden files are off the index, so the adapter says what they are.
			const kind =
				indexed instanceof TFile
					? 'file'
					: indexed instanceof TFolder
						? 'folder'
						: (await app.vault.adapter.stat(vaultPath))?.type;
			if (!kind) throw new Error(`File not found: ${vaultPath}`);
			const pairs: { entry: Entry; to: string }[] = [];
			const folders = new Set<string>();
			if (kind === 'file') {
				const intoFolder = path === '' || (await client.stat(path))?.type === 'folder';
				pairs.push({
					entry: { path: vaultPath, file: indexed instanceof TFile ? indexed : null },
					to: intoFolder ? joinPath(path, nameOf(vaultPath)) : path,
				});
			} else {
				// The folder itself, so an empty one still arrives.
				await client.mkdir(path);
				folders.add(path);
				for (const entry of await filesUnder(app, vaultPath || undefined, signal))
					pairs.push({
						entry,
						to: joinPath(
							path,
							vaultPath ? entry.path.slice(vaultPath.length + 1) : entry.path,
						),
					});
			}
			const files: string[] = [];
			const skipped: { path: string; reason: string }[] = [];
			for (const { entry, to } of pairs) {
				throwIfAborted(signal);
				if (!params.overwrite) {
					const existing = await client.stat(to);
					if (existing) {
						skipped.push({
							path: to,
							reason:
								existing.type === 'folder'
									? `A folder exists at ${to}`
									: 'File already exists on the storage',
						});
						continue;
					}
				}
				const parent = parentOf(to);
				if (!folders.has(parent)) {
					await client.mkdir(parent);
					folders.add(parent);
				}
				const data = entry.file
					? await app.vault.readBinary(entry.file)
					: await app.vault.adapter.readBinary(entry.path);
				await client.put(to, data);
				files.push(to);
			}
			return ok({ vault_path: vaultPath, path, files, skipped });
		},
	});
}

/** The nine storage tools in the order they are declared to the model. */
export function createWebDavTools(deps: WebDavToolDeps): AgentTool[] {
	return [
		lsTool(deps),
		readTool(deps),
		writeTool(deps),
		editTool(deps),
		mkdirTool(deps),
		moveTool(deps),
		deleteTool(deps),
		downloadTool(deps),
		uploadTool(deps),
	];
}
