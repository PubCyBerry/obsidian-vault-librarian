/**
 * Sub-agents (LIB-ADR-017, LIB-FEAT-139): `spawn_agent` runs another Pi Agent in this runtime on a
 * self-contained task and returns its last message. The parent waits for it the way it waits for
 * any tool, so several calls in one response run side by side. After Codex's `spawn_agent`, without
 * the tools to message, wait for and close agents: a phone has no process to leave running.
 */

import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { IndexedEvent } from '../session/session-types';
import { tool } from '../tools/registry';
import type { ToolCardStatus } from './agent-controller';

export const SPAWN_AGENT_NAME = 'spawn_agent';

export interface SpawnArgs {
	name: string;
	task: string;
	fork_context?: boolean;
}

export type SubagentStatus = 'waiting' | 'running' | 'done' | 'stopped' | 'failed';

/** One sub-agent, as the chat shows it while it runs and right after (LIB-FEAT-140). */
export interface SubagentState {
	/** The spawn_agent call that started it. */
	callId: string;
	name: string;
	task: string;
	status: SubagentStatus;
	/** Its conversation in the shape of a session log: the task, then its work. */
	events: IndexedEvent[];
	/** Its response on the way. */
	stream: AssistantMessage | null;
	toolStatus: Map<string, ToolCardStatus>;
	/** Its session file, once made. */
	sessionId: string | null;
}

const DESCRIPTION = `Start a sub-agent: another Librarian with your tools, your permissions and a fresh context, which works on one self-contained task and returns its final answer as the result of this call. What it reads stays out of your context; only its answer comes back.

Use it when the user asks for sub-agents, or when a task splits into independent parts that each take many reads, such as one summary per note across many notes, or a review of your work with fresh eyes. Call spawn_agent several times in one response to run the agents side by side. Do not use it for a question one or two searches answer, and do not hand off the step you need next: do that yourself.

Write the task so it stands on its own: what to find or change, where to look, and the form of the answer, such as "list each open task with its note path and line". The sub-agent cannot ask you or the user anything and cannot start agents of its own. Give agents that change notes different notes to change.`;

/**
 * The tool. `run` does the work; it returns the agent's answer and its session, or throws with
 * why it could not answer.
 */
export function createSpawnAgentTool(
	run: (
		callId: string,
		args: SpawnArgs,
		signal?: AbortSignal,
	) => Promise<{ text: string; sessionId: string | null }>,
): AgentTool {
	return tool({
		name: SPAWN_AGENT_NAME,
		label: 'Run agent',
		description: DESCRIPTION,
		parameters: Type.Object({
			name: Type.String({
				minLength: 1,
				description: 'Short name the user sees for this agent, such as hub-notes.',
			}),
			task: Type.String({
				minLength: 1,
				description:
					'The whole task, standing on its own: the goal, where to look and the form of the answer.',
			}),
			fork_context: Type.Optional(
				Type.Boolean({
					description:
						'True starts the agent with this conversation so far, for a task that depends on it. Default false: the agent sees only the task.',
				}),
			),
		}),
		executionMode: 'parallel',
		async execute(callId, params, signal) {
			const { text, sessionId } = await run(callId, params, signal);
			// The session goes in the log with the result, so the chat can open it again later.
			return { content: [{ type: 'text', text }], details: { agentSession: sessionId } };
		},
	});
}

/** Appended to the parent's system prompt for a sub-agent. */
export function subagentSection(name: string): string {
	return `# Sub-agent

You are a sub-agent named ${name}. Another Librarian agent, the main agent, started you with the task in the last user message. Only the main agent reads your answer; the user does not see this conversation.
- Do that task and nothing else. Do not ask questions, since no one can answer them: decide with what you have and state the assumptions you made.
- Your last message is all the main agent receives. Make it complete on its own: the answer, and the vault paths with line ranges you relied on, as path/to/note.md:12-18. Do not refer to messages it cannot see.
- Other agents may work in the same vault at the same time. Do not undo or overwrite changes you did not make.
- You cannot start other agents.`;
}

/**
 * The parent's transcript as a sub-agent starts from it: without the system messages, which the
 * sub-agent writes for itself, and without the response calling spawn_agent, whose calls have no
 * results yet.
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

/** A name fit to show: one line, at most 40 characters. */
export function agentName(raw: unknown): string {
	const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
	return name || 'agent';
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
