import { setIcon } from 'obsidian';
import type { ToolCardStatus } from '../agent/agent-controller';
import type { IndexedEvent, SessionEvent, StoredToolCall } from '../session/session-types';
import { STATUS_LABELS, toolIcon } from './cards';
import { appendStreamDelta } from './stream-text';

/**
 * One request and the work it took: the user's message and everything after it until the next
 * one (LIB-FEAT-252). Keyed by the index of that message, which rewinds keep stable.
 */
export interface Run {
	key: number;
	user: Extract<SessionEvent, { type: 'user' }> | null;
	events: IndexedEvent[];
}

export function groupRuns(events: readonly IndexedEvent[]): Run[] {
	const runs: Run[] = [];
	let current: Run | null = null;
	for (const e of events) {
		if (e.event.type === 'user') {
			current = { key: e.index, user: e.event, events: [] };
			runs.push(current);
		} else if (e.event.type !== 'meta') {
			if (!current) {
				current = { key: -1, user: null, events: [] };
				runs.push(current);
			}
			current.events.push(e);
		}
	}
	return runs;
}

/** One line of the timeline. Calls made together in one response share a line. */
export type Step =
	| { key: string; kind: 'thinking'; text: string }
	| { key: string; kind: 'text'; text: string }
	| { key: string; kind: 'tools'; calls: StoredToolCall[] }
	| { key: string; kind: 'compaction'; before: number; after: number };

export interface RunView {
	steps: Step[];
	/** The closing text, shown under the timeline: the last response when it called no tool. */
	answer: string | null;
	errors: string[];
	startedAt: number | null;
	endedAt: number | null;
}

const WORK_EVENTS = new Set<SessionEvent['type']>([
	'assistant',
	'tool_call',
	'approval',
	'tool_result',
	'compaction',
	'error',
]);

export function viewOf(run: Run): RunView {
	let last: IndexedEvent | null = null;
	for (const e of run.events) if (e.event.type === 'assistant') last = e;
	const closing =
		last?.event.type === 'assistant' && last.event.toolCalls.length === 0 && last.event.content
			? last
			: null;
	const steps: Step[] = [];
	const errors: string[] = [];
	for (const { index, event } of run.events) {
		if (event.type === 'assistant') {
			if (event.thinking)
				steps.push({ key: `${index}:thinking`, kind: 'thinking', text: event.thinking });
			if (event.content && index !== closing?.index)
				steps.push({ key: `${index}:text`, kind: 'text', text: event.content });
			if (event.toolCalls.length)
				steps.push({ key: `${index}:tools`, kind: 'tools', calls: event.toolCalls });
		} else if (event.type === 'compaction') {
			steps.push({
				key: `${index}:compaction`,
				kind: 'compaction',
				before: event.tokensBefore,
				after: event.tokensAfter,
			});
		} else if (event.type === 'error') {
			errors.push(event.message);
		}
	}
	// The work itself; a model change or a rename after the answer is not part of how long it took.
	const worked = run.events.filter((e) => WORK_EVENTS.has(e.event.type));
	const times = [run.user?.t, ...worked.map((e) => e.event.t)]
		.map((t) => (t ? Date.parse(t) : Number.NaN))
		.filter((n) => !Number.isNaN(n));
	return {
		steps,
		answer: closing?.event.type === 'assistant' ? closing.event.content : null,
		errors,
		startedAt: times.length ? times[0]! : null,
		endedAt: times.length ? times[times.length - 1]! : null,
	};
}

/** `42s`, `3m 22s`, `1h 5m`. */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The first line of a text, for a step that shows the rest on demand. */
export function firstLine(text: string, max = 80): string {
	const line = text.trim().split('\n', 1)[0] ?? '';
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * A spinner that turns in step with every other: made anew by a redraw, it carries on its turn
 * where it was instead of starting it again from the top, which reads as a stutter.
 */
export function renderSpinner(parent: HTMLElement): HTMLElement {
	const spinner = parent.createSpan({ cls: 'librarian-spinner' });
	spinner.setCssProps({ '--librarian-spin-delay': `${-Math.round(performance.now())}ms` });
	return spinner;
}

const STATUS_ICONS: Partial<Record<ToolCardStatus, string>> = {
	ok: 'check',
	failed: 'x',
	rejected: 'ban',
	blocked: 'ban',
	expired: 'clock',
	skipped: 'minus',
	'awaiting-approval': 'hand',
};

/** A tool call on the timeline: its icon and name, and a mark for how it went. */
export function renderChip(
	parent: HTMLElement,
	call: { id: string; name: string },
	status: ToolCardStatus,
): HTMLButtonElement {
	const chip = parent.createEl('button', { cls: 'librarian-chip' });
	chip.dataset.toolCallId = call.id;
	chip.dataset.popKey = `call:${call.id}`;
	setIcon(chip.createSpan({ cls: 'librarian-chip-icon' }), toolIcon(call.name));
	chip.createSpan({ cls: 'librarian-chip-name', text: call.name || '…' });
	chip.createSpan({ cls: 'librarian-chip-mark' });
	setChipStatus(chip, status);
	return chip;
}

export function setChipStatus(chip: HTMLElement, status: ToolCardStatus): void {
	chip.className = `librarian-chip is-${status}`;
	chip.setAttr(
		'aria-label',
		`${chip.querySelector('.librarian-chip-name')?.textContent ?? ''}: ${STATUS_LABELS[status]}`,
	);
	const mark = chip.querySelector<HTMLElement>('.librarian-chip-mark');
	if (!mark) return;
	mark.empty();
	const icon = STATUS_ICONS[status];
	if (icon) setIcon(mark, icon);
	else renderSpinner(mark);
}

/** What a step's popover shows. Read each time it is drawn, so a streaming step stays current. */
export interface PopoverContent {
	icon: string;
	title: string;
	/** A second line under the title, such as a tool call's summary. */
	subtitle?: string;
	/** A pill on the right: its words and a class that colors it. */
	status?: { text: string; cls: string };
	/** Still arriving: a spinner beside the title. The popover grows with it up to the room. */
	live?: boolean;
	/**
	 * Plain text such as thinking, drawn instead of `body`. What arrives while the popover is open
	 * is added to the end and fades in the way the answer does; what was there when it opened
	 * shows at once.
	 */
	text?: string;
	body?: (el: HTMLElement) => void;
}

/**
 * The one popover a step opens (LIB-FEAT-252): a header with the step's icon, title, summary,
 * status and a close button, and a body that scrolls. It stays inside the conversation area, as
 * wide as that allows up to 720px, under its step or above it, whichever has more room. Opening it
 * again, clicking elsewhere, the close button or Escape closes it. While its step streams it is
 * drawn again, following the end when the reader is there. After the conversation is drawn again
 * it comes back on the same step.
 */
export class StepPopover {
	private el: HTMLElement | null = null;
	private anchor: HTMLElement | null = null;
	private content: (() => PopoverContent) | null = null;
	private parts: {
		icon: HTMLElement;
		title: HTMLElement;
		spinner: HTMLElement;
		subtitle: HTMLElement;
		status: HTMLElement;
		body: HTMLElement;
		/** The body's text block while the content is `text`, kept so new text is only added. */
		text: HTMLElement | null;
	} | null = null;
	/** The step whose popover is open, to find it again after a redraw. */
	openKey: string | null = null;

	constructor(
		private readonly host: HTMLElement,
		/** The conversation area, which the popover may cover but not leave. */
		private readonly area: () => DOMRect,
	) {}

	toggle(anchor: HTMLElement, content: () => PopoverContent): void {
		const key = anchor.dataset.popKey ?? null;
		if (this.el && key !== null && key === this.openKey) {
			this.close();
			return;
		}
		this.open(anchor, content);
	}

	open(anchor: HTMLElement, content: () => PopoverContent): void {
		this.close();
		const el = this.host.createDiv({ cls: 'librarian-step-pop', attr: { role: 'dialog' } });
		const header = el.createDiv({ cls: 'librarian-step-pop-header' });
		const icon = header.createSpan({ cls: 'librarian-step-pop-icon' });
		const heading = header.createDiv({ cls: 'librarian-step-pop-heading' });
		const titleRow = heading.createDiv({ cls: 'librarian-step-pop-title' });
		const title = titleRow.createSpan();
		// Made once and only shown or hidden: a new one each redraw would restart its turn.
		const spinner = renderSpinner(titleRow);
		const subtitle = heading.createDiv({ cls: 'librarian-step-pop-subtitle' });
		const status = header.createSpan({ cls: 'librarian-step-pop-status' });
		const close = header.createEl('button', {
			cls: 'clickable-icon librarian-step-pop-close',
			attr: { 'aria-label': 'Close' },
		});
		setIcon(close, 'x');
		close.addEventListener('click', () => this.close());
		const body = el.createDiv({ cls: 'librarian-step-pop-body' });
		this.el = el;
		this.anchor = anchor;
		this.content = content;
		this.parts = { icon, title, spinner, subtitle, status, body, text: null };
		this.openKey = anchor.dataset.popKey ?? null;
		anchor.addClass('is-open');
		anchor.setAttr('aria-expanded', 'true');
		this.draw(true);
	}

	/** Draws it again with what its step holds now: more thinking, new arguments, a new status. */
	refresh(): void {
		if (this.el) this.draw(false);
	}

	/** Puts it back on the step with this key after a redraw, or forgets it if the step is gone. */
	reopen(find: (key: string) => { anchor: HTMLElement; content: () => PopoverContent } | null) {
		const key = this.openKey;
		const scroll = this.parts?.body.scrollTop ?? 0;
		this.el?.remove();
		this.el = null;
		this.anchor = null;
		this.openKey = null;
		const again = key ? find(key) : null;
		if (!again) return;
		this.open(again.anchor, again.content);
		if (this.parts) this.parts.body.scrollTop = scroll;
	}

	close(): void {
		this.el?.remove();
		this.anchor?.removeClass('is-open');
		this.anchor?.setAttr('aria-expanded', 'false');
		this.el = null;
		this.anchor = null;
		this.content = null;
		this.parts = null;
		this.openKey = null;
	}

	contains(target: EventTarget | null): boolean {
		return (
			target instanceof Node &&
			((this.el?.contains(target) ?? false) || (this.anchor?.contains(target) ?? false))
		);
	}

	private draw(first: boolean): void {
		const el = this.el;
		const parts = this.parts;
		if (!el || !parts || !this.content) return;
		const c = this.content();
		if (parts.icon.dataset.icon !== c.icon) {
			setIcon(parts.icon, c.icon);
			parts.icon.dataset.icon = c.icon;
		}
		if (parts.title.textContent !== c.title) parts.title.setText(c.title);
		parts.spinner.toggleClass('is-hidden', !c.live);
		parts.subtitle.setText(c.subtitle ?? '');
		parts.subtitle.toggleClass('is-hidden', !c.subtitle);
		parts.status.className = `librarian-step-pop-status ${c.status?.cls ?? ''}`;
		parts.status.setText(c.status?.text ?? '');
		parts.status.toggleClass('is-hidden', !c.status);
		const body = parts.body;
		const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
		const scroll = body.scrollTop;
		if (c.text !== undefined) {
			if (!parts.text) {
				body.empty();
				parts.text = body.createDiv({ cls: 'librarian-step-pop-text' });
			}
			// What was there when it opened shows at once; only what arrives after fades in.
			if (first) parts.text.setText(c.text);
			else appendStreamDelta(parts.text, parts.text.textContent ?? '', c.text);
		} else {
			parts.text = null;
			body.empty();
			c.body?.(body);
		}
		body.scrollTop = !first && atEnd ? body.scrollHeight : scroll;
		this.reposition();
	}

	/** Follows its step when the conversation scrolls, and fits what it holds now. */
	reposition(): void {
		const el = this.el;
		const anchor = this.anchor;
		if (!el || !anchor) return;
		const host = this.host.getBoundingClientRect();
		const area = this.area();
		const at = anchor.getBoundingClientRect();
		const width = Math.min(720, area.width - 16);
		const left = Math.min(Math.max(area.left + 8, at.left), area.right - width - 8);
		const below = area.bottom - at.bottom - 14;
		const above = at.top - area.top - 14;
		const onBelow = below >= Math.min(el.scrollHeight, 360) || below >= above;
		// A step scrolled out of view leaves more room than the area has; the area bounds it.
		const room = Math.min(area.height - 16, Math.max(160, onBelow ? below : above));
		el.setCssProps({
			'--librarian-pop-left': `${left - host.left}px`,
			'--librarian-pop-width': `${width}px`,
			'--librarian-pop-max': `${room}px`,
		});
		const height = el.offsetHeight;
		const top = onBelow ? at.bottom + 6 : at.top - 6 - height;
		// A step scrolled half out of view still gets its popover inside the conversation.
		const inside = Math.max(area.top + 8, Math.min(top, area.bottom - height - 8));
		el.setCssProps({ '--librarian-pop-top': `${inside - host.top}px` });
	}
}
