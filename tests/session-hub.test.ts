import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { ACTIVE_TURNS_KEY, AgentController } from '../src/agent/agent-controller';
import { NestedAgentsMd } from '../src/agent/nested-agents-md';
import { PromptManager } from '../src/agent/prompt';
import { SessionHub } from '../src/agent/session-hub';
import { ContextManager } from '../src/context/context-manager';
import { ToolPermissionManager } from '../src/permissions/tool-permission-manager';
import { ProviderManager } from '../src/provider/provider-manager';
import type { TransportRouter } from '../src/provider/transport';
import { SessionManager } from '../src/session/session-manager';
import { SecretStore } from '../src/storage/secret-store';
import { withFileMutationQueue } from '../src/tools/mutation-queue';
import { createVaultTools } from '../src/tools/registry';
import { mergeSettings, newModel, newProvider, type ToolPermission } from '../src/types';
import { FakeApp } from './fake-app';
import { Platform } from './obsidian-stub';
import { type ScriptedTurn, scriptedStream } from './scripted-stream';

/** A hub whose n-th runtime plays the n-th script, all on one vault and one session store. */
function hubHarness(scripts: ScriptedTurn[][], perms: Record<string, ToolPermission> = {}) {
	const app = new FakeApp();
	app.vault.seed('notes/a.md', 'alpha\nbeta');
	const settings = mergeSettings({
		providers: [
			{
				...newProvider('p'),
				baseUrl: 'https://x',
				models: [{ ...newModel('m'), contextWindow: 100000, maxTokens: 1000 }],
			},
		],
		activeProviderId: 'p',
		activeModelId: 'm',
	});
	for (const tool of Object.keys(settings.toolPermissions.byTool))
		settings.toolPermissions.byTool[tool] = 'always_allow';
	Object.assign(settings.toolPermissions.byTool, perms);
	app.secrets.set('vault-librarian-p', 'key');
	const a = app as unknown as App;
	const sessions = new SessionManager(a, '.obsidian/plugins/vault-librarian');
	const permissions = new ToolPermissionManager(
		() => settings,
		async () => {},
	);
	const notices: string[] = [];
	const requests: unknown[][] = [];
	let made = 0;
	const hub = new SessionHub({
		notify: (message) => notices.push(message),
		create: () => {
			const index = made++;
			const scripted = scriptedStream(scripts[index] ?? []);
			requests[index] = scripted.requests;
			const transport = {
				createStreamFn: () => scripted.streamFn,
				effectiveMode: () => 'fetch',
				hasFallenBack: () => false,
			} as unknown as TransportRouter;
			const controller: AgentController = new AgentController({
				app: a,
				settings: () => settings,
				saveSettings: async () => {},
				sessions,
				context: new ContextManager(a, () => settings.context),
				permissions,
				providers: new ProviderManager(() => settings),
				transport,
				prompt: new PromptManager(a),
				secrets: new SecretStore(a),
				tools: () =>
					createVaultTools({
						app: a,
						settings: () => settings,
						mutation: {
							before: (id, p) => controller.beforeMutation(id, p),
							after: (id, p) => controller.afterMutation(id, p),
						},
					}),
				skillCatalog: () => '',
				nestedAgentsMd: new NestedAgentsMd({
					vault: async () => null,
					storage: () => null,
					activePath: () => null,
				}),
			});
			return controller;
		},
	});
	return { app, hub, sessions, notices, requests };
}

function gate() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function until(check: () => boolean) {
	for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
	expect(check()).toBe(true);
}

/** Stands in for the document so a test can send the app away and bring it back. */
function fakeVisibility() {
	const g = globalThis as unknown as { document?: { visibilityState: string } };
	const had = 'document' in g;
	const previous = g.document;
	g.document = { visibilityState: 'visible' };
	// Only phones and tablets count a hidden page as away.
	Platform.isMobile = true;
	return {
		set(state: 'visible' | 'hidden') {
			g.document = { visibilityState: state };
		},
		restore() {
			Platform.isMobile = false;
			if (had) g.document = previous;
			else delete g.document;
		},
	};
}

const answers = async (h: ReturnType<typeof hubHarness>, runtime: AgentController) =>
	(await h.sessions.load(runtime.session!.id))
		.filter((e) => e.type === 'assistant')
		.map((e) => (e as { content: string }).content);

describe('sessions side by side (LIB-TEST-278)', () => {
	it('1: a session runs on while another is made and sends, each in its own log', async () => {
		const slow = gate();
		const h = hubHarness([[{ text: 'A done', hold: slow.promise }], [{ text: 'B done' }]]);
		const a = h.hub.create();
		const runA = a.send('long job');
		await until(() => h.requests[0]?.length === 1);
		const b = h.hub.create();
		await b.send('quick question');
		expect(a.isRunning).toBe(true);
		slow.open();
		await runA;
		expect(await answers(h, a)).toEqual(['A done']);
		expect(await answers(h, b)).toEqual(['B done']);
		const logA = await h.sessions.load(a.session!.id);
		expect(logA.some((e) => e.type === 'user' && e.content === 'quick question')).toBe(false);
	});

	it('2: opening a session from its log leaves the running one alone', async () => {
		const slow = gate();
		const h = hubHarness([[{ text: 'A done', hold: slow.promise }]]);
		const old = await h.sessions.create({ providerId: 'p', modelId: 'm' });
		await h.sessions.append(old.id, { type: 'user', content: 'earlier' });
		const a = h.hub.create();
		const runA = a.send('long job');
		await until(() => h.requests[0]?.length === 1);
		const c = await h.hub.open(old.id);
		expect(c).not.toBe(a);
		expect(await h.hub.open(old.id)).toBe(c);
		expect(a.isRunning).toBe(true);
		slow.open();
		await runA;
		expect(await answers(h, a)).toEqual(['A done']);
		const logC = await h.sessions.load(old.id);
		expect(logC.some((e) => e.type === 'user' && e.content === 'long job')).toBe(false);
	});

	it('3: Stop in one session leaves another waiting for the app to come back', async () => {
		const vis = fakeVisibility();
		try {
			const died =
				'network error (fetch, after 3.0 s, no response, TypeError: network error)';
			const h = hubHarness([
				[{ stopReason: 'error', errorMessage: died }, { text: 'A after the return' }],
				[{ text: 'never', hold: new Promise(() => {}) }],
			]);
			const a = h.hub.create();
			const runA = a.send('long job');
			vis.set('hidden');
			a.onVisibilityChange();
			await settle();
			expect(h.requests[0]).toHaveLength(1);
			expect(a.isRunning).toBe(true);
			const b = h.hub.create();
			const runB = b.send('other');
			await until(() => h.requests[1]?.length === 1);
			b.stop();
			await runB;
			await settle();
			// Still parked: B's Stop did not wake A while the app is away.
			expect(h.requests[0]).toHaveLength(1);
			expect(a.isRunning).toBe(true);
			vis.set('visible');
			a.onVisibilityChange();
			await runA;
			expect(h.requests[0]).toHaveLength(2);
			expect(await answers(h, a)).toEqual(['A after the return']);
		} finally {
			vis.restore();
		}
	}, 10000);

	it('4: a queue handed back while no chat shows the session waits for one; the failure is marked', async () => {
		const slow = gate();
		const h = hubHarness([
			[{ stopReason: 'error', errorMessage: '500 upstream down', hold: slow.promise }],
		]);
		const a = h.hub.create();
		const runA = a.send('first');
		await until(() => h.requests[0]?.length === 1);
		await a.send('second');
		slow.open();
		await runA;
		const id = a.session!.id;
		expect(h.hub.takeUnsent(id).map((m) => m.text)).toEqual(['second']);
		expect(h.hub.entries()).toEqual([
			expect.objectContaining({ sessionId: id, activity: 'failed', runtime: null }),
		]);
		expect(h.notices).toEqual(['"first" failed: 500 upstream down']);
		expect(h.hub.runtimes).not.toContain(a);
	});

	it('5: a rewind waits for another session changing the same note', async () => {
		const h = hubHarness([
			[
				{ toolCalls: [{ name: 'write', args: { path: 'notes/n.md', content: 'from A' } }] },
				{ text: 'wrote it' },
			],
		]);
		const a = h.hub.create();
		h.hub.show({ isShown: () => true }, a);
		await a.send('write n');
		const start = a.events.find((e) => e.event.type === 'user')!.index;
		// Another session's edit holds the note's queue: its snapshot, change and hash go together.
		const held = gate();
		const other = withFileMutationQueue('notes/n.md', async () => {
			await held.promise;
			const file = h.app.vault.getFileByPath('notes/n.md')!;
			await h.app.vault.modify(file, 'from B');
		});
		const rewinding = a.rewind(start);
		await settle();
		held.open();
		await other;
		const result = await rewinding;
		expect(result!.reverted).toEqual([]);
		expect(result!.unchanged).toEqual([
			{ path: 'notes/n.md', reason: 'The note was edited after the agent changed it.' },
		]);
		expect(h.app.vault.text('notes/n.md')).toBe('from B');
	});

	it('7: every running session is noted for the next start, and none once they end', async () => {
		const slow = gate();
		const h = hubHarness([
			[{ text: 'A', hold: slow.promise }],
			[{ text: 'B', hold: slow.promise }],
		]);
		const a = h.hub.create();
		const b = h.hub.create();
		const runs = [a.send('one'), b.send('two')];
		await until(() => h.requests[0]?.length === 1 && h.requests[1]?.length === 1);
		expect(h.app.loadLocalStorage(ACTIVE_TURNS_KEY)).toEqual([a.session!.id, b.session!.id]);
		slow.open();
		await Promise.all(runs);
		expect(h.app.loadLocalStorage(ACTIVE_TURNS_KEY)).toBeNull();
	});

	it('8: a session that ends unseen is marked, told of and let go; it opens again from its log', async () => {
		const h = hubHarness([[{ text: 'All done.\nThe rest.' }]]);
		const a = h.hub.create();
		await a.send('work');
		const id = a.session!.id;
		expect(h.hub.entries()).toEqual([
			expect.objectContaining({ sessionId: id, activity: 'unread', line: 'All done.' }),
		]);
		expect(h.notices).toEqual(['"work" finished.']);
		expect(h.hub.runtimes).not.toContain(a);
		const again = await h.hub.open(id);
		expect(again.events.map((e) => e.event.type)).toEqual(a.events.map((e) => e.event.type));
		h.hub.show({ isShown: () => true }, again);
		expect(h.hub.entries()).toEqual([]);
	});

	it('9: removing a running session stops it first and leaves the chat showing it empty', async () => {
		const h = hubHarness([[{ text: 'never', hold: new Promise(() => {}) }]]);
		const a = h.hub.create();
		h.hub.show({ isShown: () => true }, a);
		void a.send('long job');
		await until(() => h.requests[0]?.length === 1);
		const id = a.session!.id;
		await h.hub.remove(id);
		expect(a.isRunning).toBe(false);
		expect(a.session).toBeNull();
		expect(h.hub.find(id)).toBeUndefined();
		// The chat still shows it, now as a session not sent yet.
		expect(h.hub.runtimes).toContain(a);
	});

	it('a session on screen is neither marked nor told of, and goes once no chat shows it', async () => {
		const h = hubHarness([[{ text: 'done' }]]);
		const a = h.hub.create();
		const viewer = { isShown: () => true };
		h.hub.show(viewer, a);
		await a.send('hi');
		expect(h.hub.entries()).toEqual([]);
		expect(h.notices).toEqual([]);
		expect(h.hub.runtimes).toContain(a);
		h.hub.hide(viewer, a);
		expect(h.hub.runtimes).not.toContain(a);
	});

	it('an approval asked unseen is told once and listed first, with what it would touch', async () => {
		const h = hubHarness(
			[
				[
					{ toolCalls: [{ name: 'write', args: { path: 'x.md', content: 'x' } }] },
					{ text: 'written' },
				],
				[{ text: 'still working', hold: new Promise(() => {}) }],
			],
			{ write: 'approval_required' },
		);
		const a = h.hub.create();
		const b = h.hub.create();
		void b.send('keep busy');
		const runA = a.send('write it');
		await until(() => a.pendingApproval !== null && h.requests[1]?.length === 1);
		expect(h.hub.entries().map((e) => [e.activity, e.line])).toEqual([
			['asking', 'Waiting for your approval: write x.md'],
			['running', 'Waiting for the model'],
		]);
		expect(h.notices).toEqual(['"write it" is waiting for your approval.']);
		a.pendingApproval!.resolve('approve');
		await runA;
		b.stop();
	});

	it('finds the agent a resumed run started in whichever session started it', async () => {
		const h = hubHarness([]);
		const s = await h.sessions.create({ providerId: 'p', modelId: 'm' });
		await h.sessions.append(s.id, { type: 'user', content: 'look' });
		await h.sessions.append(s.id, {
			type: 'tool_call',
			toolCallId: 'c1',
			name: 'spawn_agent',
			args: { agent: 'explore', title: 't', task: 'x' },
		});
		await h.sessions.append(s.id, {
			type: 'tool_result',
			toolCallId: 'c1',
			name: 'spawn_agent',
			ok: true,
			content: 'found',
			truncated: false,
			agentSession: 'sub-1',
		});
		h.hub.create();
		await h.hub.open(s.id);
		expect(h.hub.agentOfCall({ resume: 'sub-1', title: 't', task: 'more' })).toBe('explore');
		expect(h.hub.agentOfCall({ resume: 'nobody', title: 't', task: 'x' })).toBe(
			'general-purpose',
		);
		expect(h.hub.agentOfCall({ agent: 'note-critic', title: 't', task: 'x' })).toBe(
			'note-critic',
		);
	});

	it('keeps what was typed for each session, and nothing that is empty', () => {
		const h = hubHarness([]);
		h.hub.keepDraft('s1', {
			text: 'half a thought',
			images: [],
			mentions: [],
			activeNote: false,
		});
		h.hub.keepDraft('s2', { text: '  ', images: [], mentions: [], activeNote: false });
		expect(h.hub.takeDraft('s1')?.text).toBe('half a thought');
		expect(h.hub.takeDraft('s1')).toBeUndefined();
		expect(h.hub.takeDraft('s2')).toBeUndefined();
	});
});
