import type { FsStat, IFileSystem } from 'just-bash/browser';
import type { App } from 'obsidian';
import { isReadOnlyPath } from '../tools/path-policy';

/** Where the vault sits in the shell. Everything else is scratch space in memory. */
export const VAULT_ROOT = '/vault';

export const READ_ONLY = (path: string) => `Hidden paths are read-only: ${path}`;

/** Called before the shell changes anything under the vault; throwing stops the write. */
export interface WriteGate {
	/** `content` is the new text, or null when the path is being removed. */
	(path: string, content: string | null): Promise<void>;
}

/** POSIX-style resolution: no `.`, no `..`, always absolute. */
export function normalizeShellPath(path: string): string {
	const parts: string[] = [];
	for (const part of (path.startsWith('/') ? path : `/${path}`).split('/')) {
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
	let out = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return out;
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

	constructor(
		private readonly app: App,
		private readonly gate: WriteGate,
	) {}

	/**
	 * Starts a command. One redirect reaches the filesystem twice, as a truncate and then the text,
	 * and a loop may touch the same note repeatedly, so approval is asked once per note per command
	 * and the rewind snapshot is taken at the first write, when the note is still untouched.
	 */
	beginCommand(): void {
		this.approved = new Set();
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
		if (isReadOnlyPath(rel, this.app.vault.configDir)) throw new Error(READ_ONLY(rel));
		if (this.approved.has(rel)) {
			await write();
			return;
		}
		await this.gate(rel, content);
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
		return rel === '' ? true : await this.app.vault.adapter.exists(rel);
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
		if (rel === '') return statOf(true, 0);
		const stat = await this.app.vault.adapter.stat(rel);
		if (!stat) throw enoent(path);
		return statOf(stat.type === 'folder', stat.size ?? 0);
	}

	lstat(path: string): Promise<FsStat> {
		return this.stat(path);
	}

	async readdir(path: string): Promise<string[]> {
		const rel = this.rel(path);
		if (rel === null) {
			const full = normalizeShellPath(path);
			const prefix = full === '/' ? '' : full;
			const names = new Set<string>();
			for (const key of [...this.mem.keys(), ...this.dirs]) {
				if (!key.startsWith(`${prefix}/`)) continue;
				const name = key.slice(prefix.length + 1).split('/')[0];
				if (name) names.add(name);
			}
			return [...names];
		}
		const listed = await this.app.vault.adapter.list(rel);
		const name = (p: string) => p.split('/').pop() ?? p;
		return [...listed.folders.map(name), ...listed.files.map(name)];
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
			if (rel === null) this.dirs.add(normalizeShellPath(path));
			else if (!(await this.app.vault.adapter.exists(rel)))
				await this.app.vault.adapter.mkdir(rel);
		});
	}

	async rm(path: string): Promise<void> {
		await this.change(path, null, async () => {
			const rel = this.rel(path);
			if (rel === null) {
				const full = normalizeShellPath(path);
				this.mem.delete(full);
				this.dirs.delete(full);
			} else await this.app.vault.adapter.remove(rel);
		});
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

function statOf(isDirectory: boolean, size: number): FsStat {
	return {
		isFile: !isDirectory,
		isDirectory,
		isSymbolicLink: false,
		mode: isDirectory ? 0o40755 : 0o100644,
		size,
		mtime: new Date(),
	};
}
