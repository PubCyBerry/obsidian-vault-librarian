import { type RequestUrlParam, type RequestUrlResponse, requestUrl } from 'obsidian';
import { AWAY_UNKNOWN, abortable, wasHiddenSince, whenVisible } from '../visibility';

export const WEBDAV_SECRET_ID = 'vault-librarian-webdav';
export const NO_PASSWORD = 'No WebDAV password on this device. Enter it in Settings.';

export type DavRequest = (req: RequestUrlParam) => Promise<RequestUrlResponse>;

export interface DavEntry {
	type: 'file' | 'folder';
	/** Relative to the storage root. */
	path: string;
	size?: number;
	/** ISO 8601. */
	modified?: string;
}

export interface WebDavConfig {
	url: string;
	username: string;
	/** `null` means no password is saved on this device. */
	password: string | null;
	/** Obsidian's `requestUrl` unless a test swaps it. */
	request?: DavRequest;
	/** The tool call's signal: Stop ends every request and wait this client is in. */
	signal?: AbortSignal;
}

const DAV = 'DAV:';
const PROPFIND_BODY =
	'<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';

/**
 * A storage-relative path: '' is the root. Parent traversal and URLs are refused so a call
 * never leaves the folder the user connected.
 */
export function storagePath(raw: string): string {
	if (typeof raw !== 'string') throw new Error('path must be a string');
	if (raw.includes('://')) throw new Error(`Use a path inside the storage, not a URL: ${raw}`);
	const segments = raw
		.trim()
		.replace(/\\/g, '/')
		.split('/')
		.filter((s) => s !== '' && s !== '.');
	if (segments.includes('..')) throw new Error(`Parent traversal is not allowed: ${raw}`);
	return segments.join('/');
}

export function joinPath(folder: string, name: string): string {
	return folder ? `${folder}/${name}` : name;
}

export function parentOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

/** One `<response>` of a multistatus: the last path segment and how deep the href is. */
export interface RawEntry {
	name: string;
	depth: number;
	folder: boolean;
	size?: number;
	modified?: string;
}

function decode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/** First non-empty text of a DAV property; a 404 propstat carries the same name empty. */
function propText(response: Element, name: string): string {
	for (const el of Array.from(response.getElementsByTagNameNS(DAV, name))) {
		const text = el.textContent?.trim();
		if (text) return text;
	}
	return '';
}

/**
 * Reads a PROPFIND multistatus with the platform's XML parser, whatever prefix the server gives
 * the DAV namespace. Entries are placed by href depth rather than by matching the configured URL,
 * so a reverse proxy that rewrites the path prefix does not hide them.
 */
export function parseMultistatus(xml: string): RawEntry[] {
	const doc = new DOMParser().parseFromString(xml, 'application/xml');
	const out: RawEntry[] = [];
	for (const response of Array.from(doc.getElementsByTagNameNS(DAV, 'response'))) {
		const href = response.getElementsByTagNameNS(DAV, 'href')[0]?.textContent?.trim();
		if (!href) continue;
		const segments = new URL(href, 'http://storage.invalid/').pathname
			.split('/')
			.filter(Boolean);
		const folder = response.getElementsByTagNameNS(DAV, 'collection').length > 0;
		const length = propText(response, 'getcontentlength');
		const modified = Date.parse(propText(response, 'getlastmodified'));
		out.push({
			name: decode(segments[segments.length - 1] ?? ''),
			depth: segments.length,
			folder,
			...(!folder && length !== '' && Number.isFinite(Number(length))
				? { size: Number(length) }
				: {}),
			...(Number.isFinite(modified) ? { modified: new Date(modified).toISOString() } : {}),
		});
	}
	return out;
}

function toEntry(path: string, raw: RawEntry): DavEntry {
	return {
		type: raw.folder ? 'folder' : 'file',
		path,
		...(raw.size !== undefined ? { size: raw.size } : {}),
		...(raw.modified ? { modified: raw.modified } : {}),
	};
}

function statusMessage(method: string, path: string, status: number): string {
	switch (status) {
		case 401:
			return 'The storage rejected the user name or password.';
		case 403:
			return `The storage does not allow this: ${path}`;
		case 404:
			return `Not found: ${path}`;
		case 409:
			return `The parent folder does not exist: ${path}`;
		case 412:
			return `Already exists: ${path}`;
		case 423:
			return `Locked: ${path}`;
		case 507:
			return 'The storage is full.';
		default:
			return `${method} ${path || '/'} failed with HTTP ${status}`;
	}
}

function basicAuth(username: string, password: string): string {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return `Basic ${btoa(binary)}`;
}

function header(response: RequestUrlResponse, name: string): string | undefined {
	const key = Object.keys(response.headers ?? {}).find((k) => k.toLowerCase() === name);
	return key ? response.headers[key] : undefined;
}

/**
 * The six WebDAV methods the storage tools need, sent through `requestUrl` because a NAS does not
 * let the Obsidian origin through CORS. Paths are storage-relative (see `storagePath`).
 */
export class WebDavClient {
	private readonly root: string;
	private readonly auth: string | null;
	private readonly request: DavRequest;
	private readonly signal?: AbortSignal;

	constructor(config: WebDavConfig) {
		this.root = config.url.trim().replace(/\/+$/, '');
		if (!this.root) throw new Error('Set the WebDAV URL in Settings.');
		if (config.username && config.password === null) throw new Error(NO_PASSWORD);
		this.auth = config.username ? basicAuth(config.username, config.password ?? '') : null;
		this.request = config.request ?? ((req) => requestUrl(req));
		this.signal = config.signal;
	}

	url(path: string, folder = false): string {
		const encoded = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '';
		return `${this.root}${encoded}${folder ? '/' : ''}`;
	}

	/**
	 * A request that broke while the app was in the background says nothing about the server
	 * (a phone freezes the connection), so it is sent again once the app is back. MOVE is the
	 * exception: the server may already have moved the item.
	 */
	private async send(
		method: string,
		path: string,
		opts: {
			ok: number[];
			folder?: boolean;
			headers?: Record<string, string>;
			body?: string | ArrayBuffer;
			contentType?: string;
		},
	): Promise<RequestUrlResponse> {
		const req: RequestUrlParam = {
			url: this.url(path, opts.folder),
			method,
			headers: { ...(this.auth ? { Authorization: this.auth } : {}), ...opts.headers },
			...(opts.body !== undefined ? { body: opts.body } : {}),
			...(opts.contentType ? { contentType: opts.contentType } : {}),
			throw: false,
		};
		const startedAt = Date.now();
		// requestUrl takes no signal, so Stop is raced against it and against the wait for the app.
		// After Stop nothing new is sent.
		const send = () =>
			this.signal?.aborted
				? Promise.reject(new Error('Operation aborted'))
				: abortable(this.request(req), this.signal);
		let response: RequestUrlResponse;
		let resent = false;
		try {
			response = await send();
		} catch (error) {
			if (this.signal?.aborted || !wasHiddenSince(startedAt)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			if (method === 'MOVE') throw new Error(`${message}. ${AWAY_UNKNOWN}`);
			await whenVisible(this.signal);
			response = await send();
			resent = true;
		}
		if (opts.ok.includes(response.status)) return response;
		// The first DELETE reached the server before the app froze; the item is gone either way.
		if (resent && method === 'DELETE' && response.status === 404) return response;
		throw new Error(statusMessage(method, path, response.status));
	}

	/** The multistatus entries, or null when nothing is at the path. */
	private async propfind(
		path: string,
		depth: '0' | '1',
		folder: boolean,
	): Promise<RawEntry[] | null> {
		const response = await this.send('PROPFIND', path, {
			ok: [207, 404],
			folder,
			headers: { Depth: depth },
			body: PROPFIND_BODY,
			contentType: 'application/xml; charset=utf-8',
		});
		if (response.status === 404) return null;
		const entries = parseMultistatus(response.text);
		if (!entries.length) throw new Error('The storage did not answer with a WebDAV listing.');
		return entries;
	}

	/** One item, or null when nothing is there. */
	async stat(path: string): Promise<DavEntry | null> {
		const entries = await this.propfind(path, '0', path === '');
		if (!entries) return null;
		// The shallowest href is the item itself, whatever prefix a proxy puts in front of it.
		const self = entries.reduce((a, b) => (b.depth < a.depth ? b : a));
		return toEntry(path, self);
	}

	/** Direct children of a folder, sorted by path. */
	async list(path: string): Promise<DavEntry[]> {
		const entries = await this.propfind(path, '1', true);
		const self = entries?.reduce((a, b) => (b.depth < a.depth ? b : a));
		if (!entries || !self?.folder) throw new Error(`Folder not found: ${path || '/'}`);
		return entries
			.filter((e) => e.depth === self.depth + 1)
			.map((e) => toEntry(joinPath(path, e.name), e))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	async get(path: string): Promise<{ data: ArrayBuffer; etag?: string }> {
		const response = await this.send('GET', path, { ok: [200] });
		return { data: response.arrayBuffer, etag: header(response, 'etag') };
	}

	/** With `ifMatch`, a file changed since it was read is left alone. */
	async put(path: string, body: string | ArrayBuffer, ifMatch?: string): Promise<void> {
		const data = typeof body === 'string' ? new TextEncoder().encode(body).buffer : body;
		const response = await this.send('PUT', path, {
			ok: ifMatch ? [200, 201, 204, 412] : [200, 201, 204],
			headers: ifMatch ? { 'If-Match': ifMatch } : {},
			body: data,
			contentType: 'application/octet-stream',
		});
		if (response.status === 412)
			throw new Error('The file changed on the storage. Read it again and retry.');
	}

	/** Creates the folder and any missing parent. False when it was already there. */
	async mkdir(path: string): Promise<boolean> {
		if (!path) return false;
		const existing = await this.stat(path);
		if (existing?.type === 'folder') return false;
		if (existing) throw new Error(`A file exists at ${path}`);
		await this.mkdir(parentOf(path));
		// 405 means something is already there, which a parallel call may just have made.
		await this.send('MKCOL', path, { ok: [201, 405], folder: true });
		return true;
	}

	async remove(path: string, folder: boolean): Promise<void> {
		await this.send('DELETE', path, { ok: [200, 204], folder });
	}

	/** Never overwrites: an existing target fails with "Already exists". */
	async move(from: string, to: string, folder: boolean): Promise<void> {
		const response = await this.send('MOVE', from, {
			ok: [201, 204, 412],
			folder,
			headers: { Destination: this.url(to, folder), Overwrite: 'F' },
		});
		if (response.status === 412) throw new Error(`Already exists: ${to}`);
	}
}
