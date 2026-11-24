import type { FsStat, IFileSystem } from 'just-bash/browser';
import { type App, type TAbstractFile, TFile, TFolder } from 'obsidian';
import { isReadOnlyPath } from '../tools/path-policy';

type DirentEntry = Awaited<ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>>[number];

/** Where the vault sits in the shell. Everything else is scratch space in memory. */
export const VAULT_ROOT = '/vault';

export const READ_ONLY = (path: string) => `Hidden paths are read-only: ${path}`;

/**
 * Called before the shell changes anything under the vault; throwing stops the write. `content`
 * is the new text, or null when the path is being removed. `ask` only asks, for a folder about to
 * go with the files listed in `content`; `keep` only keeps the rewind snapshot of a file that
 * question covered.
 */
export type WriteGate = (
	path: string,
	content: string | null,
	step?: 'ask' | 'keep',
) => Promise<void>;

/** Folders a walk through a hidden folder passes by unless they are named (issue #81). */
const HEAVY = new Set(['node_modules', '.git']);

/** POSIX-style resolution: no `.`, no `..`, always absolute. */
export function normalizeShellPath(path: string): string {
	const parts: string[] = [];
	for (const part of path.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') parts.pop();
		else parts.push(part);
	}
	return `/${parts.join('/')}`;
}

function enoent(path: string): Error {
	return new Error(`ENOENT: no such file or directory, '${path}'`);
}

/** just-bash names an encoding as a bare string or as `{ encoding }`. */
function isBinary(options: unknown): boolean {
	const encoding =
		typeof options === 'string'
			? options
			: (options as { encoding?: unknown } | null)?.encoding;
	return encoding === 'binary' || encoding === 'latin1';
}

/**
 * The shell carries bytes as a string with one byte per character, and a redirect of such output
 * says `binary`; any other string is text and is stored as UTF-8 (issue #48).
 */
export function toBytes(content: unknown, options?: unknown): Uint8Array {
	if (content instanceof Uint8Array) return content;
	const text = String(content);
	if (!isBinary(options)) return new TextEncoder().encode(text);
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
	return bytes;
}

/** One character per byte. TextDecoder's `latin1` is windows-1252, which remaps 0x80 to 0x9f. */
export function latin1(bytes: Uint8Array): string {
	// Each byte widened to one UTF-16 unit: 10 MB takes 10 ms, where String.fromCharCode took 500.
	return new TextDecoder('utf-16le').decode(new Uint16Array(bytes));
}

/** The text a UTF-8 file holds, or null when the bytes are not UTF-8, as in an image. */
function utf8(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return null;
	}
}

/**
 * The shell's filesystem. Paths under `/vault` are the real vault through Obsidian, so `grep` and
 * `sed` work on notes; everything else lives in a Map that lasts as long as the session. Writes to
 * the vault pass `gate` first, which is the one place the shell can change the user's files.
 */
export class VaultFs implements IFileSystem {
	/** Scratch files as bytes, so a PNG saved to /tmp comes back out unchanged. */
	private readonly mem = new Map<string, Uint8Array>();
	private readonly dirs = new Set<string>(['/', '/tmp', VAULT_ROOT]);
	/** Vault paths already approved during the command now running. */
	private approved = new Set<string>();
	/** Files a folder's one question covered: they go without a card of their own. */
	private covered = new Set<string>();
	/**
	 * Why changes the command now running asked for did not happen. A command may swallow the
	 * error, as `rm -f` does, and the model must still learn that nothing changed.
	 */
	refusals: string[] = [];
	/**
	 * The command now running changed the vault. The index hears of a change only later, so from
	 * then on the command's stat and listings go by the adapter.
	 * shortcut: one flag for the whole vault, track the changed paths if writing commands get slow.
	 */
	private dirty = false;

	/**
	 * `passBy` names hidden folders, as vault paths, that a walk passes by like the heavy ones:
	 * the plugin's own sessions and snapshots, which grow with every conversation and were most of
	 * what grep -r read under the settings folder (issue #88).
	 */
	constructor(
		private readonly app: App,
		private readonly gate: WriteGate,
		private readonly passBy: () => readonly string[] = () => [],
	) {}

	/**
	 * Starts a command. One redirect reaches the filesystem twice, as a truncate and then the text,
	 * and a loop may touch the same note repeatedly, so approval is asked once per note per command
	 * and the rewind snapshot is taken at the first write, when the note is still untouched.
	 */
	beginCommand(): void {
		this.approved = new Set();
		this.covered = new Set();
		this.refusals = [];
		this.dirty = false;
	}

	/**
	 * What Obsidian's index in memory holds at a vault path (issues #80, #81): asking the adapter
	 * for every entry made find, du and ls -R as slow as the disk or the cloud drive under the
	 * vault. Null for a path the index lacks, as it lacks hidden ones, which goes by the adapter.
	 */
	private indexed(rel: string): TAbstractFile | null {
		if (this.dirty) return null;
		return rel === '' ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(rel);
	}

	private refuse(message: string): Error {
		this.refusals.push(message);
		return new Error(message);
	}

	/** The vault-relative path, or null when the path is outside the vault. */
	private rel(path: string): string | null {
		const full = normalizeShellPath(path);
		if (full === VAULT_ROOT) return '';
		return full.startsWith(`${VAULT_ROOT}/`) ? full.slice(VAULT_ROOT.length + 1) : null;
	}

	private async change(
		path: string,
		content: string | null,
		write: () => Promise<void>,
	): Promise<void> {
		const rel = this.rel(path);
		if (rel === null || rel === '') {
			await write();
			return;
		}
		this.dirty = true;
		if (isReadOnlyPath(rel, this.app.vault.configDir)) throw this.refuse(READ_ONLY(rel));
		if (this.approved.has(rel)) {
			await write();
			return;
		}
		try {
			await this.gate(rel, content, this.covered.has(rel) ? 'keep' : undefined);
		} catch (error) {
			throw this.refuse(error instanceof Error ? error.message : String(error));
		}
		this.approved.add(rel);
		await write();
	}

	// Path helpers. These two are the only synchronous members of the interface.

	resolvePath(base: string, path: string): string {
		return normalizeShellPath(path.startsWith('/') ? path : `${base}/${path}`);
	}

	getAllPaths(): string[] {
		const paths = [...this.mem.keys(), ...this.dirs];
		for (const file of this.app.vault.getFiles()) paths.push(`${VAULT_ROOT}/${file.path}`);
		for (const folder of this.app.vault.getAllFolders())
			paths.push(`${VAULT_ROOT}/${folder.path}`);
		return paths;
	}

	// Reading

	async readFile(path: string, options?: unknown): Promise<string> {
		const rel = this.rel(path);
		if (rel !== null && !isBinary(options)) return await this.app.vault.adapter.read(rel);
		const bytes = await this.readFileBuffer(path);
		return isBinary(options) ? latin1(bytes) : new TextDecoder().decode(bytes);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const rel = this.rel(path);
		if (rel === null) {
			const bytes = this.mem.get(normalizeShellPath(path));
			if (bytes === undefined) throw enoent(path);
			return bytes;
		}
		return new Uint8Array(await this.app.vault.adapter.readBinary(rel));
	}

	async exists(path: string): Promise<boolean> {
		const rel = this.rel(path);
		if (rel === null) {
			const full = normalizeShellPath(path);
			return this.mem.has(full) || this.dirs.has(full);
		}
		return this.indexed(rel) !== null || (await this.app.vault.adapter.exists(rel));
	}

	async stat(path: string): Promise<FsStat> {
		const rel = this.rel(path);
		if (rel === null) {
			const full = normalizeShellPath(path);
			if (this.dirs.has(full)) return statOf(true, 0);
			const bytes = this.mem.get(full);
			if (bytes === undefined) throw enoent(path);
			return statOf(false, bytes.length);
		}
		const known = this.indexed(rel);
		if (known instanceof TFile) return statOf(false, known.stat.size, known.stat.mtime);
		if (known || rel === '') return statOf(true, 0);
		const stat = await this.app.vault.adapter.stat(rel);
		if (!stat) throw enoent(path);
		return statOf(stat.type === 'folder', stat.size ?? 0, stat.mtime);
	}

	lstat(path: string): Promise<FsStat> {
		return this.stat(path);
	}

	async readdir(path: string): Promise<string[]> {
		return (await this.readdirWithFileTypes(path)).map((entry) => entry.name);
	}

	/**
	 * A folder's entries with their kinds, so find and ls need no stat for each. A folder in the
	 * index lists what the index holds: hidden entries such as .obsidian are left out, and a
	 * search from the vault root no longer walks through them. A hidden folder named outright is
	 * listed by the adapter, without the node_modules and .git inside it: a plugin's folder may
	 * hold tens of thousands of files there, and grep -r read them all. The folders of `passBy`
	 * are left out the same way.
	 */
	async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
		const entry = (name: string, isDirectory: boolean): DirentEntry => ({
			name,
			isFile: !isDirectory,
			isDirectory,
			isSymbolicLink: false,
		});
		const rel = this.rel(path);
		if (rel === null) {
			const full = normalizeShellPath(path);
			const prefix = full === '/' ? '' : full;
			const kinds = new Map<string, boolean>();
			for (const key of [...this.mem.keys(), ...this.dirs]) {
				if (!key.startsWith(`${prefix}/`)) continue;
				const rest = key.slice(prefix.length + 1);
				const name = rest.split('/')[0];
				if (!name) continue;
				const isDirectory = rest !== name || this.dirs.has(key);
				kinds.set(name, kinds.get(name) === true || isDirectory);
			}
			return [...kinds].map(([name, isDirectory]) => entry(name, isDirectory));
		}
		const known = this.indexed(rel);
		if (known instanceof TFolder)
			return known.children.map((child) => entry(child.name, child instanceof TFolder));
		const listed = await this.app.vault.adapter.list(rel);
		const name = (p: string) => p.split('/').pop() ?? p;
		const passed = this.passBy();
		return [
			...listed.folders
				.filter((f) => !HEAVY.has(name(f)) && !passed.includes(f))
				.map((f) => entry(name(f), true)),
			...listed.files.map((f) => entry(name(f), false)),
		];
	}

	// Writing

	async writeFile(path: string, content: unknown, options?: unknown): Promise<void> {
		const bytes = toBytes(content, options);
		// The approval card shows text; an image goes by its path alone.
		const text = utf8(bytes);
		await this.change(path, text ?? '', async () => {
			const rel = this.rel(path);
			if (rel === null) this.mem.set(normalizeShellPath(path), bytes);
			else if (text !== null) await this.app.vault.adapter.write(rel, text);
			else
				await this.app.vault.adapter.writeBinary(
					rel,
					bytes.buffer.slice(
						bytes.byteOffset,
						bytes.byteOffset + bytes.byteLength,
					) as ArrayBuffer,
				);
		});
	}

	async appendFile(path: string, content: unknown, options?: unknown): Promise<void> {
		const before = (await this.exists(path))
			? await this.readFileBuffer(path)
			: new Uint8Array();
		const added = toBytes(content, options);
		const joined = new Uint8Array(before.length + added.length);
		joined.set(before);
		joined.set(added, before.length);
		await this.writeFile(path, joined);
	}

	async mkdir(path: string): Promise<void> {
		await this.change(path, '', async () => {
			const rel = this.rel(path);
			// With the folders on the way to it: mkdir -p names only the last one, and without
			// them /tmp/d was no folder to stat or ls after `mkdir -p /tmp/d/sub`.
			if (rel === null) {
				const parts = normalizeShellPath(path).split('/');
				const dirs = parts.slice(1).map((_, i) => parts.slice(0, i + 2).join('/'));
				const file = dirs.find((dir) => this.mem.has(dir));
				if (file) throw new Error(`EEXIST: file already exists, mkdir '${file}'`);
				for (const dir of dirs) this.dirs.add(dir);
			} else if (!(await this.app.vault.adapter.exists(rel)))
				await this.app.vault.adapter.mkdir(rel);
		});
	}

	async rm(path: string, options?: { recursive?: boolean }): Promise<void> {
		const full = normalizeShellPath(path);
		const rel = this.rel(full);
		if (rel === '' || full === '/') throw this.refuse(`refusing to remove '${full}'`);
		const folder =
			rel === null
				? this.dirs.has(full)
				: (await this.app.vault.adapter.stat(rel))?.type === 'folder';
		if (folder) {
			await this.rmFolder(full, rel, options?.recursive === true);
			return;
		}
		await this.change(path, null, async () => {
			if (rel === null) this.mem.delete(full);
			else await this.app.vault.adapter.remove(rel);
		});
	}

	/**
	 * `rm -r` and `rmdir`. The adapter cannot remove a folder the way it removes a file, so each file
	 * goes first, keeping its rewind snapshot as a removed note does; the emptied folders follow.
	 * A folder of several files asks once, with the files listed (issue #81), not once a file.
	 */
	private async rmFolder(full: string, rel: string | null, recursive: boolean): Promise<void> {
		const files = await this.filesIn(full);
		if (files.length && !recursive)
			throw new Error(`ENOTEMPTY: directory not empty, '${full}'`);
		// A read-only folder, or a read-only file inside, stops the removal before anything goes.
		const { configDir } = this.app.vault;
		const locked = [rel, ...files.map((f) => this.rel(f))].find(
			(r) => r && isReadOnlyPath(r, configDir),
		);
		if (locked) throw this.refuse(READ_ONLY(locked));
		if (rel !== null && files.length > 1) {
			const inside = files.map((f) => this.rel(f) ?? f);
			try {
				await this.gate(rel, inside.join('\n'), 'ask');
			} catch (error) {
				throw this.refuse(error instanceof Error ? error.message : String(error));
			}
			for (const file of inside) this.covered.add(file);
		}
		for (const file of files) await this.rm(file);
		if (rel === null) {
			for (const dir of [...this.dirs])
				if (dir === full || dir.startsWith(`${full}/`)) this.dirs.delete(dir);
			return;
		}
		await this.app.vault.adapter.rmdir(rel, recursive);
	}

	/** Every file under a folder, as shell paths. */
	private async filesIn(full: string): Promise<string[]> {
		const rel = this.rel(full);
		if (rel === null) return [...this.mem.keys()].filter((key) => key.startsWith(`${full}/`));
		const out: string[] = [];
		const pending = [rel];
		while (pending.length) {
			const listed = await this.app.vault.adapter.list(pending.pop()!);
			out.push(...listed.files.map((f) => `${VAULT_ROOT}/${f}`));
			pending.push(...listed.folders);
		}
		return out;
	}

	async cp(src: string, dest: string): Promise<void> {
		await this.writeFile(dest, await this.readFileBuffer(src));
	}

	async mv(src: string, dest: string): Promise<void> {
		await this.cp(src, dest);
		await this.rm(src);
	}

	// Not meaningful on a vault, but the interface asks for them.

	async chmod(): Promise<void> {}
	async utimes(): Promise<void> {}
	async symlink(): Promise<void> {
		throw new Error('symlink is not supported here');
	}
	async link(): Promise<void> {
		throw new Error('link is not supported here');
	}
	async readlink(path: string): Promise<string> {
		return normalizeShellPath(path);
	}
	async realpath(path: string): Promise<string> {
		return normalizeShellPath(path);
	}
}

function statOf(isDirectory: boolean, size: number, mtime?: number): FsStat {
	return {
		isFile: !isDirectory,
		isDirectory,
		isSymbolicLink: false,
		mode: isDirectory ? 0o40755 : 0o100644,
		size,
		mtime: mtime ? new Date(mtime) : new Date(),
	};
}
