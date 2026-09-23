import { JSDOM } from 'jsdom';
import type { App, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolPermissionManager } from '../src/permissions/tool-permission-manager';
import {
	commandPermissionKey,
	createCommandTools,
	DID_NOT_RUN,
	NO_COMMANDS,
} from '../src/tools/commands';
import {
	createHttpRequestTool,
	httpPermissionKey,
	pageToMarkdown,
} from '../src/tools/http-request';
import { mergeSettings } from '../src/types';
import { noteVisibility } from '../src/visibility';

// The page converter parses with the platform's DOMParser; Node has none, jsdom lends one.
(globalThis as unknown as { DOMParser: unknown }).DOMParser = new JSDOM().window.DOMParser;

const encode = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function response(status: number, body: string | ArrayBuffer, contentType: string, extra = {}) {
	const bytes = typeof body === 'string' ? encode(body) : body;
	return {
		status,
		headers: { 'Content-Type': contentType, 'Set-Cookie': 'a=b', ...extra },
		arrayBuffer: bytes,
		text: typeof body === 'string' ? body : '',
		json: null,
	} as unknown as RequestUrlResponse;
}

function http(reply: (req: RequestUrlParam) => Promise<RequestUrlResponse>) {
	const sent: RequestUrlParam[] = [];
	const tool = createHttpRequestTool({
		settings: () => mergeSettings({}),
		request: (req) => {
			sent.push(req);
			return reply(req);
		},
	});
	const run = async (args: Record<string, unknown>) => {
		const r = await tool.execute('h', args as never, undefined);
		return JSON.parse((r.content[0] as { text: string }).text) as Record<string, never>;
	};
	return { sent, run };
}

describe('http_request (LIB-TEST-167)', () => {
	it('sends method, headers and body as given and keeps only the useful headers', async () => {
		const h = http(async () =>
			response(201, '{"id":7}', 'application/json', {
				'X-RateLimit-Remaining': '9',
				Server: 'x',
			}),
		);
		const r = await h.run({
			url: 'https://api.test/items',
			method: 'POST',
			headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
			body: '{"a":1}',
		});
		expect(h.sent[0]).toMatchObject({
			url: 'https://api.test/items',
			method: 'POST',
			headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
			body: '{"a":1}',
			throw: false,
		});
		expect(r).toEqual({
			url: 'https://api.test/items',
			status: 201,
			headers: { 'Content-Type': 'application/json', 'X-RateLimit-Remaining': '9' },
			body: '{"id":7}',
			bodyLength: 8,
		});
	});

	it('returns text bodies, only the size of binary ones, and 404 as a result', async () => {
		const png = http(async () => response(200, new ArrayBuffer(4), 'image/png'));
		expect(await png.run({ url: 'https://x.test/a.png' })).toMatchObject({
			contentType: 'image/png',
			bytes: 4,
		});
		const txt = http(async () => response(404, 'nope', 'text/plain; charset=utf-8'));
		expect(await txt.run({ url: 'https://x.test/a' })).toMatchObject({
			status: 404,
			body: 'nope',
		});
	});

	it('refuses other schemes without sending, and gives up after the timeout', async () => {
		const h = http(() => new Promise(() => {}));
		await expect(h.run({ url: 'file:///etc/passwd' })).rejects.toThrow('Only http and https');
		await expect(h.run({ url: 'ftp://x' })).rejects.toThrow('Only http and https');
		expect(h.sent.length).toBe(0);
		await expect(h.run({ url: 'https://slow.test', timeout: 1 })).rejects.toThrow(
			'No response after 1 seconds',
		);
		expect(h.sent.length).toBe(1);
	});

	it('pages a long body with offset and nextOffset', async () => {
		const h = http(async () => response(200, 'x'.repeat(250), 'text/plain'));
		const first = await h.run({ url: 'https://x.test', max_chars: 100 });
		expect(first).toMatchObject({ bodyLength: 250, nextOffset: 100 });
		expect(first.body).toHaveLength(100);
		const last = await h.run({ url: 'https://x.test', max_chars: 100, offset: 200 });
		expect(last).toMatchObject({ offset: 200, bodyLength: 250 });
		expect(last).not.toHaveProperty('nextOffset');
	});

	it('reads a web page as Markdown with absolute links it can follow', async () => {
		const html = `<html><head><title> Docs </title><script>alert(1)</script></head><body>
			<nav><a href="/menu">Menu</a></nav>
			<main><h1>Guide</h1><p>See <a href="part-2.html#top">part 2</a> and
			<a href="https://other.test/x">other</a>.</p><p><a href="#section">jump</a></p></main>
			<footer>foot</footer></body></html>`;
		const page = pageToMarkdown(html, 'https://docs.test/guide/index.html');
		expect(page.title).toBe('Docs');
		expect(page.markdown).toContain('[part 2](https://docs.test/guide/part-2.html#top)');
		expect(page.markdown).not.toContain('alert');
		expect(page.markdown).not.toContain('Menu');
		expect(page.markdown).not.toContain('foot');
		expect(page.links.map((l) => l.url)).toEqual([
			'https://docs.test/menu',
			'https://docs.test/guide/part-2.html#top',
			'https://other.test/x',
		]);
		const h = http(async () => response(200, html, 'text/html; charset=utf-8'));
		const r = await h.run({
			url: 'https://docs.test/guide/index.html',
			format: 'markdown',
			links: true,
		});
		expect(r).toMatchObject({ title: 'Docs', linkCount: 3 });
		expect(r.body).toContain('Guide');
	});

	it('keys permissions by site, inherits the tool row, and a blocked row wins', () => {
		expect(httpPermissionKey({ url: 'https://api.test/a?b=1' })).toBe('http:https://api.test');
		expect(httpPermissionKey({ url: 'http://nas.lan:8080/x' })).toBe(
			'http:http://nas.lan:8080',
		);
		expect(httpPermissionKey({ url: 'nope' })).toBeNull();
		const settings = mergeSettings({});
		const perms = new ToolPermissionManager(
			() => settings,
			async () => {},
		);
		perms.attachExtras(
			() => [],
			() => new Set(),
			(tool, args) => (tool === 'http_request' ? httpPermissionKey(args) : null),
		);
		const a = { url: 'https://a.test/x' };
		const b = { url: 'https://b.test/x' };
		settings.toolPermissions.byTool['http:https://a.test'] = 'always_allow';
		expect(perms.resolve('http_request', a)).toBe('always_allow');
		expect(perms.resolve('http_request', b)).toBe('approval_required');
		settings.toolPermissions.byTool.http_request = 'always_allow';
		expect(perms.resolve('http_request', b)).toBe('always_allow');
		settings.toolPermissions.byTool['http:https://b.test'] = 'blocked';
		expect(perms.resolve('http_request', b)).toBe('blocked');
		settings.toolPermissions.byTool.http_request = 'blocked';
		expect(perms.resolve('http_request', a)).toBe('blocked');
	});

	describe('while the app is away', () => {
		const g = globalThis as unknown as { document?: { visibilityState: string } };
		const set = (state: string) => {
			g.document = { visibilityState: state };
			noteVisibility();
		};
		afterEach(() => {
			delete g.document;
			noteVisibility();
		});

		it('resends a GET once the app is back but never a POST', async () => {
			set('visible');
			let calls = 0;
			const h = http(async () => {
				if (++calls === 1) {
					set('hidden');
					setTimeout(() => set('visible'), 5);
					throw new Error('net::ERR_NETWORK_IO_SUSPENDED');
				}
				return response(200, 'ok', 'text/plain');
			});
			expect(await h.run({ url: 'https://x.test' })).toMatchObject({ status: 200 });
			expect(calls).toBe(2);
			calls = 0;
			set('visible');
			await expect(h.run({ url: 'https://x.test', method: 'POST' })).rejects.toThrow(
				/unknown whether the server ran this call/,
			);
			expect(calls).toBe(1);
		});
	});
});

describe('Obsidian commands (LIB-TEST-168)', () => {
	function commands(withRegistry = true) {
		const ran: string[] = [];
		const app = withRegistry
			? {
					commands: {
						commands: {
							'editor:toggle-bold': { id: 'editor:toggle-bold', name: 'Toggle bold' },
							'app:toggle-left-sidebar': {
								id: 'app:toggle-left-sidebar',
								name: 'Toggle left sidebar',
							},
							'daily-notes': { id: 'daily-notes', name: "Open today's daily note" },
							'workspace:close': { id: 'workspace:close', name: 'Close current tab' },
						},
						executeCommandById: (id: string) => {
							ran.push(id);
							return id !== 'editor:toggle-bold';
						},
					},
				}
			: {};
		const [list, run] = createCommandTools(app as unknown as App);
		const call = async (t: typeof list, args: Record<string, unknown>) =>
			JSON.parse(
				((await t!.execute('c', args as never)).content[0] as { text: string }).text,
			);
		return { ran, list: (a = {}) => call(list, a), run: (a = {}) => call(run, a) };
	}

	it('lists by name, filters and limits', async () => {
		const c = commands();
		const all = await c.list();
		expect(all.commands.map((x: { name: string }) => x.name)).toEqual([
			'Close current tab',
			"Open today's daily note",
			'Toggle bold',
			'Toggle left sidebar',
		]);
		expect((await c.list({ query: 'toggle' })).total).toBe(2);
		const one = await c.list({ limit: 1 });
		expect(one.commands).toHaveLength(1);
		expect(one.total).toBe(4);
	});

	it('runs by id and says when a command did not run', async () => {
		const c = commands();
		expect(await c.run({ id: 'app:toggle-left-sidebar' })).toEqual({
			id: 'app:toggle-left-sidebar',
			name: 'Toggle left sidebar',
			ran: true,
		});
		expect(await c.run({ id: 'editor:toggle-bold' })).toMatchObject({
			ran: false,
			note: DID_NOT_RUN,
		});
		await expect(c.run({ id: 'nope' })).rejects.toThrow('Unknown command: nope');
		expect(c.ran).toEqual(['app:toggle-left-sidebar', 'editor:toggle-bold']);
		const none = commands(false);
		await expect(none.list()).rejects.toThrow(NO_COMMANDS);
		await expect(none.run({ id: 'x' })).rejects.toThrow(NO_COMMANDS);
	});

	it('keys permissions by command', () => {
		expect(commandPermissionKey({ id: 'app:toggle-left-sidebar' })).toBe(
			'command:app:toggle-left-sidebar',
		);
		expect(commandPermissionKey({})).toBeNull();
	});
});
