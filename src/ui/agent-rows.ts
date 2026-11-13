import { setIcon } from 'obsidian';
import type { AgentColor } from '../agent/agent-definitions';
import { GENERAL_AGENT } from '../agent/agent-definitions';
import { answerOf, isStartNotice, type SubagentState } from '../agent/subagent';
import type { SessionEvent, StoredToolCall } from '../session/session-types';
import { summarizeCall } from './cards';
import { appendStreamDelta } from './stream-text';
import { firstLine, renderSpinner } from './work-log';

/**
 * A sub-agent run as the chat lists it (LIB-FEAT-140): one row on the timeline step that started
 * it, which opens its conversation. `asking` is a run waiting for the user's approval.
 */
export type AgentRowStatus =
	| 'pending'
	| 'waiting'
	| 'running'
	| 'asking'
	| 'done'
	| 'stopped'
	| 'failed';

export interface AgentRowData {
	callId: string;
	title: string;
	agent: string;
	color?: AgentColor;
	status: AgentRowStatus;
	/** One line: what it does now, or the start of its answer or of why it failed. */
	activity: string;
	sessionId: string | null;
}

export const AGENT_STATUS_LABELS: Record<AgentRowStatus, string> = {
	pending: 'Starting',
	waiting: 'Waiting for a slot',
	running: 'Working',
	asking: 'Waiting for your approval',
	done: 'Done',
	stopped: 'Stopped early',
	failed: 'Failed',
};

const STATUS_ICONS: Partial<Record<AgentRowStatus, string>> = {
	waiting: 'hourglass',
	asking: 'hand',
	done: 'check',
	stopped: 'circle-stop',
	failed: 'x',
};

/** The answer without the agent_id line the model gets after it. */
export function withoutAgentId(text: string): string {
	return text.replace(/\n*\[agent_id: [^\]]*\]\s*$/, '');
}

/**
 * The first line of Markdown as plain words, for a row's one line: no list mark or heading mark,
 * no emphasis or code marks, a link as its text.
 */
export function plainLine(text: string, max = 120): string {
	const line = text.split('\n').find((l) => l.trim()) ?? '';
	const plain = line
		.replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s+/, '')
		.replace(
			/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g,
			(_m, target: string, alias?: string) => alias || target,
		)
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/\*\*|__|`/g, '')
		.trim();
	return firstLine(plain, max);
}

/** What a running agent is doing, from its log and the response on its way. */
export function agentActivity(state: SubagentState): string {
	if (state.status === 'waiting') return AGENT_STATUS_LABELS.waiting;
	const last = state.events[state.events.length - 1]?.event;
	if (state.status === 'failed')
		return last?.type === 'error' ? plainLine(last.message) : AGENT_STATUS_LABELS.failed;
	if (state.status === 'done' || state.status === 'stopped') {
		for (let i = state.events.length - 1; i >= 0; i--) {
			const e = state.events[i]!.event;
			if (e.type === 'assistant' && e.content.trim()) return plainLine(e.content);
		}
		return AGENT_STATUS_LABELS[state.status];
	}
	if ([...state.toolStatus.values()].includes('awaiting-approval'))
		return AGENT_STATUS_LABELS.asking;
	const stream = state.stream;
	if (stream) {
		const calls = stream.content.filter((c) => c.type === 'toolCall');
		const call = calls[calls.length - 1];
		if (call) return call.name;
		if (stream.content.some((c) => c.type === 'text' && c.text)) return 'Writing the answer';
		if (stream.content.some((c) => c.type === 'thinking')) return 'Thinking';
	}
	for (let i = state.events.length - 1; i >= 0; i--) {
		const e = state.events[i]!.event;
		if (e.type !== 'tool_call') continue;
		const status = state.toolStatus.get(e.toolCallId);
		if (status === 'running' || status === 'pending')
			return `${e.name} ${summarizeCall(e.name, e.args, null)}`.trim();
		break;
	}
	return 'Waiting for the model';
}

export function statusOf(state: SubagentState): AgentRowStatus {
	if (state.status === 'running' && [...state.toolStatus.values()].includes('awaiting-approval'))
		return 'asking';
	return state.status;
}

/** A row from the run while it is in memory. */
export function liveRow(state: SubagentState): AgentRowData {
	return {
		callId: state.callId,
		title: state.title,
		agent: state.agent,
		...(state.color ? { color: state.color } : {}),
		status: statusOf(state),
		activity: agentActivity(state),
		sessionId: state.sessionId,
	};
}

/** What the log says of a spawn_agent call's agent: its answer, or only that it started. */
export interface StoredAgentResult {
	ok: boolean;
	content: string;
	agentSession?: string;
	/** The call's result says the agent started; no word of how it ended has come. */
	started?: boolean;
}

/**
 * The outcome of a spawn_agent call's agent as the log has it (LIB-FEAT-311): from the message
 * that told the main agent it had finished; else from the call's own result, which is the answer
 * in a log written before agents ran in the background and a start notice since.
 */
export function agentResultOf(
	result: { ok: boolean; content: string; agentSession?: string } | undefined,
	told: Extract<SessionEvent, { type: 'user' }> | undefined,
): StoredAgentResult | undefined {
	if (told?.agent)
		return {
			ok: told.agent.status !== 'failed',
			content: answerOf(told.content),
			agentSession: told.agent.sessionId ?? result?.agentSession,
		};
	return result && { ...result, started: isStartNotice(result.content) };
}

/**
 * A row from the log: the call's arguments and, once there, its agent's outcome. `agent` is the
 * one the call starts, which a resume names only through its agent_id; `asking` is a call still
 * waiting for the user's approval to start.
 */
export function storedRow(
	call: StoredToolCall,
	result: StoredAgentResult | undefined,
	running: boolean,
	{
		agent: named,
		color,
		asking = false,
	}: { agent?: string; color?: AgentColor; asking?: boolean } = {},
): AgentRowData {
	const args = call.args as { title?: unknown; agent?: unknown };
	const agent =
		named ??
		(typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : GENERAL_AGENT);
	const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : agent;
	const ended = result && !result.started ? result : undefined;
	const answer = ended ? withoutAgentId(ended.content) : '';
	const status: AgentRowStatus = ended
		? !ended.ok
			? 'failed'
			: /\n\n\[Stopped[^\]]*\]$/.test(answer)
				? 'stopped'
				: 'done'
		: running
			? asking
				? 'asking'
				: result
					? 'running'
					: 'pending'
			: result
				? 'stopped'
				: 'failed';
	return {
		callId: call.id,
		title,
		agent,
		...(color ? { color } : {}),
		status,
		activity: ended
			? plainLine(answer.replace(/^Error:\s*/, ''))
			: running
				? AGENT_STATUS_LABELS[status]
				: result
					? 'It did not finish.'
					: 'It did not run.',
		sessionId: result?.agentSession ?? null,
	};
}

/**
 * The row: the agent icon in its color, the title with the agent's name beside it, what it does
 * on a second line, and its state at the end. It opens the run's conversation.
 */
export function renderAgentRow(
	parent: HTMLElement,
	data: AgentRowData,
	open: (callId: string) => void,
): HTMLButtonElement {
	const row = parent.createEl('button', { cls: 'librarian-agent-row' });
	row.dataset.agentCallId = data.callId;
	const icon = row.createSpan({ cls: 'librarian-agent-row-icon' });
	setIcon(icon, 'bot');
	const text = row.createSpan({ cls: 'librarian-agent-row-text' });
	const head = text.createSpan({ cls: 'librarian-agent-row-head' });
	// Drawn at once: only what changes after (updateAgentRow) fades in.
	head.createSpan({ cls: 'librarian-agent-row-title', text: data.title });
	head.createSpan({ cls: 'librarian-agent-type', text: data.agent });
	text.createSpan({ cls: 'librarian-agent-row-activity', text: data.activity });
	row.createSpan({ cls: 'librarian-agent-row-mark' });
	row.addEventListener('click', () => open(data.callId));
	updateAgentRow(row, data);
	return row;
}

/**
 * The row with what its run holds now. Words its lines did not have fade in, as streamed text does
 * (LIB-FEAT-099): a title arriving with the call's arguments, what the agent does next. Only the
 * status class is swapped, so a fade still running stays.
 */
export function updateAgentRow(row: HTMLElement, data: AgentRowData): void {
	for (const status of Object.keys(AGENT_STATUS_LABELS)) row.removeClass(`is-${status}`);
	row.addClass(`is-${data.status}`);
	const icon = row.querySelector<HTMLElement>('.librarian-agent-row-icon');
	icon?.setAttr('class', `librarian-agent-row-icon${data.color ? ` is-${data.color}` : ''}`);
	for (const [cls, text] of [
		['.librarian-agent-row-title', data.title],
		['.librarian-agent-type', data.agent],
		['.librarian-agent-row-activity', data.activity],
	] as const) {
		const line = row.querySelector<HTMLElement>(cls);
		if (line && line.textContent !== text)
			appendStreamDelta(line, line.textContent ?? '', text);
	}
	// The line often says the state itself, such as Waiting for your approval: read it once.
	const label = AGENT_STATUS_LABELS[data.status];
	row.setAttr(
		'aria-label',
		`${data.title}, ${data.agent}: ${label}${data.activity && data.activity !== label ? `. ${data.activity}` : ''}`,
	);
	const mark = row.querySelector<HTMLElement>('.librarian-agent-row-mark');
	if (!mark || mark.dataset.status === data.status) return;
	mark.dataset.status = data.status;
	mark.empty();
	const name = STATUS_ICONS[data.status];
	if (name) setIcon(mark, name);
	else renderSpinner(mark);
}
