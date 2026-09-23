/**
 * AGENTS.md files below the vault root, and on the WebDAV storage, picked up as the agent reaches
 * the folders that hold them. Codex reads every AGENTS.md from the project root down to the
 * working folder; an agent in a vault has no working folder, so the path a tool call touches
 * plays that part, and a folder's file is delivered the first time any tool reaches it.
 */

/** Codex's default budget for project instructions (`project_doc_max_bytes`), per delivery. */
export const NESTED_AGENTS_MD_BUDGET = 32 * 1024;

const TAG = 'agents_md';

/** Tools whose `path` names a folder rather than a file. */
const FOLDER_TOOLS = new Set(['ls', 'find', 'grep', 'webdav_ls', 'webdav_mkdir']);

const VAULT_TOOLS = new Set(['ls', 'find', 'grep', 'read', 'write', 'edit']);

export type Place = 'vault' | 'storage';

export interface Touched {
	place: Place;
	/** Folders from the shallowest down, each one to look in for an AGENTS.md. */
	folders: string[];
}

/** Reads `<folder>/AGENTS.md`, or null when there is none. The signal is the tool call's. */
export type AgentsMdReader = (folder: string, signal?: AbortSignal) => Promise<string | null>;

/** `a/b/c.md` gives `a`, `a/b`; a folder path keeps its last segment. */
export function folderChain(path: string, isFolder: boolean): string[] {
	const parts = path.split('/').filter((p) => p && p !== '.');
	if (!isFolder) parts.pop();
	return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

function str(v: unknown): string | null {
	return typeof v === 'string' ? v : null;
}

/**
 * Where a tool call reaches. The vault root is left out because its AGENTS.md is already in the
 * system prompt; the storage root is kept, since nothing else reads it.
 */
export function touchedBy(tool: string, args: unknown, activePath: string | null): Touched[] {
	const a = (args ?? {}) as Record<string, unknown>;
	const isFolder = FOLDER_TOOLS.has(tool);
	if (VAULT_TOOLS.has(tool)) {
		const path = str(a.path);
		return path ? [{ place: 'vault', folders: folderChain(path, isFolder) }] : [];
	}
	if (tool === 'get_active_note')
		return activePath ? [{ place: 'vault', folders: folderChain(activePath, false) }] : [];
	if (!tool.startsWith('webdav_')) return [];
	const storage = (path: string | null, folder: boolean): Touched => ({
		place: 'storage',
		folders: ['', ...folderChain(path ?? '', folder)],
	});
	const out: Touched[] =
		tool === 'webdav_move'
			? [storage(str(a.from), false), storage(str(a.to), false)]
			: [storage(str(a.path), isFolder)];
	const vaultPath = str(a.vault_path);
	if (vaultPath) out.push({ place: 'vault', folders: folderChain(vaultPath, true) });
	return out;
}

/** The tag this module writes, made inert when it turns up inside a note or a web page. */
export function neutralizeTags(text: string): string {
	return text.replace(new RegExp(`<(/?)${TAG}`, 'g'), '&lt;$1' + TAG);
}

export interface NestedAgentsMdDeps {
	vault: AgentsMdReader;
	/** Null while the WebDAV storage is off. */
	storage: () => AgentsMdReader | null;
	activePath: () => string | null;
}

export class NestedAgentsMd {
	/** `place:folder` already looked at in this conversation, whether or not it held a file. */
	private readonly seen = new Set<string>();

	constructor(private readonly deps: NestedAgentsMdDeps) {}

	/**
	 * Forgets what was delivered. Called when the conversation changes and after compaction,
	 * which may have summarised the delivered text away.
	 */
	reset(): void {
		this.seen.clear();
	}

	/**
	 * The blocks to append to this call's result, or an empty string. After Stop nothing is read:
	 * a storage read can otherwise wait for the app to come back long after the run was stopped.
	 */
	async blockFor(tool: string, args: unknown, signal?: AbortSignal): Promise<string> {
		if (signal?.aborted) return '';
		const found: { key: string; label: string; text: string }[] = [];
		for (const { place, folders } of touchedBy(tool, args, this.deps.activePath())) {
			const read = place === 'vault' ? this.deps.vault : this.deps.storage();
			if (!read) continue;
			for (const folder of folders) {
				const key = `${place}:${folder}`;
				if (this.seen.has(key)) continue;
				// Marked before the read, so calls running side by side do not both deliver it.
				this.seen.add(key);
				const text = (await read(folder, signal).catch(() => null))?.trim();
				// A read Stop cut short delivered nothing; the next visit tries again.
				if (signal?.aborted) {
					this.seen.delete(key);
					continue;
				}
				if (!text) continue;
				const file = folder ? `${folder}/AGENTS.md` : 'AGENTS.md';
				found.push({ key, label: place === 'vault' ? file : `webdav:/${file}`, text });
			}
		}
		// Shallowest first, so the deeper folder's rules come last and win, as in Codex.
		let left = NESTED_AGENTS_MD_BUDGET;
		const blocks: string[] = [];
		for (const { key, label, text } of found) {
			if (left <= 0) {
				// Out of room this time: left unmarked so the next call that reaches it delivers it.
				this.seen.delete(key);
				continue;
			}
			const body =
				text.length > left ? `${text.slice(0, left)}\n[truncated to fit the budget]` : text;
			left -= body.length;
			blocks.push(`<${TAG} path="${label}">\n${neutralizeTags(body)}\n</${TAG}>`);
		}
		return blocks.length ? `\n\n${blocks.join('\n\n')}` : '';
	}
}
