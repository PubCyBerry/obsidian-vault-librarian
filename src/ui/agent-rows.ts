import { setIcon } from 'obsidian';
import type { AgentColor } from '../agent/agent-definitions';
import { GENERAL_AGENT } from '../agent/agent-definitions';
import type { SubagentState } from '../agent/subagent';
import type { StoredToolCall } from '../session/session-types';
import { summarizeCall } from './cards';
import { firstLine } from './work-log';

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

/**
 * A row from the log: the call's arguments and, once there, its result. `agent` is the one the
 * call starts, which a resume names only through its agent_id; `asking` is a call still waiting
 * for the user's approval to start.
 */
export function storedRow(
	call: StoredToolCall,
	result: { ok: boolean; content: string; agentSession?: string } | undefined,
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
	const answer = result ? withoutAgentId(result.content) : '';
	const status: AgentRowStatus = result
		? !result.ok
			? 'failed'
			: /\n\n\[Stopped[^\]]*\]$/.test(answer)
				? 'stopped'
				: 'done'
		: running
			? asking
				? 'asking'
				: 'pending'
			: 'failed';
	return {
		callId: call.id,
		title,
		agent,
		...(color ? { color } : {}),
		status,
		activity: result
			? plainLine(answer.replace(/^Error:\s*/, ''))
			: running
				? AGENT_STATUS_LABELS[status]
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
	head.createSpan({ cls: 'librarian-agent-row-title' });
	head.createSpan({ cls: 'librarian-agent-type' });
	text.createSpan({ cls: 'librarian-agent-row-activity' });
	row.createSpan({ cls: 'librarian-agent-row-mark' });
	row.addEventListener('click', () => open(data.callId));
	updateAgentRow(row, data);
	return row;
}

export function updateAgentRow(row: HTMLElement, data: AgentRowData): void {
	row.className = `librarian-agent-row is-${data.status}`;
	const icon = row.querySelector<HTMLElement>('.librarian-agent-row-icon');
	icon?.setAttr('class', `librarian-agent-row-icon${data.color ? ` is-${data.color}` : ''}`);
	row.querySelector('.librarian-agent-row-title')?.setText(data.title);
	row.querySelector('.librarian-agent-type')?.setText(data.agent);
	const activity = row.querySelector<HTMLElement>('.librarian-agent-row-activity');
	if (activity && activity.textContent !== data.activity) activity.setText(data.activity);
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
	else mark.createSpan({ cls: 'librarian-spinner' });
}
