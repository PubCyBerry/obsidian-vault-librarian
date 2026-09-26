import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { AgentController, type ControllerEvent, findModel } from '../src/agent/agent-controller';
import {
	AgentManager,
	agentKey,
	BUILT_IN_AGENTS,
	parseAgentMd,
	toolsFor,
} from '../src/agent/agent-definitions';
import { NestedAgentsMd } from '../src/agent/nested-agents-md';
import { PromptManager } from '../src/agent/prompt';
import {
	createSpawnAgentTool,
	fitAnswer,
	forkMessages,
	Slots,
	SPAWN_AGENT_NAME,
} from '../src/agent/subagent';
import { ContextManager } from '../src/context/context-manager';
import {
	READ_ONLY_TOOL_NAMES,
	ToolPermissionManager,
} from '../src/permissions/tool-permission-manager';
import { ProviderManager } from '../src/provider/provider-manager';
import type { TransportRouter } from '../src/provider/transport';
import { SessionManager } from '../src/session/session-manager';
import { SkillManager } from '../src/skills/skill-manager';
import { SecretStore } from '../src/storage/secret-store';
import { isAgentsPath, isSkillsPath } from '../src/tools/path-policy';
import { createVaultTools } from '../src/tools/registry';
import { mergeSettings, newModel, newProvider, type ToolPermission } from '../src/types';
import { storedRow } from '../src/ui/agent-rows';
import { FakeApp } from './fake-app';
import { type ScriptedTurn, scriptedStream } from './scripted-stream';

/** The run a request is for: a sub-agent's system prompt names its title, the main agent's none. */
function runOf(context: Parameters<StreamFn>[1]): string {
	const system = context.messages.find((m) => m.role === 'system') as
		| { content?: unknown }
		| undefined;
	const text = typeof system?.content === 'string' ? system.content : '';
	return /agent, working on "([^"]+)"\./.exec(text)?.[1] ?? 'main';
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
	files: Record<string, string> = {},
	/** Places shared with another harness, as every session of a device shares them (LIB-FEAT-274). */
	agentSlots?: Slots,
) {
	const app = new FakeApp();
	app.vault.seed('notes/a.md', 'alpha\nbeta');
	app.vault.seed('notes/b.md', 'gamma');
	for (const [path, text] of Object.entries(files)) app.vault.seed(path, text);
	const settings = mergeSettings({
		providers: [
			{
				...newProvider('p'),
				baseUrl: 'https://x',
				models: [
					{ ...newModel('m'), contextWindow: 100000, maxTokens: 1000 },
					{ ...newModel('small'), contextWindow: 100000, maxTokens: 1000 },
				],
			},
		],
		activeProviderId: 'p',
		activeModelId: 'm',
		...extra,
	});
	for (const tool of Object.keys(settings.toolPermissions.byTool))
		settings.toolPermissions.byTool[tool] = 'always_allow';
	settings.toolPermissions.byTool['agent:general-purpose'] = 'always_allow';
	for (const [tool, p] of Object.entries(perms)) settings.toolPermissions.byTool[tool] = p!;
	app.secrets.set('vault-librarian-p', 'key');
	const streams = Object.fromEntries(
		Object.entries(scripts).map(([name, s]) => [name, s === 'hang' ? null : scriptedStream(s)]),
	);
	const requests: Record<string, Parameters<StreamFn>[1][]> = {};
	const models: Record<string, string[]> = {};
	const streamFn: StreamFn = (model, context, options) => {
		const run = runOf(context);
		requests[run] = [...(requests[run] ?? []), context];
		models[run] = [...(models[run] ?? []), model.id];
		const scripted = streams[run];
		return scripted
			? scripted.streamFn(model, context, options)
			: hanging(model, context, options);
	};
	const sessions = new SessionManager(app as unknown as App, '.obsidian/plugins/vault-librarian');
	const permissions = new ToolPermissionManager(
		() => settings,
		async () => {},
	);
	const providers = new ProviderManager(() => settings);
	const defs = new AgentManager(
		app as unknown as App,
		(ref) => !!findModel(providers.listSelectable(), ref),
	);
	const skills = new SkillManager(app as unknown as App);
	// As main.ts does: the hidden files a change touched are read again.
	const rescan = async (paths: readonly string[]) => {
		if (paths.some(isAgentsPath)) await defs.scan();
		if (paths.some(isSkillsPath)) await skills.scan();
	};
	permissions.attachExtras(
		() => [],
		() => new Set(),
		(tool, args) => (tool === SPAWN_AGENT_NAME ? agentKey(controller.agentOfCall(args)) : null),
		() =>
			new Set(
				defs.agents.filter((a) => a.permissionMode === 'plan').map((a) => agentKey(a.name)),
			),
	);
	const transport = {
		createStreamFn: () => streamFn,
		effectiveMode: () => 'fetch',
		hasFallenBack: () => false,
	} as unknown as TransportRouter;
	const vault = (): AgentTool[] =>
		createVaultTools({
			app: app as unknown as App,
			settings: () => settings,
			mutation: {
				before: (id, p) => controller.beforeMutation(id, p),
				after: async (id, p) => {
					await controller.afterMutation(id, p);
					await rescan([p]);
				},
			},
			describe: (p) => defs.describe(p) ?? skills.describe(p),
		});
	const controller: AgentController = new AgentController({
		app: app as unknown as App,
		settings: () => settings,
		saveSettings: async () => {},
		sessions,
		context: new ContextManager(app as unknown as App, () => settings.context),
		permissions,
		providers,
		transport,
		prompt: new PromptManager(app as unknown as App),
		secrets: new SecretStore(app as unknown as App),
		tools: () => [
			...vault(),
			createSpawnAgentTool(defs.agents, (id, args, signal) =>
				controller.runSubagent(id, args, signal),
			),
		],
		skillCatalog: () => '',
		nestedAgentsMd: new NestedAgentsMd({
			vault: async () => null,
			storage: () => null,
			activePath: () => null,
		}),
		agentDefinition: (name) => defs.get(name),
		readsOnly: (name) => READ_ONLY_TOOL_NAMES.has(name),
		hiddenFilesChanged: rescan,
		agentSlots,
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
	return {
		app,
		controller,
		defs,
		skills,
		events,
		requests,
		models,
		sessions,
		settings,
		permissions,
		toolResults,
	};
}

const spawn = (title: string, task: string, extra: Record<string, unknown> = {}) => ({
	name: 'spawn_agent',
	args: { title, task, ...extra },
});

/** The text of each message of a request but the system one, as the model reads it. */
function texts(request: Parameters<StreamFn>[1]): string[] {
	return request.messages
		.filter((m) => m.role !== 'system')
		.map((m) =>
			typeof m.content === 'string'
				? m.content
				: (m.content as { text?: string }[]).map((c) => c.text ?? '').join(''),
		);
}

const declared = (request: Parameters<StreamFn>[1]) =>
	((request.messages[0] as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map(
		(t) => t.name,
	);

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
		expect(declared(first)).toContain('read');
		expect(declared(first)).not.toContain('spawn_agent');
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
		expect(texts(h.requests.forked![0]!)).toEqual([
			'first question',
			'The first answer.',
			'now check it',
			'Check the answer.',
		]);
		expect(texts(h.requests.fresh![0]!)).toEqual(['Check the answer.']);
		const system = h.requests.fresh![0]!.messages[0] as { content: string };
		expect(system.content.startsWith('You are Librarian')).toBe(true);
		expect(system.content).toMatch(
			/# Sub-agent\n\nYou are a sub-agent, the general-purpose agent, working on "fresh"\./,
		);
		expect(
			system.content.trimEnd().endsWith('You cannot start other agents or talk to them.'),
		).toBe(true);
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
		const agents = [...h.controller.agents.values()];
		expect(spawned.map((r) => r.content)).toEqual([
			`Found in notes/a.md:1\n\n[agent_id: ${agents[0]!.sessionId}]`,
			`The agent stopped before it wrote an answer.\n\n[Stopped after 1 tool iterations]\n\n[agent_id: ${agents[1]!.sessionId}]`,
			'Error: HTTP 500 from the server',
		]);
		expect(spawned.map((r) => r.ok)).toEqual([true, true, false]);
		expect(agents.map((a) => a.status)).toEqual(['done', 'stopped', 'failed']);
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
			const line = `${e.agent.title}:${e.agent.status}`;
			if (seen[seen.length - 1] !== line) seen.push(line);
		});
		await h.controller.send('go');
		expect(seen).toContain('c:waiting');
		expect(seen.indexOf('c:running')).toBeGreaterThan(
			Math.min(seen.indexOf('a:done'), seen.indexOf('b:done')),
		);
		expect(seen.indexOf('c:waiting')).toBeLessThan(seen.indexOf('a:done'));
	});

	it('LIB-TEST-278 6: two sessions share the places, so one waits while the other holds it', async () => {
		const shared = new Slots(() => 1);
		const a = harness(
			{ main: [{ toolCalls: [spawn('first', 'Look.')] }, { text: 'a done' }], first: 'hang' },
			{},
			{},
			{},
			shared,
		);
		const b = harness(
			{
				main: [{ toolCalls: [spawn('second', 'Look.')] }, { text: 'b done' }],
				second: [{ text: 'found' }],
			},
			{},
			{},
			{},
			shared,
		);
		const statusOf = (h: typeof a) => [...h.controller.agents.values()][0]?.status;
		const runA = a.controller.send('go');
		for (let i = 0; i < 100 && statusOf(a) !== 'running'; i++)
			await new Promise((r) => setTimeout(r, 10));
		const runB = b.controller.send('go');
		for (let i = 0; i < 100 && statusOf(b) !== 'waiting'; i++)
			await new Promise((r) => setTimeout(r, 10));
		// The main turn of B runs; only its sub-agent waits for the place A's holds.
		expect(statusOf(b)).toBe('waiting');
		expect(b.controller.isRunning).toBe(true);
		a.controller.stop();
		await runA;
		await runB;
		expect(statusOf(b)).toBe('done');
	});

	it('5: Stop ends the sub-agents with the main agent, even one still being set up', async () => {
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
		const cards: { title?: string; agent?: string; open: boolean }[] = [];
		let open = false;
		h.controller.subscribe((e) => {
			if (e.type !== 'approval') return;
			if (!e.request) {
				open = false;
				return;
			}
			if (cards.some((c) => c.title === e.request!.agentTitle)) return;
			cards.push({ title: e.request.agentTitle, agent: e.request.agentType, open });
			open = true;
			queueMicrotask(() => e.request!.resolve('always'));
		});
		await h.controller.send('go');
		// The first card's Always allow lets the other agent's read through without a card.
		expect(cards).toHaveLength(1);
		expect(cards[0]!.open).toBe(false);
		expect(['a', 'b']).toContain(cards[0]!.title);
		expect(cards[0]!.agent).toBe('general-purpose');
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
		const child = (await h.sessions.list()).find(
			(s) => s.parentId === h.controller.session!.id,
		)!;
		expect(child.agentType).toBe('general-purpose');
		expect(child.agentTitle).toBe('writer');
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

describe('agent definitions (LIB-TEST-270)', () => {
	const reviewer = [
		'---',
		'name: reviewer',
		'description: Reviews a note against the style rules.',
		'tools: Read, Grep, Glob',
		'model: small',
		'effort: bogus',
		'maxTurns: 2',
		'permissionMode: bypassPermissions',
		'color: purple',
		'hooks:',
		'  PreToolUse: []',
		'---',
		'You review notes. Answer with a list of problems.',
	].join('\n');

	it('reads Claude Code frontmatter; what it cannot use warns and the rest counts', () => {
		const { agent } = parseAgentMd(reviewer, '.agents/agents/reviewer.md');
		expect(agent).toMatchObject({
			name: 'reviewer',
			tools: ['read', 'grep', 'find'],
			model: 'small',
			maxTurns: 2,
			permissionMode: 'default',
			color: 'purple',
			prompt: 'You review notes. Answer with a list of problems.',
		});
		expect(agent!.effort).toBeUndefined();
		expect(agent!.warnings.join('\n')).toMatch(/effort "bogus"/);
		expect(agent!.warnings.join('\n')).toMatch(/permissionMode "bypassPermissions"/);
		expect(parseAgentMd('---\nname: x\n---\nbody', 'x.md').error).toBe('Missing description');
		expect(parseAgentMd('---\nname: a:b\ndescription: d\n---\n', 'x.md').error).toMatch(
			/may not/,
		);
	});

	it('scans subfolders; a file takes the place of a built-in; a second name is shadowed', async () => {
		const app = new FakeApp();
		app.vault.seed('.agents/agents/review/reviewer.md', reviewer);
		app.vault.seed(
			'.agents/agents/explore.md',
			'---\nname: explore\ndescription: My own explorer.\n---\n',
		);
		app.vault.seed('.agents/agents/zz.md', reviewer);
		const defs = new AgentManager(app as unknown as App);
		await defs.scan();
		expect(defs.agents.map((a) => a.name)).toEqual(['general-purpose', 'explore', 'reviewer']);
		expect(defs.get('explore')!.description).toBe('My own explorer.');
		expect(defs.diagnostics.map((d) => d.message)).toContain(
			'Shadowed by .agents/agents/review/reviewer.md',
		);
		expect(BUILT_IN_AGENTS.map((a) => a.name)).toEqual(['general-purpose', 'explore']);
	});

	it('gives an agent its listed tools, deferred ones too, less the denied; plan keeps readers', () => {
		const tools = ['ls', 'read', 'write', 'edit', 'bash', 'webdav_ls', 'webdav_delete'].map(
			(name) => ({ name }),
		);
		const visible = tools.filter((t) => !t.name.startsWith('webdav'));
		const readsOnly = (n: string) => READ_ONLY_TOOL_NAMES.has(n);
		const base = BUILT_IN_AGENTS[0]!;
		const names = (list: { name: string }[]) => list.map((t) => t.name);
		expect(names(toolsFor(base, visible, tools, readsOnly))).toEqual(names(visible));
		expect(
			names(toolsFor({ ...base, tools: ['read', 'webdav_*'] }, visible, tools, readsOnly)),
		).toEqual(['read', 'webdav_ls', 'webdav_delete']);
		expect(
			names(
				toolsFor(
					{ ...base, disallowedTools: ['bash', 'write'] },
					visible,
					tools,
					readsOnly,
				),
			),
		).toEqual(['ls', 'read', 'edit']);
		expect(names(toolsFor(BUILT_IN_AGENTS[1]!, visible, tools, readsOnly))).toEqual([
			'ls',
			'read',
		]);
	});

	it('runs an agent as its file says: its prompt, tools, model and turn limit', async () => {
		const h = harness(
			{
				main: [
					{ toolCalls: [spawn('style', 'Review notes/a.md.', { agent: 'reviewer' })] },
					{ text: 'ok' },
				],
				style: [
					{ toolCalls: [{ name: 'read', args: { path: 'notes/a.md' } }] },
					{ toolCalls: [{ name: 'grep', args: { query: 'beta' } }] },
					{ text: 'never' },
				],
			},
			{ 'agent:reviewer': 'always_allow' },
			{},
			{ '.agents/agents/reviewer.md': reviewer },
		);
		await h.defs.scan();
		await h.controller.send('review it');
		const first = h.requests.style![0]!;
		const system = (first.messages[0] as { content: string }).content;
		expect(system.startsWith('You review notes.')).toBe(true);
		expect(system).not.toContain('You are Librarian');
		// Read, Grep and Glob in Claude Code's names: Glob is find here.
		expect(declared(first).sort()).toEqual(['find', 'grep', 'read']);
		expect(h.models.style).toEqual(['small', 'small']);
		const [result] = (await h.toolResults()).filter((r) => r.name === 'spawn_agent');
		expect(result!.content).toMatch(/\[Stopped after 2 tool iterations\]/);
	});

	it('warns about a model Settings lacks and runs that agent on the main model', async () => {
		const odd =
			'---\nname: odd\ndescription: Names an agent as its model.\nmodel: general-purpose\n---\n';
		const h = harness(
			{
				main: [
					{ toolCalls: [spawn('odd one', 'Look.', { agent: 'odd' })] },
					{ text: 'ok' },
				],
				'odd one': [{ text: 'Looked.' }],
			},
			{ 'agent:odd': 'always_allow' },
			{},
			{ '.agents/agents/odd.md': odd },
		);
		await h.defs.scan();
		expect(h.defs.describe('.agents/agents/odd.md')).toEqual({
			agent: {
				name: 'odd',
				warnings: [
					'model "general-purpose" is not in Settings, so the agent runs on the main agent\'s model',
				],
			},
		});
		await h.controller.send('go');
		expect(h.models['odd one']).toEqual(['m']);
		const [result] = (await h.toolResults()).filter((r) => r.name === 'spawn_agent');
		expect(result!.content).toMatch(/^Looked\./);
	});

	it('a plan agent starts without asking and reads only; dontAsk refuses instead of asking', async () => {
		const quiet = '---\nname: quiet\ndescription: Never asks.\npermissionMode: dontAsk\n---\n';
		const h = harness(
			{
				main: [
					{
						toolCalls: [
							spawn('look', 'Look around.', { agent: 'explore' }),
							spawn('try', 'Write a note.', { agent: 'quiet' }),
						],
					},
					{ text: 'ok' },
				],
				look: [{ text: 'Seen.' }],
				try: [
					{ toolCalls: [{ name: 'write', args: { path: 'notes/q.md', content: 'q' } }] },
					{ text: 'Could not write.' },
				],
			},
			{ write: 'approval_required', 'agent:quiet': 'always_allow' },
			{},
			{ '.agents/agents/quiet.md': quiet },
		);
		await h.defs.scan();
		const asked: string[] = [];
		h.controller.subscribe((e) => {
			if (e.type === 'approval' && e.request) {
				asked.push(e.request.permissionKey);
				queueMicrotask(() => e.request!.resolve('approve'));
			}
		});
		await h.controller.send('go');
		// general-purpose asks by default; explore, which only reads, does not.
		expect(h.permissions.resolve('spawn_agent', { agent: 'explore' })).toBe('always_allow');
		delete h.settings.toolPermissions.byTool['agent:general-purpose'];
		expect(h.permissions.resolve('spawn_agent', {})).toBe('approval_required');
		expect(asked).toEqual([]);
		expect(declared(h.requests.look![0]!)).not.toContain('write');
		const refusal = h.requests.try![1]!.messages.find((m) => m.role === 'toolResult') as {
			content: { text: string }[];
		};
		expect(refusal.content[0]!.text).toMatch(/may not ask for approval/);
		expect(h.app.vault.text('notes/q.md')).toBeUndefined();
	});

	it('resume goes on with an earlier agent of this conversation, in its own session', async () => {
		const main: ScriptedTurn[] = [
			{ toolCalls: [spawn('count', 'How many notes?')] },
			{ text: 'Two.' },
		];
		const h = harness({
			main,
			count: [{ text: 'There are 2 notes.' }, { text: 'They are a.md and b.md.' }],
		});
		await h.controller.send('count them');
		const id = [...h.controller.agents.values()][0]!.sessionId!;
		// The script is read as it goes, so the follow-up can name the agent the first run made.
		main.push({ toolCalls: [spawn('count', 'Name them.', { resume: id })] }, { text: 'done' });
		await h.controller.send('which ones?');
		const followUp = h.requests.count![1]!;
		expect(texts(followUp)).toEqual(['How many notes?', 'There are 2 notes.', 'Name them.']);
		const log = await h.sessions.load(id);
		expect(log.filter((e) => e.type === 'user').length).toBe(2);
		// The resumed run goes on after its log: no two events share an index.
		const indexes = [...h.controller.agents.values()].at(-1)!.events.map((e) => e.index);
		expect(new Set(indexes).size).toBe(indexes.length);
	});

	it('resume refuses an agent of another conversation or one still at work', async () => {
		const h = harness({
			main: [{ toolCalls: [spawn('x', 'X.', { resume: 'nope' })] }, { text: 'done' }],
		});
		await h.controller.send('go');
		const [result] = (await h.toolResults()).filter((r) => r.name === 'spawn_agent');
		expect(result!.ok).toBe(false);
		expect(result!.content).toMatch(/No agent with agent_id nope in this conversation/);
	});

	it('the agent can write, edit and rewind a definition, and it always asks', async () => {
		const file = '.agents/agents/helper.md';
		const h = harness(
			{
				main: [
					{
						toolCalls: [
							{
								name: 'write',
								args: {
									path: file,
									content: '---\nname: helper\ndescription: Helps.\n---\nHelp.',
								},
							},
						],
					},
					{
						toolCalls: [
							{
								name: 'edit',
								args: { path: file, old_text: 'Helps.', new_text: 'Helps a lot.' },
							},
						],
					},
					{ text: 'Made the helper agent.' },
				],
			},
			{ write: 'always_allow', edit: 'always_allow' },
		);
		const asked: string[] = [];
		h.controller.subscribe((e) => {
			if (e.type === 'approval' && e.request) {
				asked.push(e.request.name);
				queueMicrotask(() => e.request!.resolve('approve'));
			}
		});
		await h.controller.send('make an agent');
		expect(asked).toEqual(['write', 'edit']);
		expect(h.defs.get('helper')!.description).toBe('Helps a lot.');
		const results = await h.toolResults();
		expect(JSON.parse(results[0]!.content)).toMatchObject({
			operation: 'created',
			agent: { name: 'helper' },
		});
		const user = h.controller.events.find((e) => e.event.type === 'user')!;
		const rewound = await h.controller.rewind(user.index);
		expect(rewound!.reverted).toContain(file);
		expect(h.app.vault.text(file)).toBeUndefined();
		expect(h.defs.get('helper')).toBeUndefined();
	});
});

describe('skills the agent makes (LIB-TEST-284)', () => {
	it('writes, fixes and rewinds a skill, asks every time, and each result says what it made', async () => {
		const file = '.agents/skills/tidy/SKILL.md';
		const h = harness(
			{
				main: [
					{
						toolCalls: [
							{
								name: 'write',
								args: { path: file, content: '---\nname: tidy\n---\nTidy notes.' },
							},
						],
					},
					{
						toolCalls: [
							{
								name: 'edit',
								args: {
									path: file,
									old_text: 'name: tidy\n',
									new_text: 'name: tidy\ndescription: Tidies notes.\n',
								},
							},
						],
					},
					{ text: 'Made the tidy skill.' },
				],
			},
			{ write: 'always_allow', edit: 'always_allow' },
		);
		const asked: string[] = [];
		h.controller.subscribe((e) => {
			if (e.type === 'approval' && e.request) {
				asked.push(e.request.name);
				queueMicrotask(() => e.request!.resolve('approve'));
			}
		});
		await h.controller.send('make a skill');
		expect(asked).toEqual(['write', 'edit']);
		const results = await h.toolResults();
		// The first try lacked a description; the result said so, and the fix names the skill.
		expect(JSON.parse(results[0]!.content)).toMatchObject({
			operation: 'created',
			skillProblem: 'Missing description',
		});
		expect(JSON.parse(results[1]!.content)).toMatchObject({ skill: { name: 'tidy' } });
		expect(h.skills.get('tidy')!.description).toBe('Tidies notes.');
		const user = h.controller.events.find((e) => e.event.type === 'user')!;
		const rewound = await h.controller.rewind(user.index);
		expect(rewound!.reverted).toContain(file);
		expect(h.app.vault.text(file)).toBeUndefined();
		expect(h.skills.get('tidy')).toBeUndefined();
	});

	it('rewind puts back a skill whose files the shell removed', async () => {
		const skill = '---\nname: old\ndescription: Old one.\n---\nSteps.';
		const h = harness(
			{ main: [{ text: 'ok' }] },
			{},
			{},
			{ '.agents/skills/old/SKILL.md': skill, '.agents/skills/old/references/r.md': 'ref' },
		);
		await h.skills.scan();
		await h.controller.send('go');
		const user = h.controller.events.find((e) => e.event.type === 'user')!;
		// What rm -r does to each file: the gate's snapshot, the removal, the snapshot closed.
		for (const [id, path] of [
			['rm1', '.agents/skills/old/SKILL.md'],
			['rm2', '.agents/skills/old/references/r.md'],
		] as const) {
			await h.controller.beforeMutation(id, path);
			await h.app.vault.adapter.remove(path);
			await h.controller.afterMutation(id, path);
		}
		await h.skills.scan();
		expect(h.skills.get('old')).toBeUndefined();
		await h.controller.reloadEvents();
		const rewound = await h.controller.rewind(user.index);
		expect(rewound!.reverted.sort()).toEqual([
			'.agents/skills/old/SKILL.md',
			'.agents/skills/old/references/r.md',
		]);
		expect(h.app.vault.text('.agents/skills/old/references/r.md')).toBe('ref');
		expect(h.skills.get('old')!.description).toBe('Old one.');
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

	it('findModel reads provider/model, and an ID or a name alone', () => {
		const options = [
			{ provider: { id: 'p' }, model: { id: 'nvidia/big:free', name: 'Big' } },
			{ provider: { id: 'q' }, model: { id: 'small', name: 'Small one' } },
		];
		expect(findModel(options, 'q/small')).toBe(options[1]);
		expect(findModel(options, 'nvidia/big:free')).toBe(options[0]);
		expect(findModel(options, 'small one')).toBe(options[1]);
		expect(findModel(options, 'missing')).toBeUndefined();
	});

	it('fitAnswer cuts the body of a long answer and keeps why it stopped and its agent_id', () => {
		const id = '\n\n[agent_id: s1]';
		expect(fitAnswer('short', id, 100)).toBe(`short${id}`);
		const long = `${'x'.repeat(500)}\n\n[Stopped after 3 tool iterations]`;
		const fitted = fitAnswer(long, id, 200);
		expect(fitted.length).toBeLessThanOrEqual(200);
		expect(fitted.endsWith(`\n\n[Stopped after 3 tool iterations]${id}`)).toBe(true);
		expect(fitted).toContain('[The rest of the answer did not fit in one result.]');
	});

	it('rewind puts back a note and a definition that a change removed', async () => {
		const def = '---\nname: x\ndescription: X.\n---\n';
		const h = harness({ main: [{ text: 'ok' }] }, {}, {}, { '.agents/agents/x.md': def });
		await h.controller.send('go');
		const user = h.controller.events.find((e) => e.event.type === 'user')!;
		// What the shell's rm does: the gate's snapshot, the removal, the snapshot closed.
		for (const [id, path] of [
			['rm1', 'notes/b.md'],
			['rm2', '.agents/agents/x.md'],
		] as const) {
			await h.controller.beforeMutation(id, path);
			await h.app.vault.adapter.remove(path);
			await h.controller.afterMutation(id, path);
		}
		await h.controller.reloadEvents();
		expect(h.controller.previewRewind(user.index)!.changes).toHaveLength(2);
		const rewound = await h.controller.rewind(user.index);
		expect(rewound!.reverted.sort()).toEqual(['.agents/agents/x.md', 'notes/b.md']);
		expect(h.app.vault.text('notes/b.md')).toBe('gamma');
		expect(h.app.vault.text('.agents/agents/x.md')).toBe(def);
	});

	it('a row from the log: waiting for approval, a resume under its own agent, the answer plain', () => {
		const call = { id: 'c1', name: SPAWN_AGENT_NAME, args: { title: 'Look', resume: 'x' } };
		expect(storedRow(call, undefined, true, { asking: true })).toMatchObject({
			status: 'asking',
			activity: 'Waiting for your approval',
			agent: 'general-purpose',
		});
		expect(storedRow(call, undefined, true, { agent: 'explore' })).toMatchObject({
			status: 'pending',
			agent: 'explore',
		});
		const done = storedRow(
			call,
			{
				ok: true,
				content: '- **Found** in [[notes/a|a]]\n\n[agent_id: s1]',
				agentSession: 's1',
			},
			false,
		);
		expect(done).toMatchObject({ status: 'done', activity: 'Found in a', sessionId: 's1' });
		expect(storedRow(call, undefined, false).status).toBe('failed');
	});
});
