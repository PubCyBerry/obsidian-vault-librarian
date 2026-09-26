import http from 'node:http';
import type { App } from 'obsidian';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpModule } from '../src/mcp/loopback';
import { McpManager } from '../src/mcp/mcp-manager';
import { oauthSecretId } from '../src/mcp/oauth-provider';
import { adapterSignInFiles, SharedSignIns, type SignInFiles } from '../src/mcp/shared-signin';
import { ToolPermissionManager } from '../src/permissions/tool-permission-manager';
import { PASSPHRASE_ID, SecretStore } from '../src/storage/secret-store';
import { mergeSettings } from '../src/types';
import { FakeApp, FakeVault } from './fake-app';

const MCP = 'https://mcp.example/mcp';
const DIR = '.obsidian/plugins/vault-librarian/signins';
const realFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
	for (let i = 0; i < 300; i++) {
		if (await check()) return;
		await sleep(10);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * An MCP server behind an authorization server that replaces the refresh token on every use, as
 * Atlassian and Outline do. Each sign-in is a chain of its own: only its newest access token is
 * accepted, and a refresh with a refresh token it replaced is refused and counted.
 */
function rotatingServer() {
	const s = {
		n: 0,
		grants: 0,
		lifetime: 3600,
		registrations: 0,
		refreshes: [] as string[],
		reused: 0,
	};
	const chains = new Map<string, { access: string; refresh: string }>();
	const issue = (chain: string) => {
		s.n++;
		chains.set(chain, { access: `a${s.n}`, refresh: `r${s.n}` });
		return {
			access_token: `a${s.n}`,
			token_type: 'Bearer',
			expires_in: s.lifetime,
			refresh_token: `r${s.n}`,
		};
	};
	const accepted = (header: string | null) =>
		[...chains.values()].some((c) => header === `Bearer ${c.access}`);
	const fetchFn = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === MCP && init?.method === 'GET') return new Response(null, { status: 405 });
		if (url === MCP) {
			if (!accepted(new Headers(init?.headers).get('authorization')))
				return new Response('Unauthorized', {
					status: 401,
					headers: {
						'www-authenticate':
							'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
					},
				});
			const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
			if (message.method === 'initialize')
				return json({
					jsonrpc: '2.0',
					id: message.id,
					result: {
						protocolVersion: '2025-06-18',
						capabilities: { tools: {} },
						serverInfo: { name: 'fake', version: '1' },
					},
				});
			if (message.method === 'tools/list')
				return json({
					jsonrpc: '2.0',
					id: message.id,
					result: {
						tools: [
							{
								name: 'search',
								inputSchema: { type: 'object' },
								annotations: { readOnlyHint: true },
							},
						],
					},
				});
			if (message.method === 'tools/call')
				return json({
					jsonrpc: '2.0',
					id: message.id,
					result: { content: [{ type: 'text', text: 'found' }] },
				});
			return new Response(null, { status: 202 });
		}
		if (url.includes('oauth-protected-resource'))
			return json({ resource: MCP, authorization_servers: ['https://auth.example'] });
		if (url.startsWith('https://auth.example/.well-known/'))
			return json({
				issuer: 'https://auth.example',
				authorization_endpoint: 'https://auth.example/authorize',
				token_endpoint: 'https://auth.example/token',
				registration_endpoint: 'https://auth.example/register',
				response_types_supported: ['code'],
				code_challenge_methods_supported: ['S256'],
			});
		if (url === 'https://auth.example/register') {
			s.registrations++;
			const asked = JSON.parse(String(init?.body)) as { redirect_uris: string[] };
			return json(
				{ client_id: `c${s.registrations}`, redirect_uris: asked.redirect_uris },
				201,
			);
		}
		if (url === 'https://auth.example/token') {
			const body = new URLSearchParams(String(init?.body));
			if (body.get('grant_type') === 'authorization_code')
				return json(issue(`g${++s.grants}`));
			const refresh = body.get('refresh_token') ?? '';
			s.refreshes.push(refresh);
			const chain = [...chains].find(([, c]) => c.refresh === refresh)?.[0];
			if (!chain) {
				s.reused++;
				return json({ error: 'invalid_grant' }, 400);
			}
			return json(issue(chain));
		}
		return new Response('not found', { status: 404 });
	}) as typeof fetch;
	/** Every access token in use stops being accepted, as when they expire. */
	const expire = () => {
		for (const chain of chains.values()) chain.access = `expired-${chain.access}`;
	};
	/** A sign-in made apart from the test's desktop, as one a phone made on its own. */
	const signInApart = () => issue(`g${++s.grants}`);
	return { s, fetchFn, expire, signInApart };
}

/** Two or more devices: one settings object and one folder stand for what the sync carries. */
function devices() {
	const settings = mergeSettings({
		mcpServers: [
			{ id: 'srv', name: 'Server', url: MCP, auth: 'oauth', enabled: true, toolHashes: {} },
		],
	});
	const synced = new FakeVault();
	const files = adapterSignInFiles(synced.adapter, DIR);
	const device = (id: string, loopback: boolean, folder: SignInFiles = files) => {
		const app = new FakeApp();
		app.secretStorage.setSecret(PASSPHRASE_ID, 'same words');
		const secrets = new SecretStore(app as unknown as App, {
			read: () => settings.sealedSecrets,
			write: async (sealed) => {
				settings.sealedSecrets = sealed;
			},
			ids: () => [],
		});
		const opened: string[] = [];
		const manager = new McpManager({
			settings: () => settings,
			save: async () => undefined,
			secrets,
			permissions: new ToolPermissionManager(
				() => settings,
				async () => undefined,
			),
			clientVersion: 'test',
			open: (url) => opened.push(url),
			notice: () => {},
			loopback: loopback ? () => http as unknown as HttpModule : undefined,
			deviceId: () => id,
			shared: new SharedSignIns({
				files: folder,
				seal: (text) => secrets.seal(text),
				unseal: (sealed) => secrets.unseal(sealed),
				deviceId: () => id,
			}),
		});
		const stored = () =>
			JSON.parse(app.secretStorage.getSecret(oauthSecretId('srv')) ?? '{}') as {
				tokens?: { refresh_token?: string };
				from?: string;
			};
		const call = () => {
			const tool = manager.tools().find((t) => t.name === 'srv__search');
			if (!tool) throw new Error(`${id} has no search tool`);
			return tool.execute('call', {}, undefined);
		};
		return { app, secrets, manager, opened, stored, call };
	};
	return { settings, synced, files, device };
}

const copies = async (synced: FakeVault) =>
	(await synced.adapter.exists(`${DIR}/srv`))
		? (await synced.adapter.list(`${DIR}/srv`)).files.map((f) => f.split('/').pop())
		: [];
/** A device's copy as the sync carries it; empty text while there is none. */
const text = async (synced: FakeVault, device: string) =>
	(await synced.adapter.exists(`${DIR}/srv/${device}.json`))
		? await synced.adapter.read(`${DIR}/srv/${device}.json`)
		: '';
const record = async (synced: FakeVault, device: string) =>
	JSON.parse((await text(synced, device)) || '{}') as {
		device: string;
		at: number;
		grant: string;
		sealed?: string;
	};
/**
 * Waits for a device's copy made after `before`, the text of an earlier copy or '' for none: by
 * its time, since the same sign-in written twice differs in text alone.
 */
const newCopy = (synced: FakeVault, device: string, before: string) => {
	const since = before ? (JSON.parse(before) as { at: number }).at : -1;
	return until(async () => {
		const now = await text(synced, device);
		return now !== '' && (JSON.parse(now) as { at: number }).at > since;
	}, `a new copy from ${device}`);
};

/** Signs a desktop in through its loopback, answering as the browser would, and waits for its copy. */
async function signInOnDesktop(
	desk: { manager: McpManager; opened: string[] },
	synced: FakeVault,
): Promise<void> {
	const before = await text(synced, 'desk');
	const signingIn = desk.manager.signIn('srv');
	await until(() => desk.opened.length > 0, 'the browser to open');
	const asked = new URL(desk.opened[0]!).searchParams;
	const back = new URL(asked.get('redirect_uri')!);
	back.searchParams.set('code', 'the-code');
	back.searchParams.set('state', asked.get('state')!);
	expect((await realFetch(back)).status).toBe(200);
	await signingIn;
	await until(() => desk.manager.state('srv').status === 'ready', 'the desktop to connect');
	await newCopy(synced, 'desk', before);
}

describe('one sign-in shared by every device (LIB-TEST-290)', () => {
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it('a desktop sign-in reaches the phone, which connects with it and shares nothing it only took', async () => {
		const server = rotatingServer();
		globalThis.fetch = server.fetchFn;
		(globalThis as { window?: unknown }).window ??= globalThis;
		const { synced, device } = devices();
		const desk = device('desk', true);
		const phone = device('phone', false);
		await desk.secrets.unlock();
		await phone.secrets.unlock();

		await signInOnDesktop(desk, synced);
		const copy = await record(synced, 'desk');
		expect(copy).toMatchObject({ device: 'desk', sealed: expect.stringMatching(/^enc1\./) });
		// Sealed: neither token can be read off the synced file.
		expect(JSON.stringify(copy)).not.toMatch(/"r1"|"a1"/);

		const registered = server.s.registrations;
		await phone.manager.connect('srv');
		expect(phone.manager.state('srv').status).toBe('ready');
		expect(server.s.registrations).toBe(registered);
		expect(phone.stored()).toMatchObject({ tokens: { refresh_token: 'r1' }, from: 'desk' });
		expect(await phone.call()).toMatchObject({
			content: [{ text: expect.stringContaining('found') }],
		});
		await sleep(50);
		expect(await copies(synced)).toEqual(['desk.json']);
	});

	it('a refresh follows the newest sign-in, so no replaced refresh token is sent again', async () => {
		const server = rotatingServer();
		globalThis.fetch = server.fetchFn;
		(globalThis as { window?: unknown }).window ??= globalThis;
		const { synced, device } = devices();
		const desk = device('desk', true);
		const phone = device('phone', false);
		await desk.secrets.unlock();
		await phone.secrets.unlock();
		await signInOnDesktop(desk, synced);
		await phone.manager.connect('srv');
		expect(phone.manager.state('srv').status).toBe('ready');

		// The phone's call finds the access token expired, refreshes r1 and shares what came back.
		server.expire();
		await phone.call();
		expect(server.s.refreshes).toEqual(['r1']);
		expect(phone.stored()).toMatchObject({ tokens: { refresh_token: 'r2' }, from: 'phone' });
		await newCopy(synced, 'phone', '');

		// The desktop still holds r1, which the server replaced. Its next calls, two reads side by
		// side, take the phone's sign-in, whose access token still lasts, and ask the server for
		// nothing: the one that did not take it answers from what the other took.
		await Promise.all([desk.call(), desk.call()]);
		expect(server.s.refreshes).toEqual(['r1']);
		expect(desk.stored()).toMatchObject({ tokens: { refresh_token: 'r2' }, from: 'phone' });

		// With little of its access token left, the newest sign-in's refresh token is the one sent.
		server.s.lifetime = 30;
		server.expire();
		const deskBefore = await text(synced, 'desk');
		await desk.call();
		await newCopy(synced, 'desk', deskBefore);
		server.expire();
		await phone.call();
		expect(server.s.refreshes).toEqual(['r1', 'r2', 'r3']);
		expect(server.s.reused).toBe(0);
		expect(phone.stored()).toMatchObject({ tokens: { refresh_token: 'r4' }, from: 'phone' });
	});

	it('a sign-out on one device signs the others out', async () => {
		const server = rotatingServer();
		globalThis.fetch = server.fetchFn;
		(globalThis as { window?: unknown }).window ??= globalThis;
		const { synced, device } = devices();
		const desk = device('desk', true);
		const phone = device('phone', false);
		await desk.secrets.unlock();
		await phone.secrets.unlock();
		await signInOnDesktop(desk, synced);
		await phone.manager.connect('srv');
		expect(phone.manager.signedIn('srv')).toBe(true);

		await desk.manager.signOut('srv');
		expect(await record(synced, 'desk')).toMatchObject({ device: 'desk' });
		expect((await record(synced, 'desk')).sealed).toBeUndefined();
		await phone.manager.connect('srv');
		expect(phone.manager.signedIn('srv')).toBe(false);
		expect(phone.manager.state('srv')).toMatchObject({
			status: 'needs-sign-in',
			message: 'Signed out on another device. Sign in again.',
		});

		// Signing in again on the desktop is newer than the sign-out, and reaches the phone.
		desk.opened.length = 0;
		await signInOnDesktop(desk, synced);
		expect((await record(synced, 'desk')).sealed).toMatch(/^enc1\./);
		await phone.manager.retryShared();
		expect(phone.manager.state('srv').status).toBe('ready');
	});

	it('a device keeps a sign-in of its own that works, and one without takes the newest shared one', async () => {
		const server = rotatingServer();
		globalThis.fetch = server.fetchFn;
		(globalThis as { window?: unknown }).window ??= globalThis;
		const { synced, device } = devices();
		const desk = device('desk', true);
		const phone = device('phone', false);
		const tablet = device('tablet', false);
		for (const d of [desk, phone, tablet]) await d.secrets.unlock();

		// The phone signed in on its own before, as Outline lets a phone do.
		const own = server.signInApart();
		phone.app.secretStorage.setSecret(
			oauthSecretId('srv'),
			JSON.stringify({ client: { client_id: 'cp' }, tokens: own }),
		);
		await signInOnDesktop(desk, synced);

		// The tablet has none: it takes the newest live one, the desktop's.
		await tablet.manager.connect('srv');
		expect(tablet.manager.state('srv').status).toBe('ready');
		expect(tablet.stored()).toMatchObject({ from: 'desk' });

		// The phone keeps its own, though the desktop's is newer.
		await phone.manager.connect('srv');
		expect(phone.manager.state('srv').status).toBe('ready');
		expect(phone.stored()).toMatchObject({
			tokens: { refresh_token: own.refresh_token },
			from: 'phone',
		});
		// It is shared too, with an id of its own. Made before sharing began, it is dated the
		// moment it is shared, so a device without a sign-in would now take it.
		await newCopy(synced, 'phone', '');
		expect((await record(synced, 'phone')).grant).not.toBe(
			(await record(synced, 'desk')).grant,
		);

		// A sign-out ends the sign-in on the devices that share it, not the phone's own.
		await desk.manager.signOut('srv');
		await phone.manager.connect('srv');
		await tablet.manager.connect('srv');
		expect(phone.manager.state('srv').status).toBe('ready');
		expect(tablet.manager.state('srv').status).toBe('needs-sign-in');
	});

	it('a device refused for a token another device replaced connects once that sign-in arrives', async () => {
		const server = rotatingServer();
		globalThis.fetch = server.fetchFn;
		(globalThis as { window?: unknown }).window ??= globalThis;
		const { synced, device } = devices();
		const desk = device('desk', true);
		const phone = device('phone', false);
		await desk.secrets.unlock();
		await phone.secrets.unlock();
		await signInOnDesktop(desk, synced);
		await phone.manager.connect('srv');
		expect(phone.manager.state('srv').status).toBe('ready');

		// The desktop refreshes r1; its new copy is still on the way to the phone.
		const signedIn = await text(synced, 'desk');
		server.expire();
		await desk.call();
		await newCopy(synced, 'desk', signedIn);
		const refreshed = await text(synced, 'desk');
		await synced.adapter.write(`${DIR}/srv/desk.json`, signedIn);

		// The phone refreshes r1 too, which the server refuses: that is the cost of a slow sync.
		server.expire();
		await expect(phone.call()).rejects.toThrow();
		expect(server.s.reused).toBe(1);
		await phone.manager.connect('srv');
		expect(phone.manager.state('srv').status).toBe('needs-sign-in');

		// The sync brings the desktop's copy; waiting for a sign-in, the phone takes it.
		await synced.adapter.write(`${DIR}/srv/desk.json`, refreshed);
		await phone.manager.retryShared();
		expect(phone.manager.state('srv').status).toBe('ready');
		expect(phone.stored()).toMatchObject({ from: 'phone' });
	});
});

describe('shared sign-in files (LIB-TEST-290)', () => {
	it('keeps the newest copy of each sign-in it can open, and skips broken ones and older copies the sync made', async () => {
		const texts = new Map<string, string>();
		const files: SignInFiles = {
			list: async () => [...texts.keys()],
			read: async (path) => texts.get(path) ?? null,
			write: async (_server, device, text) => {
				texts.set(`${device}.json`, text);
			},
			remove: async (_server, device) => {
				texts.delete(`${device}.json`);
			},
		};
		const sealer = (words: string) => ({
			seal: async (text: string) => `${words}:${text}`,
			unseal: async (sealed: string) =>
				sealed.startsWith(`${words}:`) ? sealed.slice(words.length + 1) : null,
		});
		const shared = new SharedSignIns({ files, ...sealer('ours'), deviceId: () => 'phone' });
		const tokens = (refresh: string) => ({
			access_token: 'a',
			token_type: 'Bearer',
			refresh_token: refresh,
		});
		const sign = (words: string, refresh: string) =>
			`${words}:${JSON.stringify({ client: { client_id: 'c1' }, tokens: tokens(refresh) })}`;
		texts.set(
			'desk.json',
			JSON.stringify({ device: 'desk', at: 20, grant: 'g1', sealed: sign('ours', 'r2') }),
		);
		texts.set(
			'desk (conflict 2026-09-27-01-00-00).json',
			JSON.stringify({ device: 'desk', at: 10, grant: 'g1', sealed: sign('ours', 'r1') }),
		);
		// Sealed with another passphrase: this device cannot use it.
		texts.set(
			'laptop.json',
			JSON.stringify({ device: 'laptop', at: 30, grant: 'g2', sealed: sign('theirs', 'r9') }),
		);
		texts.set('broken.json', '{"device":');
		expect(await shared.latest('srv')).toEqual([
			{
				device: 'desk',
				at: 20,
				grant: 'g1',
				stored: { client: { client_id: 'c1' }, tokens: tokens('r2') },
			},
		]);

		await shared.shareSignOut('srv', 40, 'g1');
		expect(await shared.latest('srv')).toEqual([
			{ device: 'phone', at: 40, grant: 'g1', stored: null },
		]);
		await shared.share('srv', {
			client: { client_id: 'c1' },
			tokens: tokens('r5'),
			at: 50,
			grant: 'g3',
		});
		expect((await shared.latest('srv')).map((s) => [s.grant, s.at])).toEqual([
			['g1', 20],
			['g3', 50],
		]);
		await shared.forget('srv');
		expect(texts.has('phone.json')).toBe(false);
	});
});
