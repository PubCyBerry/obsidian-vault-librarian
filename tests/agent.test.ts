import type { App } from 'obsidian';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentController, type ControllerEvent } from '../src/agent/agent-controller';
import { PromptManager } from '../src/agent/prompt';
import { ContextManager } from '../src/context/context-manager';
import { ToolPermissionManager } from '../src/permissions/tool-permission-manager';
import { ProviderManager } from '../src/provider/provider-manager';
import type { TransportRouter } from '../src/provider/transport';
import { SessionManager } from '../src/session/session-manager';
import { SecretStore } from '../src/storage/secret-store';
import { createVaultTools } from '../src/tools/registry';
import { mergeSettings, newModel, newProvider, type ToolPermission } from '../src/types';
import { FakeApp } from './fake-app';
import { type ScriptedTurn, scriptedStream } from './scripted-stream';

interface Harness {
	app: FakeApp;
	controller: AgentController;
	events: ControllerEvent[];
	requests: ReturnType<typeof scriptedStream>['requests'];
	sessions: SessionManager;
	permissions: ToolPermissionManager;
	/** Answers every approval request with the given decision, recording the tool names asked. */
	autoApprove(decision: 'approve' | 'reject' | 'always'): string[];
}

function harness(
	turns: ScriptedTurn[],
	perms: Partial<Record<string, ToolPermission>> = {},
	extra: Record<string, unknown> = {},
): Harness {
	const app = new FakeApp();
	app.vault.seed('AGENTS.md', 'Answer in Korean.');
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
		...extra,
	});
	for (const [tool, p] of Object.entries(perms))
		settings.toolPermissions.byTool[tool as 'ls'] = p!;
	app.secrets.set('vault-librarian-p', 'key');
	const { streamFn, requests } = scriptedStream(turns);
	const sessions = new SessionManager(app as unknown as App, '.obsidian/plugins/vault-librarian');
	const permissions = new ToolPermissionManager(
		() => settings,
		async () => {},
	);
	const transport = {
		createStreamFn: () => streamFn,
		effectiveMode: () => 'fetch',
		hasFallenBack: () => false,
	} as unknown as TransportRouter;
	const controller = new AgentController({
		app: app as unknown as App,
		settings: () => settings,
		saveSettings: async () => {},
		sessions,
		context: new ContextManager(app as unknown as App, () => settings.context),
		permissions,
		providers: new ProviderManager(() => settings),
		transport,
		prompt: new PromptManager(app as unknown as App),
		secrets: new SecretStore(app as unknown as App),
		tools: () => createVaultTools({ app: app as unknown as App, settings: () => settings }),
	});
	const events: ControllerEvent[] = [];
	controller.subscribe((e) => events.push(e));
	return {
		app,
		controller,
		events,
		requests,
		sessions,
		permissions,
		autoApprove(decision) {
			const asked: string[] = [];
			controller.subscribe((e) => {
				if (e.type === 'approval' && e.request) {
					asked.push(e.request.name);
					queueMicrotask(() => e.request!.resolve(decision));
				}
			});
			return asked;
		},
	};
}

async function sessionEvents(h: Harness) {
	return sessions(h);
}

async function sessions(h: Harness) {
	return h.sessions.load(h.controller.session!.id);
}

beforeEach(() => {
	// each test builds its own harness
});

describe('agent loop through Pi (LIB-TEST-030, LIB-TEST-038, LIB-TEST-088)', () => {
	it('runs find then read then answers, feeding tool results back into the next request', async () => {
		const h = harness([
			{ toolCalls: [{ name: 'find', args: { query: 'a' } }] },
			{ toolCalls: [{ name: 'read', args: { path: 'notes/a.md' } }] },
			{ text: 'The note says alpha. notes/a.md:1-2', usage: { input: 300, output: 20 } },
		]);
		h.autoApprove('approve');
		await h.controller.send('what does note a say?');
		const log = await sessionEvents(h);
		expect(log.map((e) => e.type)).toEqual([
			'meta',
			'user',
			'assistant',
			'tool_call',
			'approval',
			'tool_result',
			'assistant',
			'tool_call',
			'approval',
			'tool_result',
			'assistant',
		]);
		expect(h.requests).toHaveLength(3);
		const third = h.requests[2]!.messages;
		expect(third.filter((m) => m.role === 'toolResult')).toHaveLength(2);
		const system = third[0] as { content: string };
		expect(system.content.startsWith('You are Librarian')).toBe(true);
		expect(system.content).toContain('# Vault root AGENTS.md\n\nAnswer in Korean.');
		expect(system.content).toMatch(/prefer find then read/);
		expect(system.content).toMatch(
			/Do not conclude information is absent after only one failed search/,
		);
		expect(h.controller.state).toBe('idle');
		expect(h.controller.usage?.usedTokens).toBeGreaterThan(300);
		expect(h.controller.findReadLine('notes/a.md', 2)).toBe('beta');
	});

	it('LIB-TEST-038/039: AGENTS.md is skipped when disabled, missing or empty and custom prompt sits below it', async () => {
		const h = harness(
			[{ text: 'ok' }],
			{},
			{ useVaultAgentsMd: false, customSystemPrompt: 'Be brief.' },
		);
		await h.controller.send('hi');
		let system = h.requests[0]!.messages[0] as { content: string };
		expect(system.content).not.toContain('Vault root AGENTS.md\n\nAnswer');
		expect(system.content.indexOf('Custom system prompt')).toBeGreaterThan(
			system.content.indexOf('You are Librarian'),
		);
		const h2 = harness(
			[{ text: 'ok' }, { text: 'ok' }],
			{},
			{ customSystemPrompt: 'Be brief.' },
		);
		await h2.controller.send('hi');
		system = h2.requests[0]!.messages[0] as { content: string };
		expect(system.content.indexOf('# Vault root AGENTS.md')).toBeLessThan(
			system.content.indexOf('# Custom system prompt'),
		);
		await h2.app.vault.modify(h2.app.vault.getFileByPath('AGENTS.md')!, '   ');
		await h2.controller.send('again');
		system = h2.requests[1]!.messages[0] as { content: string };
		expect(system.content).not.toContain('# Vault root AGENTS.md');
		expect(h2.events.some((e) => e.type === 'approval')).toBe(false);
	});
});

describe('approval flow', () => {
	it('LIB-TEST-006/012: nothing is written before approval and a rejection reaches the model', async () => {
		const h = harness([
			{ toolCalls: [{ name: 'write', args: { path: 'notes/new.md', content: 'x' } }] },
			{ text: 'understood' },
		]);
		let sawApproval = false;
		h.controller.subscribe((e) => {
			if (e.type === 'approval' && e.request) {
				sawApproval = true;
				expect(h.app.vault.writes).toBe(0);
				expect(e.request.name).toBe('write');
				queueMicrotask(() => e.request!.resolve('reject'));
			}
		});
		await h.controller.send('make a note');
		expect(sawApproval).toBe(true);
		expect(h.app.vault.text('notes/new.md')).toBeUndefined();
		const log = await sessions(h);
		expect(log.find((e) => e.type === 'approval')).toMatchObject({ decision: 'rejected' });
		const result = h.requests[1]!.messages.find((m) => m.role === 'toolResult') as {
			content: { text: string }[];
			isError: boolean;
		};
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toMatch(/rejected/);
		expect(
			h.controller.toolStatusOf(log.find((e) => e.type === 'tool_call')!.toolCallId as never),
		).toBe('rejected');
	});

	it('LIB-TEST-007: an always-allowed tool runs without a card', async () => {
		const h = harness(
			[{ toolCalls: [{ name: 'grep', args: { query: 'alpha' } }] }, { text: 'found' }],
			{ grep: 'always_allow' },
		);
		await h.controller.send('search');
		expect(h.events.some((e) => e.type === 'approval' && e.request)).toBe(false);
		const log = await sessions(h);
		expect(log.some((e) => e.type === 'approval')).toBe(false);
		expect(log.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true });
	});

	it('LIB-TEST-009: Always allow saves the permission and covers the second call in the same response', async () => {
		const h = harness([
			{
				toolCalls: [
					{ name: 'read', args: { path: 'notes/a.md' } },
					{ name: 'read', args: { path: 'notes/a.md', offset: 2 } },
				],
			},
			{ text: 'done' },
		]);
		const asked = h.autoApprove('always');
		await h.controller.send('read twice');
		expect(asked).toEqual(['read']);
		expect(h.permissions.get('read')).toBe('always_allow');
		const results = (await sessions(h)).filter((e) => e.type === 'tool_result');
		expect(results).toHaveLength(2);
		expect(results.every((r) => (r as { ok: boolean }).ok)).toBe(true);
	});

	it('LIB-TEST-010/048: reads are approved in order and a write makes the batch sequential', async () => {
		const order: string[] = [];
		const h = harness([
			{
				toolCalls: [
					{ name: 'ls', args: {} },
					{ name: 'find', args: { query: 'a' } },
					{ name: 'grep', args: { query: 'x' } },
				],
			},
			{
				toolCalls: [
					{ name: 'read', args: { path: 'notes/a.md' } },
					{ name: 'write', args: { path: 'notes/b.md', content: 'b' } },
					{ name: 'read', args: { path: 'notes/b.md' } },
				],
			},
			{ text: 'done' },
		]);
		h.controller.subscribe((e) => {
			if (e.type === 'approval' && e.request) {
				order.push(`ask:${e.request.name}`);
				queueMicrotask(() => e.request!.resolve('approve'));
			}
			if (e.type === 'tool-status' && e.status === 'ok') order.push('ok');
		});
		await h.controller.send('go');
		expect(order.slice(0, 3)).toEqual(['ask:ls', 'ask:find', 'ask:grep']);
		// The three reads were preflighted first; the write batch interleaves ask and completion.
		expect(order.slice(3)).toEqual([
			'ok',
			'ok',
			'ok',
			'ask:read',
			'ok',
			'ask:write',
			'ok',
			'ask:read',
			'ok',
		]);
		expect(h.app.vault.text('notes/b.md')).toBe('b');
	});

	it('LIB-TEST-005: a blocked tool never runs even when the model calls it', async () => {
		const h = harness(
			[
				{
					toolCalls: [
						{
							name: 'edit',
							args: { path: 'notes/a.md', old_text: 'alpha', new_text: 'z' },
						},
					],
				},
				{ text: 'ok' },
			],
			{ edit: 'blocked' },
		);
		await h.controller.send('edit it');
		expect(h.app.vault.text('notes/a.md')).toBe('alpha\nbeta');
		const system = h.requests[0]!.messages[0] as { toolsAdded: { name: string }[] };
		expect(system.toolsAdded.map((t) => t.name)).not.toContain('edit');
		const result = h.requests[1]!.messages.find((m) => m.role === 'toolResult') as {
			content: { text: string }[];
			isError: boolean;
		};
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toMatch(/not found|blocked/);
	});
});

describe('guards', () => {
	it('LIB-TEST-034: malformed arguments are refused before the tool runs', async () => {
		const h = harness(
			[{ toolCalls: [{ name: 'write', args: { path: 'notes/c.md' } }] }, { text: 'ok' }],
			{ write: 'always_allow' },
		);
		await h.controller.send('go');
		expect(h.app.vault.text('notes/c.md')).toBeUndefined();
		const result = (await sessions(h)).find((e) => e.type === 'tool_result') as {
			ok: boolean;
			content: string;
		};
		expect(result.ok).toBe(false);
		expect(result.content).toMatch(/^Error:/);
	});

	it('LIB-TEST-036: tool calls in a length-truncated response are not executed', async () => {
		const h = harness(
			[
				{
					toolCalls: [{ name: 'write', args: { path: 'notes/c.md', content: 'x' } }],
					stopReason: 'length',
				},
				{ text: 'retry' },
			],
			{ write: 'always_allow' },
		);
		await h.controller.send('go');
		expect(h.app.vault.text('notes/c.md')).toBeUndefined();
		const result = (await sessions(h)).find((e) => e.type === 'tool_result') as {
			ok: boolean;
			content: string;
		};
		expect(result.ok).toBe(false);
		expect(result.content).toMatch(/truncated/);
		expect(h.events.some((e) => e.type === 'notice' && e.message.includes('cut off'))).toBe(
			true,
		);
	});

	it('LIB-TEST-035: the same failing call stops the turn at the limit', async () => {
		const bad = { name: 'read', args: { path: 'missing.md' } };
		const h = harness(
			[
				{ toolCalls: [bad] },
				{ toolCalls: [bad] },
				{ toolCalls: [bad] },
				{ text: 'never sent' },
			],
			{ read: 'always_allow' },
		);
		await h.controller.send('go');
		expect(h.requests).toHaveLength(3);
		expect(
			h.events.some(
				(e) =>
					e.type === 'notice' &&
					e.message === 'Stopped: the same tool call failed 3 times',
			),
		).toBe(true);
		const h2 = harness(
			[
				{ toolCalls: [{ name: 'read', args: { path: 'a.md' } }] },
				{ toolCalls: [{ name: 'read', args: { path: 'b.md' } }] },
				{ toolCalls: [{ name: 'read', args: { path: 'c.md' } }] },
				{ text: 'still going' },
			],
			{ read: 'always_allow' },
		);
		await h2.controller.send('go');
		expect(h2.requests).toHaveLength(4);
	});

	it('LIB-TEST-032: Stop cancels the request and skips tools that have not started', async () => {
		const h = harness(
			[
				{
					toolCalls: [
						{ name: 'write', args: { path: 'notes/one.md', content: '1' } },
						{ name: 'write', args: { path: 'notes/two.md', content: '2' } },
					],
				},
				{ text: 'not reached' },
			],
			{ write: 'always_allow' },
		);
		h.controller.subscribe((e) => {
			if (e.type === 'tool-status' && e.status === 'ok') h.controller.stop();
		});
		await h.controller.send('go');
		expect(h.app.vault.text('notes/one.md')).toBe('1');
		expect(h.app.vault.text('notes/two.md')).toBeUndefined();
		expect(h.requests).toHaveLength(1);
		expect(h.controller.state).toBe('idle');
	});

	it('LIB-TEST-025: without a key on this device no request goes out', async () => {
		const h = harness([{ text: 'x' }]);
		h.app.secrets.delete('vault-librarian-p');
		await h.controller.send('hi');
		expect(h.requests).toHaveLength(0);
		expect(h.controller.state).toBe('no-key');
	});

	it('LIB-TEST-041/FEAT-041: long results are truncated with a note', async () => {
		const h = harness(
			[{ toolCalls: [{ name: 'read', args: { path: 'notes/long.md' } }] }, { text: 'ok' }],
			{ read: 'always_allow' },
			{ toolResultMaxChars: 200 },
		);
		h.app.vault.seed('notes/long.md', 'x'.repeat(2000));
		await h.controller.send('go');
		const result = (await sessions(h)).find((e) => e.type === 'tool_result') as {
			content: string;
			truncated: boolean;
		};
		expect(result.truncated).toBe(true);
		expect(result.content.length).toBeLessThan(400);
		expect(result.content).toContain('[truncated');
	});
});

describe('snapshots and rewind (LIB-TEST-083, LIB-TEST-084, LIB-TEST-086, LIB-TEST-095)', () => {
	it('reverts agent changes in reverse but keeps notes the user touched', async () => {
		const h = harness(
			[
				{
					toolCalls: [
						{ name: 'write', args: { path: 'notes/new.md', content: 'fresh' } },
					],
				},
				{
					toolCalls: [
						{
							name: 'edit',
							args: { path: 'notes/a.md', old_text: 'alpha', new_text: 'ALPHA' },
						},
					],
				},
				{
					toolCalls: [
						{ name: 'write', args: { path: 'notes/user.md', content: 'agent' } },
					],
				},
				{ text: 'done' },
			],
			{ write: 'always_allow', edit: 'always_allow' },
		);
		await h.controller.send('do things');
		const log = await sessions(h);
		const snapshots = log.filter((e) => e.type === 'snapshot') as {
			path: string;
			ref: string | null;
		}[];
		expect(snapshots.map((s) => [s.path, s.ref === null])).toEqual([
			['notes/new.md', true],
			['notes/a.md', false],
			['notes/user.md', true],
		]);
		expect(await h.sessions.readSnapshot(h.controller.session!.id, snapshots[1]!.ref!)).toBe(
			'alpha\nbeta',
		);
		expect(JSON.stringify(log)).not.toContain('alpha\\nbeta');
		// The user edits one agent-made note before rewinding.
		await h.app.vault.modify(h.app.vault.getFileByPath('notes/user.md')!, 'agent + me');
		const userIndex = log.findIndex((e) => e.type === 'user');
		const preview = h.controller.previewRewind(userIndex)!;
		expect(preview.turns).toBe(1);
		expect(preview.changes.map((c) => c.path)).toEqual([
			'notes/new.md',
			'notes/a.md',
			'notes/user.md',
		]);
		const result = await h.controller.rewind(userIndex);
		expect(result?.reverted).toEqual(['notes/a.md', 'notes/new.md']);
		expect(result?.unchanged).toEqual([
			{ path: 'notes/user.md', reason: 'The note was edited after the agent changed it.' },
		]);
		expect(result?.userText).toBe('do things');
		expect(h.app.trashed).toEqual(['notes/new.md']);
		expect(h.app.vault.text('notes/a.md')).toBe('alpha\nbeta');
		expect(h.app.vault.text('notes/user.md')).toBe('agent + me');
		const after = await sessions(h);
		expect(after[after.length - 1]!.type).toBe('rewind');
		expect(after.length).toBe(log.length + 1);
		expect(h.controller.events.map((e) => e.event.type)).toEqual(['meta']);
		expect(
			await h.sessions.readSnapshot(h.controller.session!.id, snapshots[1]!.ref!),
		).toBeNull();
	});
});

describe('compaction during a session (LIB-TEST-064, LIB-TEST-067)', () => {
	it('compacts before sending when the reported usage is critical and keeps the log intact', async () => {
		const h = harness(
			[{ text: 'summary of old stuff' }, { text: 'reply' }],
			{},
			{
				providers: [
					{
						...newProvider('p'),
						baseUrl: 'https://x',
						models: [{ ...newModel('m'), contextWindow: 4096, maxTokens: 512 }],
					},
				],
				context: {
					warningAt: 0.7,
					compactAt: 0.85,
					preserveRecentTurns: 1,
					reserveOutputTokens: 'model-max',
					safetyMarginTokens: 4096,
				},
			},
		);
		await h.controller.newSession();
		const id = h.controller.session!.id;
		for (let i = 0; i < 4; i++) {
			await h.sessions.append(id, { type: 'user', content: `q${i} ${'가'.repeat(600)}` });
			await h.sessions.append(id, {
				type: 'assistant',
				content: `a${i} ${'나'.repeat(600)}`,
				toolCalls: [],
				// The ring and the compaction gate use only what the provider reported (LIB-FEAT-055).
				usage: {
					input: 700 * (i + 1),
					output: 50,
					cacheRead: 0,
					totalTokens: 700 * (i + 1) + 50,
				},
			});
		}
		await h.controller.reloadEvents();
		const before = (await h.sessions.load(id)).length;
		await h.controller.send('new question');
		const log = await h.sessions.load(id);
		expect(log.length).toBe(before + 3);
		expect(log.some((e) => e.type === 'compaction' && e.method === 'summary')).toBe(true);
		const sent = h.requests[1]!.messages;
		expect((sent[1] as { content: string }).content).toContain('summary of old stuff');
		// The summary stands in for the older turns; the current turn is the one preserved turn.
		expect(sent.filter((m) => m.role === 'user')).toHaveLength(2);
	});
});
