import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
	createInitialSystemMessage,
	toToolDeclaration,
} from '@earendil-works/pi-ai/utils/transcript';
import {
	type ActiveSelection,
	clampThinkingLevel,
	type PiModel,
	selectableThinkingLevels,
	toPiModel,
} from '../provider/provider-manager';
import { replay } from '../session/session-manager';
import type { AgentOutcome, SessionEvent, SessionEventInput } from '../session/session-types';
import { resultBudget } from '../tools/registry';
import type { ThinkingLevel } from '../types';
import { wasHiddenSince, whenVisible } from '../visibility';
import type { AgentController, ToolCardStatus } from './agent-controller';
import { type AgentDefinition, GENERAL_AGENT, toolsFor } from './agent-definitions';
import { systemPromptOf } from './prompt';
import {
	forkMessages,
	resultMessage,
	runTitle,
	Slots,
	SPAWN_AGENT_NAME,
	type SpawnArgs,
	type SubagentState,
	startNotice,
	subagentSection,
} from './subagent';
import {
	assistantEvent,
	findModel,
	freshLimits,
	isStreamCut,
	type LoopLimits,
	MAX_BACKGROUND_RESUMES,
	messageOf,
	RETRY_DELAY_MS,
	rewriteProviderError,
	textOf,
	withErrorPrefix,
} from './turn';

/**
 * Runs sub-agents for the controller (LIB-FEAT-139): each spawn_agent call gets a Pi Agent of its
 * own, run to its end under the user's permissions, with its own loop limits, AGENTS.md
 * deliveries and session file. The controller lends it the model, the tools, the permission gate
 * and the event bus; this keeps the runs of the latest turn.
 */
export class SubagentRunner {
	/** Sub-agents of the latest run, by the spawn_agent call that started each. */
	readonly agents = new Map<string, SubagentState>();
	private readonly slots: Slots;
	/** Which sub-agent made a call, for the approvals its shell commands ask for. */
	private readonly callOwner = new Map<string, SubagentState>();
	/** The agents at work, each by the promise of its end. */
	private readonly working = new Set<Promise<void>>();
	/** Agents that ended and whose word has not reached the main agent yet (LIB-FEAT-311). */
	private readonly finished: { text: string; outcome: AgentOutcome }[] = [];

	constructor(private readonly c: AgentController) {
		// One set of places for every session: Max sub-agents counts the device (LIB-FEAT-274).
		this.slots = c.deps.agentSlots ?? new Slots(() => c.deps.settings().maxSubagents);
	}

	/** The agents of the run before are in the log now; the chat reads them from there. */
	forget(): void {
		this.agents.clear();
		this.callOwner.clear();
		this.finished.length = 0;
	}

	/** The sub-agent that made a call, for a shell command asking from inside it. */
	ownerOf(toolCallId: string): SubagentState | undefined {
		return this.callOwner.get(toolCallId);
	}

	private emitAgent(state: SubagentState): void {
		this.c.emit({ type: 'agent', agent: state });
	}

	/** One event of a sub-agent: into its session file, and into what the chat draws it from. */
	async log(state: SubagentState, event: SessionEventInput): Promise<void> {
		if (state.sessionId) await this.c.deps.sessions.append(state.sessionId, event);
		const stored: SessionEvent = { t: new Date().toISOString(), ...event };
		// After the log a resume starts from, whose indexes count its meta event too.
		const last = state.events[state.events.length - 1];
		state.events.push({ index: last ? last.index + 1 : 0, event: stored });
		this.emitAgent(state);
	}

	/**
	 * The agent a spawn_agent call starts, which its permission is judged by: the one it names, or
	 * the one of the run it resumes, as this conversation's log recorded it.
	 */
	agentOfCall(args: unknown): string {
		const a = (args ?? {}) as { agent?: unknown; resume?: unknown };
		const resume = typeof a.resume === 'string' ? a.resume.trim() : '';
		if (!resume)
			return typeof a.agent === 'string' && a.agent.trim() ? a.agent.trim() : GENERAL_AGENT;
		for (const run of this.agents.values()) if (run.sessionId === resume) return run.agent;
		const events = this.c.events;
		const result = events.find(
			(e) => e.event.type === 'tool_result' && e.event.agentSession === resume,
		)?.event as { toolCallId: string } | undefined;
		const call = events.find(
			(e) => e.event.type === 'tool_call' && e.event.toolCallId === result?.toolCallId,
		)?.event as { args?: { agent?: unknown } } | undefined;
		const agent = call?.args?.agent;
		return typeof agent === 'string' && agent.trim() ? agent.trim() : GENERAL_AGENT;
	}

	/** Resolves once every agent that was started has wound up, as after Stop. */
	async settled(): Promise<void> {
		await Promise.allSettled([...this.working]);
	}

	/** An agent of this run waits for a place or is at work. */
	get busy(): boolean {
		for (const run of this.agents.values())
			if (run.status === 'waiting' || run.status === 'running') return true;
		return false;
	}

	/** The agents that finished since the last call, each with the message that says how. */
	takeFinished(): { text: string; outcome: AgentOutcome }[] {
		return this.finished.splice(0);
	}

	/**
	 * spawn_agent: starts one sub-agent and returns at once (LIB-ADR-050); its last message comes
	 * later, through `takeFinished`. It runs as its definition says (LIB-FEAT-268), under the
	 * user's permissions, with its own loop limits, AGENTS.md deliveries and session; `resume` goes
	 * on in the session of an earlier run of this conversation. Past `maxSubagents` it waits for a
	 * place. `signal` ends it with the run that started it.
	 */
	async start(
		callId: string,
		args: SpawnArgs,
		signal?: AbortSignal,
	): Promise<{ text: string; sessionId: string | null }> {
		const c = this.c;
		if (!c.selection || !c.session) throw new Error('No model is selected.');
		const task = typeof args.task === 'string' ? args.task.trim() : '';
		if (!task) throw new Error('task must not be empty');
		const type = this.agentOfCall(args);
		const def = c.deps.agentDefinition?.(type);
		if (!def)
			throw new Error(
				`No agent named ${type}. Start one that the spawn_agent description lists.`,
			);
		const resume =
			typeof args.resume === 'string' && args.resume.trim() ? args.resume.trim() : null;
		if (resume) await this.checkResume(resume);
		// A model without a key fails the call, so the main agent hears of it now.
		const { selection, level } = this.agentModel(def);
		const state: SubagentState = {
			callId,
			title: runTitle(args.title, def.name),
			agent: def.name,
			...(def.color ? { color: def.color } : {}),
			task,
			status: 'waiting',
			events: [],
			stream: null,
			toolStatus: new Map(),
			sessionId: resume,
		};
		// Its session exists before the call returns, so the result can name it.
		if (!state.sessionId)
			state.sessionId = (
				await c.deps.sessions.create({
					providerId: selection.provider.id,
					modelId: selection.model.id,
					thinkingLevel: level,
					parentId: c.session.id,
					parentCallId: callId,
					agentType: def.name,
					agentTitle: state.title,
				})
			).id;
		this.agents.set(callId, state);
		this.emitAgent(state);
		// The conversation as it stands now: by the time the agent gets a place it has moved on.
		const forked = args.fork_context === true ? forkMessages(c.mainMessages()) : [];
		const work = this.work(state, def, forked, signal).finally(() => this.working.delete(work));
		this.working.add(work);
		return { text: startNotice(state.title), sessionId: state.sessionId };
	}

	/** One agent from its place in line to its end, and the word of it to the main agent. */
	private async work(
		state: SubagentState,
		def: AgentDefinition,
		forked: AgentMessage[],
		signal?: AbortSignal,
	): Promise<void> {
		let text: string;
		let held = false;
		try {
			await this.slots.take(signal);
			held = true;
			text = await this.drive(state, def, forked, signal);
		} catch (error) {
			state.status = 'failed';
			text = signal?.aborted ? 'Operation aborted' : rewriteProviderError(messageOf(error));
			await this.log(state, { type: 'error', stage: 'provider', message: text });
		} finally {
			state.stream = null;
			if (held) this.slots.release();
		}
		this.emitAgent(state);
		// A stopped run has nobody left to tell.
		if (signal?.aborted) return;
		const status =
			state.status === 'done' || state.status === 'stopped' ? state.status : 'failed';
		this.finished.push({
			text: resultMessage(state, status, text, resultBudget(this.c.deps.settings())),
			outcome: { callId: state.callId, sessionId: state.sessionId, status },
		});
		this.c.wake();
	}

	/** Only an agent this conversation started, and not while that agent is still at work. */
	private async checkResume(id: string): Promise<void> {
		const summary = await this.c.deps.sessions.summary(id);
		if (!summary?.parentId || summary.parentId !== this.c.session?.id)
			throw new Error(`No agent with agent_id ${id} in this conversation.`);
		for (const run of this.agents.values())
			if (run.sessionId === id && (run.status === 'waiting' || run.status === 'running'))
				throw new Error(`The agent ${id} is still working. Wait for its answer first.`);
	}

	/** The model an agent runs on and its thinking level: its definition's, else the main ones. */
	private agentModel(def: AgentDefinition): { selection: ActiveSelection; level: ThinkingLevel } {
		const c = this.c;
		// A model Settings lacks falls back to the main one, as the definition's scan warned.
		const selection =
			(def.model && findModel(c.deps.providers.listSelectable(), def.model)) || c.selection!;
		if (c.deps.secrets.get(selection.provider.secretId) === null)
			throw new Error(`No API key for ${selection.provider.name} on this device.`);
		const levels = selectableThinkingLevels(selection.model);
		// Neither fits: as close to off as the model goes, which is off when it can stop thinking.
		const level =
			[def.effort, c.thinkingLevel].find((l) => l && levels.includes(l)) ??
			clampThinkingLevel(selection.model, 'off');
		return { selection, level };
	}

	/**
	 * An agent's instructions: its own or the Custom system prompt, the vault root AGENTS.md, the
	 * skills when it can read them, the skills it preloads, and what a sub-agent is.
	 */
	private async agentPrompt(
		def: AgentDefinition,
		title: string,
		tools: AgentTool[],
	): Promise<string> {
		const { deps } = this.c;
		const s = deps.settings();
		const parts = [
			deps.prompt.buildSystemPrompt({
				systemPrompt: def.prompt ?? systemPromptOf(s),
				vaultAgentsMd: await deps.prompt.loadVaultAgentsMd(s.useVaultAgentsMd),
				skillCatalog: tools.some((t) => t.name === 'read') ? deps.skillCatalog() : '',
			}),
		];
		const preloaded: string[] = [];
		for (const name of def.skills ?? []) {
			const text = await deps.skillActivation?.(name);
			if (text) preloaded.push(text);
		}
		if (preloaded.length) parts.push(`# Preloaded skills\n\n${preloaded.join('\n\n')}`);
		parts.push(subagentSection(title, def.name));
		return parts.join('\n\n');
	}

	/** Runs the agent to its end and returns its answer, with why it stopped early if it did. */
	private async drive(
		state: SubagentState,
		def: AgentDefinition,
		forked: AgentMessage[],
		signal?: AbortSignal,
	): Promise<string> {
		const c = this.c;
		const { selection, level } = this.agentModel(def);
		const model = toPiModel(selection.provider, selection.model);
		// A resumed agent goes on from its own log, which the chat shows whole.
		const prior = state.sessionId
			? replay(await c.deps.sessions.load(state.sessionId)).filter(
					(e) => e.event.type !== 'meta',
				)
			: [];
		state.events = [...prior];
		state.status = 'running';
		await this.log(state, { type: 'user', content: state.task });
		// Its definition's tools, bar spawn_agent: one level of agents only. A tool it may not
		// have is not in its list, so the model never sees it.
		const tools = () =>
			toolsFor(
				def,
				c.exposedTools(),
				c.deps.permissions.getExposedTools(c.deps.registeredTools?.() ?? c.deps.tools()),
				c.deps.readsOnly ?? (() => false),
			).filter((t) => t.name !== SPAWN_AGENT_NAME);
		const prompt = await this.agentPrompt(def, state.title, tools());
		const leading = createInitialSystemMessage(prompt, tools().map(toToolDeclaration));
		const history = prior.length
			? await c.deps.context.project({ events: prior, model })
			: forked;
		const limits: LoopLimits = { ...freshLimits(), max: def.maxTurns };
		const nested = c.deps.nestedAgentsMd?.fork(forked.length > 0);
		let requestStart = Date.now();
		const agent = new Agent({
			initialState: {
				model,
				thinkingLevel: level,
				tools: tools(),
				messages: leading ? [leading, ...history] : history,
			},
			streamFn: c.streamFor(selection, level),
			toolExecution: c.deps.settings().toolExecution,
			beforeToolCall: (ctx, sig) =>
				this.beforeToolCall(state, def, ctx.toolCall.id, ctx.toolCall.name, ctx.args, sig),
			afterToolCall: (ctx, sig) =>
				c.afterToolCall(
					ctx.toolCall.id,
					ctx.toolCall.name,
					ctx.args,
					ctx.result.content,
					ctx.isError,
					sig,
					limits,
					nested,
				),
			// No compaction here: an agent whose context fills up stops and answers with the rest.
			finishTurn: (ctx, sig) =>
				sig?.aborted === true ||
				c.shouldStopAfterTurn(ctx.toolResults.length, limits, false) ||
				(ctx.toolResults.length > 0 && this.contextFull(ctx.message, model, limits))
					? { action: 'end' }
					: undefined,
			prepareNextTurnWithContext: (ctx) => ({
				context: { messages: ctx.context.messages, tools: tools() },
			}),
		});
		agent.subscribe(async (event) => {
			if (event.type === 'turn_start') requestStart = Date.now();
			else if (
				(event.type === 'message_start' || event.type === 'message_update') &&
				event.message.role === 'assistant'
			) {
				state.stream = event.message;
				this.emitAgent(state);
			} else if (event.type === 'message_end') await this.logMessage(state, event.message);
		});
		const onAbort = () => agent.abort();
		signal?.addEventListener('abort', onAbort);
		try {
			// Stop may have come while the agent was being set up, before anyone listened.
			if (signal?.aborted) throw new Error('Operation aborted');
			await agent.prompt(state.task);
			// A request that died while the app was away, or whose stream the network cut, is asked
			// again as the main agent's would be.
			let resumes = 0;
			let cutRetries = 0;
			for (;;) {
				const last = agent.state.messages[agent.state.messages.length - 1];
				if (signal?.aborted || last?.role !== 'assistant' || last.stopReason !== 'error')
					break;
				if (wasHiddenSince(requestStart) && resumes < MAX_BACKGROUND_RESUMES) {
					resumes++;
					await whenVisible(signal);
				} else if (isStreamCut(last.errorMessage) && cutRetries < 1) {
					cutRetries++;
					await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAY_MS));
				} else break;
				if (signal?.aborted) break;
				agent.state.messages = agent.state.messages.slice(0, -1);
				await agent.continue();
			}
		} finally {
			signal?.removeEventListener('abort', onAbort);
		}
		if (signal?.aborted) throw new Error('Operation aborted');
		const last = [...agent.state.messages]
			.reverse()
			.find((m): m is AssistantMessage => m.role === 'assistant');
		if (last?.stopReason === 'error')
			throw new Error(
				rewriteProviderError(last.errorMessage ?? 'Request failed', c.keyless(selection)),
			);
		const text = textOf(last?.content ?? []).trim();
		if (limits.stopReason) {
			state.status = 'stopped';
			await this.log(state, { type: 'error', stage: 'tool', message: limits.stopReason });
			return `${text || 'The agent stopped before it wrote an answer.'}\n\n[${limits.stopReason}]`;
		}
		state.status = 'done';
		return text || 'The agent finished without an answer.';
	}

	/**
	 * A sub-agent's call: the user's permission for it, and an approval card that says who asks.
	 * An agent defined with permissionMode dontAsk is refused instead of asking.
	 */
	private async beforeToolCall(
		state: SubagentState,
		def: AgentDefinition,
		toolCallId: string,
		name: string,
		args: unknown,
		signal?: AbortSignal,
	) {
		const c = this.c;
		this.callOwner.set(toolCallId, state);
		const set = (status: ToolCardStatus) => {
			state.toolStatus.set(toolCallId, status);
			this.emitAgent(state);
		};
		if (
			def.permissionMode === 'dontAsk' &&
			c.deps.permissions.resolve(name, args) === 'approval_required'
		) {
			set('rejected');
			return {
				block: true,
				reason: `The ${def.name} agent may not ask for approval, and this call needs it. Do the task without it.`,
			};
		}
		const gate = await c.authorize(toolCallId, name, args, signal, set, { agent: state });
		// The run goes on, whatever the card that came and went: the main agent with its tools,
		// or the agents alone while it waits for them.
		if (c.isRunning && !c.pendingApproval) c.emit({ type: 'state', state: 'tool-running' });
		if (!gate.ok) {
			set(gate.status);
			return { block: true, reason: gate.reason };
		}
		set('running');
		return undefined;
	}

	/** The context is as full as the main agent's would be before it compacted. */
	private contextFull(message: AssistantMessage, model: PiModel, limits: LoopLimits) {
		const u = message.usage;
		const used = u.totalTokens || u.input + u.cacheRead + u.output;
		if (this.c.deps.context.usageFor(used, model).state !== 'critical') return false;
		limits.stopReason = 'Stopped: the context of this agent is full';
		return true;
	}

	private async logMessage(state: SubagentState, m: AgentMessage): Promise<void> {
		if (m.role === 'assistant') {
			state.stream = null;
			// A failed response is asked again or ends the agent; run logs why.
			if (m.stopReason === 'error') {
				this.emitAgent(state);
				return;
			}
			const entry = assistantEvent(m);
			await this.log(state, entry);
			for (const call of entry.toolCalls) {
				if (!state.toolStatus.has(call.id)) state.toolStatus.set(call.id, 'pending');
				await this.log(state, {
					type: 'tool_call',
					toolCallId: call.id,
					name: call.name,
					args: call.args,
				});
			}
		} else if (m.role === 'toolResult') {
			const current = state.toolStatus.get(m.toolCallId);
			if (!current || ['pending', 'running', 'awaiting-approval'].includes(current))
				state.toolStatus.set(m.toolCallId, m.isError ? 'failed' : 'ok');
			await this.log(state, {
				type: 'tool_result',
				toolCallId: m.toolCallId,
				name: m.toolName,
				ok: !m.isError,
				content: withErrorPrefix(textOf(m.content), m.isError),
				truncated: this.c.truncatedResults.delete(m.toolCallId),
			});
		}
	}
}
