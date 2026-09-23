import { normalizePath, type TAbstractFile, TFile, TFolder } from 'obsidian';

const encode = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

interface Stat {
	type: 'file' | 'folder';
	ctime: number;
	mtime: number;
	size: number;
}

/** In-memory vault: text files, binary files and folders, with the Obsidian shapes the code touches. */
export class FakeVault {
	configDir = '.obsidian';
	private texts = new Map<string, string>();
	private binaries = new Map<string, ArrayBuffer>();
	private folders = new Set<string>(['']);
	private mtimes = new Map<string, number>();
	/** Counts the write-side API calls, for tests that assert nothing was written. */
	writes = 0;
	private clock = 1;
	adapter = {
		exists: async (p: string) => this.has(normalizePath(p)),
		mkdir: async (p: string) => {
			this.folders.add(normalizePath(p));
		},
		read: async (p: string) => {
			const key = normalizePath(p);
			if (!this.texts.has(key)) throw new Error(`ENOENT ${p}`);
			return this.texts.get(key)!;
		},
		write: async (p: string, data: string) => this.setText(normalizePath(p), data),
		append: async (p: string, data: string) =>
			this.setText(normalizePath(p), (this.texts.get(normalizePath(p)) ?? '') + data),
		remove: async (p: string) => {
			this.texts.delete(normalizePath(p));
			this.binaries.delete(normalizePath(p));
		},
		rmdir: async (p: string) => {
			const prefix = `${normalizePath(p)}/`;
			for (const k of [...this.texts.keys()]) if (k.startsWith(prefix)) this.texts.delete(k);
			this.folders.delete(normalizePath(p));
		},
		list: async (p: string) => {
			const prefix = normalizePath(p) ? `${normalizePath(p)}/` : '';
			const files = [...this.texts.keys(), ...this.binaries.keys()].filter(
				(k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'),
			);
			const folders = [...this.folders].filter(
				(k) =>
					k !== normalizePath(p) &&
					k.startsWith(prefix) &&
					!k.slice(prefix.length).includes('/'),
			);
			return { files, folders };
		},
		stat: async (p: string): Promise<Stat | null> => {
			const key = normalizePath(p);
			if (this.texts.has(key)) {
				return {
					type: 'file',
					ctime: 0,
					mtime: this.mtimes.get(key) ?? 0,
					size: this.texts.get(key)!.length,
				};
			}
			if (this.folders.has(key)) return { type: 'folder', ctime: 0, mtime: 0, size: 0 };
			return null;
		},
	};

	private has(key: string) {
		return this.texts.has(key) || this.binaries.has(key) || this.folders.has(key);
	}

	private setText(key: string, data: string) {
		this.texts.set(key, data);
		this.mtimes.set(key, this.clock++);
		const slash = key.lastIndexOf('/');
		if (slash > 0) {
			const parts = key.slice(0, slash).split('/');
			let acc = '';
			for (const part of parts) {
				acc = acc ? `${acc}/${part}` : part;
				this.folders.add(acc);
			}
		}
	}

	/** Test helper: seed a note. */
	seed(path: string, content: string): TFile {
		this.setText(normalizePath(path), content);
		return this.getFileByPath(path)!;
	}

	seedBinary(path: string, data: ArrayBuffer): TFile {
		this.binaries.set(normalizePath(path), data);
		return this.getFileByPath(path)!;
	}

	text(path: string): string | undefined {
		return this.texts.get(normalizePath(path));
	}

	private makeFile(key: string): TFile {
		const f = new TFile();
		f.path = key;
		f.name = key.slice(key.lastIndexOf('/') + 1);
		const dot = f.name.lastIndexOf('.');
		f.basename = dot > 0 ? f.name.slice(0, dot) : f.name;
		f.extension = dot > 0 ? f.name.slice(dot + 1) : '';
		f.stat = {
			size: this.texts.get(key)?.length ?? 0,
			mtime: this.mtimes.get(key) ?? 0,
			ctime: 0,
		};
		return f;
	}

	private makeFolder(key: string): TFolder {
		const folder = new TFolder();
		folder.path = key;
		folder.name = key.slice(key.lastIndexOf('/') + 1);
		const prefix = key ? `${key}/` : '';
		const children: TAbstractFile[] = [];
		for (const sub of this.folders) {
			if (sub !== key && sub.startsWith(prefix) && !sub.slice(prefix.length).includes('/'))
				children.push(this.makeFolder(sub));
		}
		for (const file of [...this.texts.keys(), ...this.binaries.keys()]) {
			if (file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
				children.push(this.makeFile(file));
		}
		folder.children = children;
		return folder;
	}

	getRoot(): TFolder {
		return this.makeFolder('');
	}

	/** Like Obsidian, dot folders exist on disk (adapter) but are not in the index. */
	private indexed(key: string): boolean {
		return !key.split('/').some((s) => s.startsWith('.'));
	}

	getFileByPath(path: string): TFile | null {
		const key = normalizePath(path);
		return (this.texts.has(key) || this.binaries.has(key)) && this.indexed(key)
			? this.makeFile(key)
			: null;
	}

	getFolderByPath(path: string): TFolder | null {
		const key = normalizePath(path);
		return this.folders.has(key) && this.indexed(key) ? this.makeFolder(key) : null;
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.getFileByPath(path) ?? this.getFolderByPath(path);
	}

	getAllFolders(includeRoot = false): TFolder[] {
		return [...this.folders]
			.filter((k) => (includeRoot || k !== '') && this.indexed(k))
			.map((k) => this.makeFolder(k));
	}

	getMarkdownFiles(): TFile[] {
		return [...this.texts.keys()]
			.filter((k) => k.endsWith('.md') && this.indexed(k))
			.map((k) => this.makeFile(k));
	}

	getFiles(): TFile[] {
		return [...this.texts.keys(), ...this.binaries.keys()]
			.filter((k) => this.indexed(k))
			.map((k) => this.makeFile(k));
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.adapter.read(file.path);
	}

	async read(file: TFile): Promise<string> {
		return this.adapter.read(file.path);
	}

	/** Like Obsidian, any file reads as bytes, text files included. */
	async readBinary(file: TFile): Promise<ArrayBuffer> {
		const t = this.texts.get(file.path);
		const b = this.binaries.get(file.path) ?? (t === undefined ? undefined : encode(t));
		if (!b) throw new Error(`ENOENT ${file.path}`);
		return b;
	}

	/** Test helper: a file's bytes, whichever way it was written. */
	bytes(path: string): Uint8Array | undefined {
		const t = this.texts.get(normalizePath(path));
		const b =
			this.binaries.get(normalizePath(path)) ?? (t === undefined ? undefined : encode(t));
		return b && new Uint8Array(b);
	}

	async create(path: string, data: string): Promise<TFile> {
		this.writes++;
		if (this.has(normalizePath(path))) throw new Error(`File already exists: ${path}`);
		return this.seed(path, data);
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
		this.writes++;
		return this.seedBinary(path, data);
	}

	async createFolder(path: string): Promise<TFolder> {
		this.writes++;
		this.folders.add(normalizePath(path));
		return this.getFolderByPath(path)!;
	}

	async modify(file: TFile, data: string): Promise<void> {
		this.writes++;
		this.setText(file.path, data);
	}

	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		this.writes++;
		const next = fn(await this.read(file));
		this.setText(file.path, next);
		return next;
	}

	async delete(file: TFile): Promise<void> {
		this.writes++;
		await this.adapter.remove(file.path);
	}
}

export class FakeApp {
	vault = new FakeVault();
	frontmatter = new Map<string, Record<string, unknown>>();
	activeFile: TFile | null = null;
	secrets = new Map<string, string>();
	trashed: string[] = [];
	metadataCache = {
		getFileCache: (file: TFile) => ({ frontmatter: this.frontmatter.get(file.path) }),
		getFirstLinkpathDest: () => null,
	};
	workspace = {
		getActiveFile: () => this.activeFile,
		on: () => ({}),
	};
	fileManager = {
		trashFile: async (file: TAbstractFile) => {
			this.trashed.push(file.path);
			await this.vault.adapter.remove(file.path);
		},
	};
	/** Obsidian's per-device store, which the controller uses to remember a turn it must finish. */
	localStore = new Map<string, unknown>();
	loadLocalStorage(key: string): unknown {
		return this.localStore.has(key) ? this.localStore.get(key) : null;
	}
	saveLocalStorage(key: string, data: unknown): void {
		if (data === null) this.localStore.delete(key);
		else this.localStore.set(key, data);
	}
	secretStorage = {
		getSecret: (id: string) => (this.secrets.has(id) ? this.secrets.get(id)! : null),
		setSecret: (id: string, value: string) => {
			if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error('invalid id');
			this.secrets.set(id, value);
		},
		listSecrets: () => [...this.secrets.keys()],
	};
}
