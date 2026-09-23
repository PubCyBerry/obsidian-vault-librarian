import { JSDOM } from 'jsdom';
import type { App, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeSettings } from '../src/types';
import { summarizeCall } from '../src/ui/cards';
import { noteVisibility } from '../src/visibility';
import {
	NO_PASSWORD,
	parseMultistatus,
	storagePath,
	WebDavClient,
} from '../src/webdav/webdav-client';
import { createWebDavTools } from '../src/webdav/webdav-tools';
import { FakeApp } from './fake-app';

// The plugin parses multistatus with the platform's DOMParser; Node has none, jsdom lends one.
(globalThis as unknown as { DOMParser: unknown }).DOMParser = new JSDOM().window.DOMParser;

const BASE = 'https://nas.test/home';
const AUTH = `Basic ${btoa('u:p')}`;

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: ArrayBuffer | Uint8Array) => new TextDecoder().decode(b);

/** In-memory WebDAV server with the behaviour of RFC 4918 that the client relies on. */
class FakeDav {
	files = new Map<string, Uint8Array>();
	folders = new Set<string>(['']);
	etags = new Map<string, number>();
	requests: RequestUrlParam[] = [];
	/** Throws instead of answering, like a phone that froze the connection. */
	dropNext: ((req: RequestUrlParam) => boolean) | null = null;
	private tag = 1;

	seed(path: string, content: string | Uint8Array) {
		const data = typeof content === 'string' ? bytes(content) : content;
		const parts = path.split('/');
		for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
		this.files.set(path, data);
		this.etags.set(path, this.tag++);
	}

	private pathOf(url: string): string {
		if (!url.startsWith(BASE)) throw new Error(`outside the storage: ${url}`);
		return url.slice(BASE.length).split('/').filter(Boolean).map(decodeURIComponent).join('/');
	}

	private parent(path: string) {
		return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	}

	private href(path: string, folder: boolean) {
		const encoded = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
		return `/home/${encoded}${folder && encoded ? '/' : ''}`;
	}

	private under(path: string) {
		const prefix = path ? `${path}/` : '';
		return {
			files: [...this.files.keys()].filter((k) => k.startsWith(prefix)),
			folders: [...this.folders].filter((k) => k !== path && k.startsWith(prefix)),
		};
	}

	private propResponse(path: string): string {
		const folder = this.folders.has(path);
		const size = folder
			? ''
			: `<D:getcontentlength>${this.files.get(path)!.length}</D:getcontentlength>`;
		return `<D:response><D:href>${this.href(path, folder)}</D:href><D:propstat><D:prop><D:resourcetype>${folder ? '<D:collection/>' : ''}</D:resourcetype>${size}<D:getlastmodified>Tue, 22 Sep 2026 10:00:00 GMT</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
	}

	async handle(req: RequestUrlParam): Promise<RequestUrlResponse> {
		this.requests.push(req);
		if (this.dropNext?.(req)) {
			this.dropNext = null;
			throw new Error('net::ERR_NETWORK_IO_SUSPENDED');
		}
		const answer = (status: number, body: string | Uint8Array = '', headers = {}) => {
			const data = typeof body === 'string' ? bytes(body) : body;
			return {
				status,
				headers,
				arrayBuffer: data.slice().buffer,
				text: text(data),
				json: null,
			} as RequestUrlResponse;
		};
		if (req.headers?.Authorization !== AUTH) return answer(401);
		const path = this.pathOf(req.url);
		const exists = this.files.has(path) || this.folders.has(path);
		switch (req.method) {
			case 'PROPFIND': {
				if (!exists) return answer(404);
				const children =
					req.headers?.Depth === '1' && this.folders.has(path)
						? [...this.files.keys(), ...this.folders].filter(
								(k) => k !== path && this.parent(k) === path,
							)
						: [];
				return answer(
					207,
					`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${[path, ...children].map((p) => this.propResponse(p)).join('')}</D:multistatus>`,
				);
			}
			case 'GET':
				if (!this.files.has(path)) return answer(404);
				return answer(200, this.files.get(path)!, { ETag: `"${this.etags.get(path)}"` });
			case 'PUT': {
				if (this.folders.has(path)) return answer(405);
				if (!this.folders.has(this.parent(path))) return answer(409);
				const match = req.headers?.['If-Match'];
				if (match && match !== `"${this.etags.get(path)}"`) return answer(412);
				const existed = this.files.has(path);
				this.files.set(path, new Uint8Array(req.body as ArrayBuffer));
				this.etags.set(path, this.tag++);
				return answer(existed ? 204 : 201);
			}
			case 'MKCOL':
				if (exists) return answer(405);
				if (!this.folders.has(this.parent(path))) return answer(409);
				this.folders.add(path);
				return answer(201);
			case 'DELETE': {
				if (!exists) return answer(404);
				const { files, folders } = this.under(path);
				for (const f of files) this.files.delete(f);
				for (const f of folders) this.folders.delete(f);
				this.files.delete(path);
				this.folders.delete(path);
				return answer(204);
			}
			case 'MOVE': {
				if (!exists) return answer(404);
				const to = this.pathOf(req.headers!.Destination!);
				if (this.files.has(to) || this.folders.has(to)) return answer(412);
				if (!this.folders.has(this.parent(to))) return answer(409);
				const { files, folders } = this.under(path);
				const rename = (k: string) => `${to}${k.slice(path.length)}`;
				for (const f of folders) {
					this.folders.delete(f);
					this.folders.add(rename(f));
				}
				for (const f of [...files, ...(this.files.has(path) ? [path] : [])]) {
					this.files.set(rename(f), this.files.get(f)!);
					this.files.delete(f);
				}
				if (this.folders.delete(path)) this.folders.add(to);
				return answer(201);
			}
			default:
				return answer(405);
		}
	}
}

let dav: FakeDav;
let app: FakeApp;
let hooks: { before: string[]; after: string[] };

function client(password: string | null = 'p') {
	return new WebDavClient({
		url: BASE,
		username: 'u',
		password,
		request: (r) => dav.handle(r),
	});
}

function tools(password: string | null = 'p') {
	return createWebDavTools({
		app: app as unknown as App,
		settings: () => mergeSettings({}),
		client: () => client(password),
		mutation: {
			before: async (_id, path) => void hooks.before.push(path),
			after: async (_id, path) => void hooks.after.push(path),
		},
	});
}

async function run(
	name: string,
	args: Record<string, unknown>,
	opts: { password?: string | null; signal?: AbortSignal } = {},
) {
	const t = tools(opts.password === undefined ? 'p' : opts.password).find((x) => x.name === name);
	if (!t) throw new Error(name);
	const result = await t.execute('call-1', args as never, opts.signal);
	return JSON.parse((result.content[0] as { text: string }).text) as Record<string, never>;
}

beforeEach(() => {
	dav = new FakeDav();
	app = new FakeApp();
	hooks = { before: [], after: [] };
});

describe('storage paths (LIB-TEST-153)', () => {
	it('refuses traversal and URLs and normalizes slashes', () => {
		expect(() => storagePath('a/../b')).toThrow(/traversal/);
		expect(() => storagePath('https://x/y')).toThrow(/not a URL/);
		expect(storagePath('/사진/2026/')).toBe('사진/2026');
		expect(storagePath('a\\b')).toBe('a/b');
		expect(storagePath('./a/./b')).toBe('a/b');
		expect(storagePath('')).toBe('');
		expect(client().url('사진/a b#1.md')).toBe(`${BASE}/%EC%82%AC%EC%A7%84/a%20b%231.md`);
		expect(client().url('', true)).toBe(`${BASE}/`);
	});
});

describe('multistatus parsing (LIB-TEST-153)', () => {
	const expected = [
		{ name: 'docs', depth: 2, folder: true, modified: '2026-09-22T10:00:00.000Z' },
		{ name: 'a&b.md', depth: 3, folder: false, size: 12, modified: '2026-09-22T10:00:00.000Z' },
	];
	const body = (open: string, close: string, href: (p: string) => string) =>
		`<?xml version="1.0"?>${open}` +
		`<X:response><X:href>${href('/home/docs/')}</X:href><X:propstat><X:prop><X:resourcetype><X:collection/></X:resourcetype><X:getlastmodified>Tue, 22 Sep 2026 10:00:00 GMT</X:getlastmodified></X:prop><X:status>HTTP/1.1 200 OK</X:status></X:propstat>` +
		`<X:propstat><X:prop><X:getcontentlength/></X:prop><X:status>HTTP/1.1 404 Not Found</X:status></X:propstat></X:response>` +
		`<X:response><X:href>${href('/home/docs/a%26b.md')}</X:href><X:propstat><X:prop><X:resourcetype/><X:getcontentlength>12</X:getcontentlength><X:getlastmodified>Tue, 22 Sep 2026 10:00:00 GMT</X:getlastmodified></X:prop></X:propstat></X:response>${close}`;

	it('reads any prefix, the default namespace, full URLs and entities alike', () => {
		const prefixed = body(
			'<D:multistatus xmlns:D="DAV:">',
			'</D:multistatus>',
			(h) => h,
		).replace(/X:/g, 'D:');
		const lower = body('<d:multistatus xmlns:d="DAV:">', '</d:multistatus>', (h) => h).replace(
			/X:/g,
			'd:',
		);
		const bare = body('<multistatus xmlns="DAV:">', '</multistatus>', (h) => h).replace(
			/X:/g,
			'',
		);
		const full = body(
			'<D:multistatus xmlns:D="DAV:">',
			'</D:multistatus>',
			(h) => `https://192.168.0.2:5006${h}`,
		).replace(/X:/g, 'D:');
		const entity = body('<D:multistatus xmlns:D="DAV:">', '</D:multistatus>', (h) =>
			h.replace('%26', '&amp;'),
		).replace(/X:/g, 'D:');
		for (const xml of [prefixed, lower, bare, full, entity])
			expect(parseMultistatus(xml)).toEqual(expected);
	});

	it('lists the children of a folder without the folder itself', async () => {
		dav.seed('docs/b.md', 'b');
		dav.seed('docs/a.md', 'hello');
		dav.folders.add('docs/sub');
		expect(await client().list('docs')).toEqual([
			{ type: 'file', path: 'docs/a.md', size: 5, modified: '2026-09-22T10:00:00.000Z' },
			{ type: 'file', path: 'docs/b.md', size: 1, modified: '2026-09-22T10:00:00.000Z' },
			{ type: 'folder', path: 'docs/sub', modified: '2026-09-22T10:00:00.000Z' },
		]);
		await expect(client().list('docs/a.md')).rejects.toThrow('Folder not found: docs/a.md');
	});
});

describe('errors (LIB-TEST-153)', () => {
	it('turns statuses into messages and sends nothing without a password', async () => {
		const wrong = new WebDavClient({
			url: BASE,
			username: 'u',
			password: 'nope',
			request: (r) => dav.handle(r),
		});
		await expect(wrong.list('')).rejects.toThrow(
			'The storage rejected the user name or password.',
		);
		await expect(run('webdav_read', { path: 'missing.md' })).rejects.toThrow(
			'Not found: missing.md',
		);
		const before = dav.requests.length;
		await expect(run('webdav_ls', {}, { password: null })).rejects.toThrow(NO_PASSWORD);
		expect(dav.requests.length).toBe(before);
	});
});

describe('requests broken while the app was away (LIB-TEST-153)', () => {
	const g = globalThis as unknown as { document?: { visibilityState: string } };
	const set = (state: string) => {
		g.document = { visibilityState: state };
		noteVisibility();
	};
	afterEach(() => {
		delete g.document;
		noteVisibility();
	});

	it('sends a listing again once the app is back, but never a move', async () => {
		dav.seed('a.md', 'a');
		set('visible');
		dav.dropNext = () => {
			set('hidden');
			return true;
		};
		const listing = run('webdav_ls', {});
		await new Promise((r) => setTimeout(r, 10));
		expect(dav.requests.length).toBe(1);
		set('visible');
		expect((await listing).total).toBe(1);
		expect(dav.requests.length).toBe(2);

		dav.dropNext = (req) => {
			if (req.method !== 'MOVE') return false;
			set('hidden');
			return true;
		};
		await expect(run('webdav_move', { from: 'a.md', to: 'b.md' })).rejects.toThrow(
			/unknown whether the server ran this call/,
		);
		expect(dav.requests.filter((r) => r.method === 'MOVE').length).toBe(1);
	});

	it('counts a resent delete that finds nothing as done', async () => {
		dav.seed('gone.md', 'x');
		set('visible');
		// The server deletes, then the answer is lost while the app is away.
		dav.dropNext = (req) => {
			if (req.method !== 'DELETE') return false;
			dav.files.delete('gone.md');
			set('hidden');
			setTimeout(() => set('visible'), 5);
			return true;
		};
		expect(await run('webdav_delete', { path: 'gone.md' })).toEqual({
			path: 'gone.md',
			deleted: true,
		});
	});
});

describe('storage tools (LIB-TEST-153)', () => {
	it('lists, reads by line range and refuses binary files', async () => {
		dav.seed('notes/n.md', 'l1\nl2\nl3');
		dav.seed('notes/p.png', new Uint8Array([1, 2]));
		const ls = await run('webdav_ls', { path: 'notes', limit: 1 });
		expect(ls).toMatchObject({ path: 'notes', offset: 0, nextOffset: 1, total: 2 });
		expect(await run('webdav_read', { path: 'notes/n.md', offset: 2, limit: 1 })).toEqual({
			path: 'notes/n.md',
			offset: 2,
			lines: [{ line: 2, text: 'l2' }],
			totalLines: 3,
			nextOffset: 3,
		});
		await expect(run('webdav_read', { path: 'notes/p.png' })).rejects.toThrow(
			'Not a text file',
		);
	});

	it('writes new files with their folders and never overwrites unasked', async () => {
		expect(await run('webdav_write', { path: 'x/y/new.md', content: '안녕' })).toEqual({
			path: 'x/y/new.md',
			operation: 'created',
			characters: 2,
		});
		expect(text(dav.files.get('x/y/new.md')!)).toBe('안녕');
		await expect(run('webdav_write', { path: 'x/y/new.md', content: 'z' })).rejects.toThrow(
			'File already exists: x/y/new.md. Set overwrite to true to replace it.',
		);
		expect(text(dav.files.get('x/y/new.md')!)).toBe('안녕');
		await expect(run('webdav_write', { path: 'x/y', content: 'z' })).rejects.toThrow(
			'A folder exists at x/y',
		);
		const over = await run('webdav_write', {
			path: 'x/y/new.md',
			content: 'z',
			overwrite: true,
		});
		expect(over.operation).toBe('overwritten');
		expect(text(dav.files.get('x/y/new.md')!)).toBe('z');
	});

	it('edits one exact match and leaves the file alone otherwise', async () => {
		dav.seed('e.md', '\uFEFFa b a');
		await expect(
			run('webdav_edit', { path: 'e.md', old_text: 'a', new_text: 'c' }),
		).rejects.toThrow('matches 2 places');
		await expect(
			run('webdav_edit', { path: 'e.md', old_text: 'q', new_text: 'c' }),
		).rejects.toThrow('old_text was not found');
		expect(await run('webdav_edit', { path: 'e.md', old_text: 'b', new_text: 'B' })).toEqual({
			path: 'e.md',
			replacements: 1,
			changed: true,
		});
		// The byte order mark survives the round trip.
		expect(text(dav.files.get('e.md')!)).toBe('a B a');
		expect([...dav.files.get('e.md')!.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	});

	it('refuses to write over a file that changed after it was read', async () => {
		dav.seed('race.md', 'one');
		const original = dav.handle.bind(dav);
		dav.handle = async (req) => {
			const res = await original(req);
			// Someone else saves the file between the edit's read and its write.
			if (req.method === 'GET') dav.seed('race.md', 'two');
			return res;
		};
		await expect(
			run('webdav_edit', { path: 'race.md', old_text: 'one', new_text: 'three' }),
		).rejects.toThrow('The file changed on the storage. Read it again and retry.');
		expect(text(dav.files.get('race.md')!)).toBe('two');
	});

	it('creates nested folders, moves without overwriting and deletes folders', async () => {
		expect(await run('webdav_mkdir', { path: 'p/q/r' })).toEqual({
			path: 'p/q/r',
			created: true,
		});
		expect(await run('webdav_mkdir', { path: 'p/q' })).toEqual({ path: 'p/q', created: false });
		dav.seed('p/f.md', 'f');
		await expect(run('webdav_mkdir', { path: 'p/f.md' })).rejects.toThrow('A file exists');

		dav.seed('p/q/r/deep.md', 'deep');
		expect(await run('webdav_move', { from: 'p/q', to: 'moved/q2' })).toEqual({
			from: 'p/q',
			to: 'moved/q2',
		});
		expect(text(dav.files.get('moved/q2/r/deep.md')!)).toBe('deep');
		dav.seed('moved/taken.md', 't');
		await expect(run('webdav_move', { from: 'p/f.md', to: 'moved/taken.md' })).rejects.toThrow(
			'Already exists: moved/taken.md',
		);
		expect(text(dav.files.get('p/f.md')!)).toBe('f');

		expect(await run('webdav_delete', { path: 'moved' })).toEqual({
			path: 'moved',
			deleted: true,
		});
		expect([...dav.files.keys()]).toEqual(['p/f.md']);
		await expect(run('webdav_delete', { path: '/' })).rejects.toThrow('root cannot be deleted');
	});
});

describe('download and upload (LIB-TEST-154)', () => {
	const allBytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));

	it('downloads a folder byte for byte, skips existing files and snapshots each new one', async () => {
		dav.seed('docs/a.md', '# A');
		dav.seed('docs/img/p.png', allBytes);
		dav.folders.add('docs/empty');
		const first = await run('webdav_download', { path: 'docs', vault_path: 'Inbox/docs' });
		expect(first).toEqual({
			path: 'docs',
			vault_path: 'Inbox/docs',
			files: ['Inbox/docs/a.md', 'Inbox/docs/img/p.png'],
			skipped: [],
		});
		expect(text(app.vault.bytes('Inbox/docs/a.md')!)).toBe('# A');
		expect([...app.vault.bytes('Inbox/docs/img/p.png')!]).toEqual([...allBytes]);
		expect(hooks.before).toEqual(['Inbox/docs/a.md', 'Inbox/docs/img/p.png']);
		expect(hooks.after).toEqual(hooks.before);

		const again = await run('webdav_download', { path: 'docs', vault_path: 'Inbox/docs' });
		expect(again.files).toEqual([]);
		expect(again.skipped).toEqual([
			{ path: 'Inbox/docs/a.md', reason: 'File already exists in the vault' },
			{ path: 'Inbox/docs/img/p.png', reason: 'File already exists in the vault' },
		]);

		const one = await run('webdav_download', { path: 'docs/a.md', vault_path: 'Inbox' });
		expect(one.files).toEqual(['Inbox/a.md']);
		await expect(
			run('webdav_download', { path: 'docs/a.md', vault_path: '.obsidian/x' }),
		).rejects.toThrow('Hidden paths are read-only');
	});

	it('uploads a folder byte for byte and overwrites only when asked', async () => {
		app.vault.seed('out/n.md', 'note');
		app.vault.seedBinary('out/sub/b.bin', allBytes.slice().buffer);
		const first = await run('webdav_upload', { vault_path: 'out', path: 'backup/out' });
		expect(first).toEqual({
			vault_path: 'out',
			path: 'backup/out',
			files: ['backup/out/n.md', 'backup/out/sub/b.bin'],
			skipped: [],
		});
		expect([...dav.files.get('backup/out/sub/b.bin')!]).toEqual([...allBytes]);

		dav.seed('backup/out/n.md', 'changed on the NAS');
		const kept = await run('webdav_upload', { vault_path: 'out', path: 'backup/out' });
		expect(kept.files).toEqual([]);
		expect(kept.skipped).toEqual([
			{ path: 'backup/out/n.md', reason: 'File already exists on the storage' },
			{ path: 'backup/out/sub/b.bin', reason: 'File already exists on the storage' },
		]);
		expect(text(dav.files.get('backup/out/n.md')!)).toBe('changed on the NAS');
		const replaced = await run('webdav_upload', {
			vault_path: 'out',
			path: 'backup/out',
			overwrite: true,
		});
		expect(replaced.files.length).toBe(2);
		expect(text(dav.files.get('backup/out/n.md')!)).toBe('note');

		await app.vault.createFolder('empty-dir');
		await run('webdav_upload', { vault_path: 'empty-dir', path: 'empty-dir' });
		expect(dav.folders.has('empty-dir')).toBe(true);

		await run('webdav_upload', { vault_path: 'out/n.md', path: 'backup' });
		expect(text(dav.files.get('backup/n.md')!)).toBe('note');
	});

	it('stops between files when the turn is stopped', async () => {
		dav.seed('many/1.md', '1');
		dav.seed('many/2.md', '2');
		const controller = new AbortController();
		const original = dav.handle.bind(dav);
		dav.handle = async (req) => {
			const res = await original(req);
			if (req.method === 'GET') controller.abort();
			return res;
		};
		await expect(
			run(
				'webdav_download',
				{ path: 'many', vault_path: 'many' },
				{ signal: controller.signal },
			),
		).rejects.toThrow('Operation aborted');
		expect(app.vault.getFileByPath('many/2.md')).toBeNull();
	});
});

describe('tool card summaries (LIB-TEST-153)', () => {
	it('reads each storage call in one line, in the direction the bytes move', () => {
		expect(summarizeCall('webdav_ls', { path: 'docs' }, '{"total":3}')).toBe('docs, 3 entries');
		expect(summarizeCall('webdav_move', { from: 'a.md', to: 'b/a.md' }, null)).toBe(
			'a.md to b/a.md',
		);
		expect(
			summarizeCall(
				'webdav_download',
				{ path: 'docs', vault_path: 'Inbox' },
				'{"files":["x"]}',
			),
		).toBe('docs to Inbox, 1 file');
		expect(summarizeCall('webdav_upload', { vault_path: 'out', path: '' }, null)).toBe(
			'out to /',
		);
		expect(summarizeCall('webdav_delete', { path: 'old' }, null)).toBe('old');
	});
});
