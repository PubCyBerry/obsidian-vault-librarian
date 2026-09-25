import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { AgentController, type ControllerEvent } from '../src/agent/agent-controller';
import { NestedAgentsMd } from '../src/agent/nested-agents-md';
import { PromptManager } from '../src/agent/prompt';
import { createSpawnAgentTool, forkMessages, Slots } from '../src/agent/subagent';
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

/** The agent a request is for: a sub-agent's system prompt names it, the main agent's does not. */
function agentOf(context: Parameters<StreamFn>[1]): string {
	const system = context.messages.find((m) => m.role === 'system') as
		| { content?: unknown }
		| undefined;
	const text = typeof system?.content === 'string' ? system.content : '';
	return /You are a sub-agent named (\S+)\./.exec(text)?.[1] ?? 'main';
}

/** A response that never comes, until the request is stopped. */
const hanging: StreamFn = (model, _context, options) => {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: 'assistant',
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: 'pending' as never,
		timestamp: Date.now(),
	};
	const end = () => {
		message.stopReason = 'aborted';
		message.errorMessage = 'Operation aborted';
		stream.push({ type: 'error', reason: 'aborted', error: message });
		stream.end();
	};
	if (options?.signal?.aborted) queueMicrotask(end);
	else options?.signal?.addEventListener('abort', end, { once: true });
	return stream;
};

function harness(
	scripts: Record<string, ScriptedTurn[] | 'hang'>,
	perms: Partial<Record<string, ToolPermission>> = {},
	extra: Record<string, unknown> = {},
) {
	const app = new FakeApp();
	app.vault.seed('notes/a.md', 'alpha\nbeta');
	app.vault.seed('notes/b.md', 'gamma');
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
	for (const tool of Object.keys(settings.toolPermissions.byTool))
		settings.toolPermissions.byTool[tool] = 'always_allow';
	for (const [tool, p] of Object.entries(perms)) settings.toolPermissions.byTool[tool] = p!;
	app.secrets.set('vault-librarian-p', 'key');
	const streams = Object.fromEntries(
		Object.entries(scripts).map(([name, s]) => [name, s === 'hang' ? null : scriptedStream(s)]),
	);
	const requests: Record<string, Parameters<StreamFn>[1][]> = {};
	const streamFn: StreamFn = (model, context, options) => {
		const name = agentOf(context);
		requests[name] = [...(requests[name] ?? []), context];
		const scripted = streams[name];
		return scripted
			? scripted.streamFn(model, context, options)
			: hanging(model, context, options);
	};
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
	const spawn = createSpawnAgentTool((id, args, signal) =>
		controller.runSubagent(id, args, signal),
	);
	const controller: AgentController = new AgentController({
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
		tools: () => [
			...createVaultTools({
				app: app as unknown as App,
				settings: () => settings,
				mutation: {
					before: (id, p) => controller.beforeMutation(id, p),
					after: (id, p) => controller.afterMutation(id, p),
				},
			}),
			spawn,
		],
		skillCatalog: () => '',
		nestedAgentsMd: new NestedAgentsMd({
			vault: async () => null,
			storage: () => null,
			activePath: () => null,
		}),
	});
	const events: ControllerEvent[] = [];
	controller.subscribe((e) => events.push(e));
	const toolResults = async () =>
		(await sessions.load(controller.session!.id)).filter((e) => e.type === 'tool_result') as {
			name: string;
			ok: boolean;
			content: string;
			agentSession?: string;
		}[];
	return { app, controller, events, requests, sessions, settings, toolResults };
}

const spawn = (name: string, task: string, extra: Record<string, unknown> = {}) => ({
	name: 'spawn_agent',
	args: { name, task, ...extra },
});

describe('sub-agents (LIB-TEST-141)', () => {
	it('1, 7: a sub-agent sees the main tools but spawn_agent, and cannot spawn', async () => {
		const h = harness({
			main: [{ toolCalls: [spawn('scout', 'Find alpha.')] }, { text: 'done' }],
			scout: [
				{ toolCalls: [spawn('deeper', 'Go on.')] },
				{ text: 'Found in notes/a.md:1-1' },
			],
		});
		await h.controller.send('go');
		const first = h.requests.scout![0]!;
		const declared = (first.messages[0] as { toolsAdded?: { name: string }[] }).toolsAdded!;
		expect(declared.map((t) => t.name)).toContain('read');
		expect(declared.map((t) => t.name)).not.toContain('spawn_agent');
		// Not in its tool list, so Pi's own check refuses it before any permission is judged.
		const again = h.requests.scout![1]!.messages;
		const refused = again.find((m) => m.role === 'toolResult') as {
			content: { text: string }[];
		};
		expect(refused.content[0]!.text).toContain('Tool spawn_agent not found');
	});

	it('2: fork_context starts from the conversation so far; otherwise the task alone', async () => {
		const h = harness({
			main: [
				{ text: 'The first answer.' },
				{
					toolCalls: [
						spawn('forked', 'Check the answer.', { fork_context: true }),
						spawn('fresh', 'Check the answer.'),
					],
				},
				{ text: 'ok' },
			],
			forked: [{ text: 'fine' }],
			fresh: [{ text: 'fine' }],
		});
		await h.controller.send('first question');
		await h.controller.send('now check it');
		const texts = (name: string) =>
			h.requests[name]![0]!.messages.filter((m) => m.role !== 'system').map((m) =>
				typeof m.content === 'string'
					? m.content
					: (m.content as { text?: string }[]).map((c) => c.text ?? '').join(''),
			);
		expect(texts('forked')).toEqual([
			'first question',
			'The first answer.',
			'now check it',
			'Check the answer.',
		]);
		expect(texts('fresh')).toEqual(['Check the answer.']);
		const system = h.requests.fresh![0]!.messages[0] as { content: string };
		expect(system.content).toMatch(/# Sub-agent\n\nYou are a sub-agent named fresh\./);
		expect(system.content.trimEnd().endsWith('You cannot start other agents.')).toBe(true);
	});

	it('3: the last message is the result; a limit or an error says so', async () => {
		const h = harness(
			{
				main: [
					{
						toolCalls: [
							spawn('ok', 'Answer.'),
							spawn('limited', 'Read on.'),
							spawn('broken', 'Fail.'),
						],
					},
					{ text: 'done' },
				],
				// The iteration limit counts turns with tool calls; an answer straight away is none.
				ok: [{ text: 'Found in notes/a.md:1' }],
				limited: [
					{ toolCalls: [{ name: 'read', args: { path: 'notes/a.md' } }] },
					{ text: 'never' },
				],
				broken: [{ stopReason: 'error', errorMessage: 'HTTP 500 from the server' }],
			},
			{},
			{ maxIterations: 1 },
		);
		await h.controller.send('go');
		const spawned = (await h.toolResults()).filter((r) => r.name === 'spawn_agent');
		expect(spawned.map((r) => r.content)).toEqual([
			'Found in notes/a.md:1',
			'The agent stopped before it wrote an answer.\n\n[Stopped after 1 tool iterations]',
			'Error: HTTP 500 from the server',
		]);
		expect(spawned.map((r) => r.ok)).toEqual([true, true, false]);
		expect([...h.controller.agents.values()].map((a) => a.status)).toEqual([
			'done',
			'stopped',
			'failed',
		]);
	});

	it('4: past maxSubagents a call waits for a place', async () => {
		const h = harness(
			{
				main: [
					{ toolCalls: [spawn('a', 'A.'), spawn('b', 'B.'), spawn('c', 'C.')] },
					{ text: 'done' },
				],
				a: [{ text: 'A done' }],
				b: [{ text: 'B done' }],
				c: [{ text: 'C done' }],
			},
			{},
			{ maxSubagents: 2 },
		);
		const seen: string[] = [];
		h.controller.subscribe((e) => {
			if (e.type !== 'agent') return;
			const line = `${e.agent.name}:${e.agent.status}`;
			if (seen[seen.length - 1] !== line) seen.push(line);
		});
		await h.controller.send('go');
		const cRuns = seen.indexOf('c:running');
		expect(seen).toContain('c:waiting');
		expect(cRuns).toBeGreaterThan(Math.min(seen.indexOf('a:done'), seen.indexOf('b:done')));
		expect(seen.indexOf('c:waiting')).toBeLessThan(seen.indexOf('a:done'));
	});

	it('5: Stop ends the sub-agents with the main agent', async () => {
		const h = harness({ main: [{ toolCalls: [spawn('slow', 'Take long.')] }], slow: 'hang' });
		h.controller.subscribe((e) => {
			if (e.type === 'agent' && e.agent.status === 'running' && e.agent.events.length === 1)
				queueMicrotask(() => h.controller.stop());
		});
		await h.controller.send('go');
		const [result] = (await h.toolResults()).filter((r) => r.name === 'spawn_agent');
		expect(result?.ok).toBe(false);
		expect([...h.controller.agents.values()][0]?.status).toBe('failed');
		expect(h.controller.state).toBe('idle');
	});

	it('6: approvals from agents side by side come one at a time and say who asks', async () => {
		const h = harness(
			{
				main: [{ toolCalls: [spawn('a', 'A.'), spawn('b', 'B.')] }, { text: 'done' }],
				a: [{ toolCalls: [{ name: 'read', args: { path: 'notes/a.md' } }] }, { text: 'A' }],
				b: [{ toolCalls: [{ name: 'read', args: { path: 'notes/b.md' } }] }, { text: 'B' }],
			},
			{ read: 'approval_required' },
		);
		const cards: { agent?: string; open: boolean }[] = [];
		let open = false;
		h.controller.subscribe((e) => {
			if (e.type !== 'approval') return;
			if (!e.request) {
				open = false;
				return;
			}
			if (cards.some((c) => c.agent === e.request!.agentName)) return;
			cards.push({ agent: e.request.agentName, open });
			open = true;
			queueMicrotask(() => e.request!.resolve('always'));
		});
		await h.controller.send('go');
		// The first card's Always allow lets the other agent's read through without a card.
		expect(cards).toHaveLength(1);
		expect(cards[0]!.open).toBe(false);
		expect(['a', 'b']).toContain(cards[0]!.agent);
		expect(h.settings.toolPermissions.byTool.read).toBe('always_allow');
	});

	it('8: a sub-agent keeps its own session; its snapshot is the main one', async () => {
		const h = harness({
			main: [{ toolCalls: [spawn('writer', 'Write a note.')] }, { text: 'done' }],
			writer: [
				{ toolCalls: [{ name: 'write', args: { path: 'notes/new.md', content: 'x' } }] },
				{ text: 'Wrote notes/new.md' },
			],
		});
		await h.controller.send('go');
		const parent = await h.sessions.load(h.controller.session!.id);
		const all = await h.sessions.list();
		const child = all.find((s) => s.parentId === h.controller.session!.id)!;
		expect(child.agentName).toBe('writer');
		expect(child.parentCallId).toBeTruthy();
		const childLog = await h.sessions.load(child.id);
		expect(childLog.map((e) => e.type)).toEqual([
			'meta',
			'user',
			'assistant',
			'tool_call',
			'tool_result',
			'assistant',
		]);
		expect(
			parent.filter((e) => e.type === 'tool_call').map((e) => (e as { name: string }).name),
		).toEqual(['spawn_agent']);
		expect(parent.some((e) => e.type === 'snapshot')).toBe(true);
		expect(childLog.some((e) => e.type === 'snapshot')).toBe(false);
		const result = parent.find((e) => e.type === 'tool_result') as { agentSession?: string };
		expect(result.agentSession).toBe(child.id);
		// Deleting the conversation deletes its agents' sessions too.
		await h.sessions.delete(h.controller.session!.id);
		expect((await h.sessions.list()).length).toBe(0);
	});
});

describe('sub-agent parts', () => {
	it('forkMessages drops system messages and the response calling spawn_agent', () => {
		const messages = [
			{ role: 'system', content: 'prompt' },
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: [] },
			{ role: 'toolResult', content: [] },
			{ role: 'assistant', content: [{ type: 'toolCall' }] },
		] as never[];
		expect(forkMessages(messages).map((m) => (m as { role: string }).role)).toEqual([
			'user',
			'assistant',
			'toolResult',
		]);
	});

	it('Slots lets a waiter in when a place frees and drops one whose signal aborts', async () => {
		const slots = new Slots(() => 1);
		await slots.take();
		const order: string[] = [];
		const stop = new AbortController();
		const second = slots.take().then(() => order.push('second'));
		const third = slots.take(stop.signal).catch(() => order.push('third aborted'));
		stop.abort();
		await third;
		slots.release();
		await second;
		expect(order).toEqual(['third aborted', 'second']);
	});
});
