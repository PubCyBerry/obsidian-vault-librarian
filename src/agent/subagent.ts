/**
 * Sub-agents (LIB-ADR-017, LIB-FEAT-139): `spawn_agent` runs another Pi Agent in this runtime on a
 * self-contained task and returns its last message. The main agent waits for it the way it waits
 * for any tool, so several calls in one response run side by side. After Codex's `spawn_agent` and
 * Claude Code's agent files, without tools to message, wait for and close agents: a phone has no
 * process to leave running, and a follow-up goes through `resume` instead.
 */

import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { IndexedEvent } from '../session/session-types';
import { tool } from '../tools/registry';
import type { ToolCardStatus } from './agent-controller';
import type { AgentColor, AgentDefinition } from './agent-definitions';
import { GENERAL_AGENT } from './agent-definitions';

export const SPAWN_AGENT_NAME = 'spawn_agent';

export interface SpawnArgs {
	/** Which definition; absent means general-purpose. */
	agent?: string;
	title: string;
	task: string;
	fork_context?: boolean;
	/** The agent_id of an earlier run in this conversation, to go on with it. */
	resume?: string;
}

export type SubagentStatus = 'waiting' | 'running' | 'done' | 'stopped' | 'failed';

/** One sub-agent run, as the chat shows it while it works and right after (LIB-FEAT-140). */
export interface SubagentState {
	/** The spawn_agent call that started it. */
	callId: string;
	/** What this run is about, in a few words, from the main agent. */
	title: string;
	/** The definition it runs as. */
	agent: string;
	color?: AgentColor;
	task: string;
	status: SubagentStatus;
	/** Its conversation in the shape of a session log: the task, then its work. */
	events: IndexedEvent[];
	/** Its response on the way. */
	stream: AssistantMessage | null;
	toolStatus: Map<string, ToolCardStatus>;
	/** Its session file, once made; also its agent_id for `resume`. */
	sessionId: string | null;
}

const USE = `Start a sub-agent: another Librarian with a fresh context, which works on one self-contained task with its own tools and returns its final answer as the result of this call. What it reads stays out of your context; only its answer comes back.

Use it when the user asks for sub-agents, or when a task splits into independent parts that each take many reads, such as one summary per note across many notes, or a review of your work with fresh eyes. Each call returns only when its agent has finished, so agents started in separate responses run one after another: to run agents side by side, put all their spawn_agent calls in the same response. Do not use it for a question one or two searches answer, and do not hand off the step you need next: do that yourself.

Write the task so it stands on its own: what to find or change, where to look, and the form of the answer, such as "list each open task with its note path and line". A sub-agent cannot ask you or the user anything, cannot start agents of its own and cannot talk to other sub-agents; pass what one found to another in its task. Give agents that change notes different notes to change.

Each result ends with [agent_id: …]. To give that agent a follow-up with everything it did so far, call spawn_agent again with resume set to that id and the follow-up as task.`;

const DEFINITIONS = `Agents are Markdown files under .agents/agents/ in the vault: YAML frontmatter with name and description, and optionally tools and disallowedTools (lists of tool names; a trailing * matches a prefix), model (the ID of a model in Settings, or provider/model; leave it out to use your model), effort, maxTurns, permissionMode (default, plan for read-only, or dontAsk to refuse calls that need approval), skills (preloaded) and color; then the agent's instructions, which replace the Custom system prompt. Read, write and edit them like notes, and delete one with bash rm; changes to them always ask the user.`;

/** The agents it can start, each by name and what it is for, cut short to keep the list small. */
function catalog(agents: readonly AgentDefinition[]): string {
	return agents
		.map((a) => {
			const text =
				a.description.length > 200 ? `${a.description.slice(0, 200)}…` : a.description;
			return `- ${a.name}: ${text}`;
		})
		.join('\n');
}

/**
 * The tool, listing `agents`, the definitions the main agent may start. `run` does the work; it
 * returns the agent's answer and its session, or throws with why it could not answer.
 */
export function createSpawnAgentTool(
	agents: readonly AgentDefinition[],
	run: (
		callId: string,
		args: SpawnArgs,
		signal?: AbortSignal,
	) => Promise<{ text: string; sessionId: string | null }>,
): AgentTool {
	return tool({
		name: SPAWN_AGENT_NAME,
		label: 'Run agent',
		description: `${USE}\n\nAgents you can start:\n${catalog(agents)}\n\n${DEFINITIONS}`,
		parameters: Type.Object({
			agent: Type.Optional(
				Type.String({
					description: `Name of the agent to start, from the list. Default ${GENERAL_AGENT}.`,
				}),
			),
			title: Type.String({
				minLength: 1,
				description: 'What this run is about in 3 to 5 words, which the user sees.',
			}),
			task: Type.String({
				minLength: 1,
				description:
					'The whole task, standing on its own: the goal, where to look and the form of the answer. With resume, the follow-up.',
			}),
			fork_context: Type.Optional(
				Type.Boolean({
					description:
						'True starts the agent with this conversation so far, for a task that depends on it. Default false: the agent sees only the task.',
				}),
			),
			resume: Type.Optional(
				Type.String({
					description:
						'agent_id from an earlier result in this conversation, to go on with that agent.',
				}),
			),
		}),
		executionMode: 'parallel',
		async execute(callId, params, signal) {
			const { text, sessionId } = await run(callId, params, signal);
			// The id closes the answer so the model can resume the agent, and goes in the log so the
			// chat can open its conversation later.
			return {
				content: [
					{
						type: 'text',
						text: sessionId ? `${text}\n\n[agent_id: ${sessionId}]` : text,
					},
				],
				details: { agentSession: sessionId },
			};
		},
	});
}

/** Appended to a sub-agent's system prompt: what it is and how it answers. */
export function subagentSection(title: string, agent: string): string {
	return `# Sub-agent

You are a sub-agent, the ${agent} agent, working on "${title}". Another Librarian agent, the main agent, started you with the task in the last user message. Only the main agent reads your answer; the user does not see this conversation.
- Do that task and nothing else. Do not ask questions, since no one can answer them: decide with what you have and state the assumptions you made.
- Your last message is all the main agent receives. Make it complete on its own: the answer, and the vault paths with line ranges you relied on, as path/to/note.md:12-18. Do not refer to messages it cannot see.
- Other agents may work in the same vault at the same time. Do not undo or overwrite changes you did not make.
- You cannot start other agents or talk to them.`;
}

/**
 * The main agent's transcript as a sub-agent starts from it: without the system messages, which
 * the sub-agent writes for itself, and without the response calling spawn_agent, whose calls have
 * no results yet.
 */
export function forkMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	let end = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === 'assistant') {
			end = i;
			break;
		}
	}
	return messages.slice(0, end).filter((m) => m.role !== 'system');
}

/** A title fit to show: one line, at most 60 characters. */
export function runTitle(raw: unknown, agent: string): string {
	const title = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
	return title || agent;
}

/** At most `max()` holders at once; the rest wait in order for a place. */
export class Slots {
	private held = 0;
	private readonly waiting: (() => void)[] = [];

	constructor(private readonly max: () => number) {}

	/** Resolves with a place, or rejects when `signal` aborts first. */
	take(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(new Error('Operation aborted'));
		if (this.held < Math.max(1, this.max())) {
			this.held++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const go = () => {
				signal?.removeEventListener('abort', onAbort);
				this.held++;
				resolve();
			};
			const onAbort = () => {
				const i = this.waiting.indexOf(go);
				if (i >= 0) this.waiting.splice(i, 1);
				reject(new Error('Operation aborted'));
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			this.waiting.push(go);
		});
	}

	release(): void {
		this.held--;
		while (this.held < Math.max(1, this.max())) {
			const next = this.waiting.shift();
			if (!next) return;
			next();
		}
	}
}
