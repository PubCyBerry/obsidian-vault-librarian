/**
 * Sub-agents (LIB-ADR-017, LIB-FEAT-139): `spawn_agent` starts another Pi Agent in this runtime on
 * a self-contained task. The agent works in the background (LIB-ADR-050): the call returns at once
 * with the agent's id, the main agent and the user go on meanwhile, and the agent's last message
 * reaches the main agent as a message of its own when the agent has finished. After Codex's
 * `spawn_agent` and Claude Code's background agents, without tools to message, wait for and close
 * agents: the run waits by itself, and a follow-up goes through `resume`.
 */

import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { AgentOutcome, IndexedEvent } from '../session/session-types';
import { cutAt, tool } from '../tools/registry';
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

const USE = `Start a sub-agent: another Librarian with a fresh context, which works on one self-contained task with its own tools. What it reads stays out of your context; only its final answer comes back.

The agent works in the background. This call returns at once with its agent_id, and the answer arrives later as a message that begins with <agent_result agent_id="…">. Librarian sends you that message when the agent has finished; the user did not write it. Until then go on with work that does not depend on the answer, or, when nothing is left to do, say in a sentence what you are waiting for and end your reply: you are called again as soon as an agent finishes. Do not wait in a loop, do not start the same task again, and do not guess the answer.

Use it when the user asks for sub-agents, or when a task splits into independent parts that each take many reads, such as one summary per note across many notes, or a review of your work with fresh eyes. Agents run side by side, as many at once as the settings allow. Do not use it for a question one or two searches answer, and do not hand off the step you need next: do that yourself.

Write the task so it stands on its own: what to find or change, where to look, and the form of the answer, such as "list each open task with its note path and line". A sub-agent cannot ask you or the user anything, cannot start agents of its own and cannot talk to other sub-agents; pass what one found to another in its task. Give agents that change notes different notes to change.

To give an agent that has finished a follow-up with everything it did so far, call spawn_agent again with resume set to its agent_id and the follow-up as task.`;

/** How a spawn_agent result begins, now that it says the agent has started, not what it found. */
const STARTED = 'Started in the background.';

/** What the call returns: the agent is at work, and how its answer will come. */
export function startNotice(title: string): string {
	return `${STARTED} The agent "${title}" is working; its answer will arrive as a message that begins with <agent_result>. Go on with other work, or end your reply to wait for it.`;
}

/** A spawn_agent result that only says the agent started; one from before 2.21.0 is its answer. */
export function isStartNotice(content: string): boolean {
	return content.startsWith(STARTED);
}

/**
 * The message the main agent gets when an agent has finished (LIB-FEAT-311): its answer, or why
 * there is none, in a tag that names the agent. `budget` is how long one message may be.
 */
export function resultMessage(
	state: Pick<SubagentState, 'title' | 'agent' | 'sessionId'>,
	status: AgentOutcome['status'],
	text: string,
	budget = Number.POSITIVE_INFINITY,
): string {
	const attr = (value: string) => value.replace(/"/g, "'");
	const open = `<agent_result agent_id="${state.sessionId ?? ''}" title="${attr(state.title)}" agent="${attr(state.agent)}" status="${status}">\n`;
	return `${open}${fitAnswer(text, '', budget - open.length - 20)}\n</agent_result>`;
}

/** The answer inside such a message, as the chat shows it on the agent's row. */
export function answerOf(message: string): string {
	return /^<agent_result[^>]*>\n([\s\S]*)\n<\/agent_result>$/.exec(message)?.[1] ?? message;
}

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
 * An answer within `budget` characters. The body gives way, so the line saying why the agent
 * stopped and the agent_id after it stay: the controller cuts a longer result from the end, which
 * would take the id and with it the way to resume the agent.
 */
export function fitAnswer(text: string, tail: string, budget: number): string {
	if (text.length + tail.length <= budget) return text + tail;
	const stopped = /\n\n\[[^\]\n]*\]$/.exec(text)?.[0] ?? '';
	const note = '\n[The rest of the answer did not fit in one result.]';
	const room = Math.max(0, budget - stopped.length - tail.length - note.length);
	return `${cutAt(text.slice(0, text.length - stopped.length), room)}${note}${stopped}${tail}`;
}

/**
 * The tool, listing `agents`, the definitions the main agent may start. `run` starts the agent; it
 * returns what to tell the main agent and the agent's session, or throws with why it could not
 * start. `budget` is how long one result may be (`resultBudget`).
 */
export function createSpawnAgentTool(
	agents: readonly AgentDefinition[],
	run: (
		callId: string,
		args: SpawnArgs,
		signal?: AbortSignal,
	) => Promise<{ text: string; sessionId: string | null }>,
	budget = Number.POSITIVE_INFINITY,
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
			// The id closes the result so the model can name the agent, and goes in the log so the
			// chat can open its conversation later.
			const id = sessionId ? `\n\n[agent_id: ${sessionId}]` : '';
			return {
				content: [{ type: 'text', text: fitAnswer(text, id, budget) }],
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
