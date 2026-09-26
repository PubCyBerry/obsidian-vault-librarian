import type { AssistantMessage } from '@earendil-works/pi-ai';
import { type App, Component, MarkdownRenderer, Menu, setIcon, TFile } from 'obsidian';
import type { ToolCardStatus } from '../agent/agent-controller';
import { SPAWN_AGENT_NAME } from '../agent/subagent';
import type { IndexedEvent, SessionEvent, StoredToolCall } from '../session/session-types';
import { type AgentRowData, renderAgentRow, updateAgentRow } from './agent-rows';
import {
	renderToolDetails,
	STATUS_LABELS,
	summarizeCall,
	type ToolCardData,
	toolIcon,
} from './cards';
import { ATTACHED_BLOCK } from './mentions';
import { linkSources, openSource } from './sources';
import { appendStreamDelta, StreamingMarkdown } from './stream-text';
import {
	formatDuration,
	groupRuns,
	grow,
	looksLikeAnswer,
	type PopoverContent,
	type Run,
	renderChip,
	renderMessage,
	renderSpinner,
	type Step,
	type StepPopover,
	setChipStatus,
	viewOf,
} from './work-log';

type ToolResult = Extract<SessionEvent, { type: 'tool_result' }>;

const CHIP_ICONS: Record<string, string> = {
	attached_note: 'file-text',
	attached_file: 'file',
	attached_folder: 'folder',
	skill_content: 'sparkles',
};

/** Which runs of a conversation are open or folded, and which steps were already shown. */
interface Folds {
	/** Finished runs the user opened. */
	open: Set<number>;
	/** The user folded the running run. */
	runningFolded: boolean;
	/** The run being worked on as last drawn, to fold it once it finishes. */
	runningKey: number | null;
	/** Steps of the running run already shown, so only new ones animate in. */
	seen: Set<string>;
}

function newFolds(): Folds {
	return { open: new Set(), runningFolded: false, runningKey: null, seen: new Set() };
}

/**
 * Where the response being streamed goes: its steps at the end of the running run's timeline, in
 * the order it writes them, thinking, then a note, then calls. Its text is a message chip from its
 * first words, or the answer under the block once it reads as one (LIB-ADR-041).
 */
interface Live {
	/** The run's work block, which the answer follows. */
	block: HTMLElement;
	timeline: HTMLElement;
	/** The response the steps below show, by when it began: another one starts them afresh. */
	response: number | null;
	thinking: HTMLElement | null;
	thinkingText: string;
	/** Thinking is still the part growing: no text and no call has come after it yet. */
	thinkingLive: boolean;
	/** Its text: `el` is the note's step on the timeline, or the answer under the block. */
	text: { el: HTMLElement; answer: boolean; markdown: StreamingMarkdown } | null;
	tools: HTMLElement | null;
	/** The calls as streamed so far, for their popovers. */
	calls: { id: string; name: string; args: Record<string, unknown> }[];
}

function compactTokens(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** What a pane reads from the rest of the view: the same for the chat's own and the agent pane. */
export interface PaneDeps {
	app: App;
	/** Owns what MarkdownRenderer adds while drawing the log; the view. */
	component: Component;
	/** The one popover of the view, which stays inside whichever pane shows. */
	popover: StepPopover;
	findReadLine: (path: string, line: number) => string | null;
	/** A spawn_agent call's row: from the run in memory while there is one, else from the log. */
	agentRowOf: (
		call: StoredToolCall,
		result: ToolResult | undefined,
		running: boolean,
	) => AgentRowData;
	openAgent: (callId: string) => void;
	/** A sub-agent run in memory reports its own rows; a status change only refreshes the others. */
	hasLiveAgent: (callId: string) => boolean;
}

export interface PaneOptions {
	/** Over each message on the right, who wrote it, when that is not the user. */
	asker?: string;
	/** The chat's own conversation offers rewinding to each of its messages. */
	rewind?: (index: number) => void;
	/** The running run's header gets a span saying what the agent is doing (the chat's own only). */
	activity?: boolean;
}

export interface DrawOptions {
	/** Its last run is still at work. */
	running: boolean;
	status: (toolCallId: string) => ToolCardStatus | undefined;
	/** The response on its way, drawn after the log; else the one last queued. */
	stream?: AssistantMessage | null;
	/** Shown in place of the runs when there are none. */
	emptyText?: string;
}

/**
 * One conversation drawn as runs (LIB-FEAT-252): the chat's own, or a sub-agent's in the agent pane
 * (LIB-FEAT-140). It keeps what a redraw must remember: which runs are folded, where the response
 * on its way goes, each step's popover and whether the user reads at the bottom.
 */
export class ConversationPane {
	private folds = newFolds();
	private live: Live | null = null;
	/** Auto-scroll follows new content only while the user is reading at the bottom. */
	followBottom = true;
	/** What the agent is doing, in the running run's header. */
	private activityEl: HTMLElement | null = null;
	/** Its words as last set, for the header a redraw makes anew. */
	private activity = '';
	/** Each drawn step's popover, by key, to open it again after a redraw. */
	private popFills = new Map<string, { anchor: HTMLElement; content: () => PopoverContent }>();
	/** The last saved response as last drawn, to tell when the streaming one has been saved. */
	private lastAssistant = -1;
	/** The log as last drawn, for the rows a status change refreshes. */
	private events: IndexedEvent[] = [];
	private statusOf: (toolCallId: string) => ToolCardStatus | undefined = () => undefined;
	private pendingStream: AssistantMessage | null = null;
	private streamTimer: number | null = null;

	constructor(
		readonly el: HTMLElement,
		private readonly deps: PaneDeps,
		private readonly opts: PaneOptions = {},
	) {
		el.addEventListener('scroll', () => {
			this.followBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
			deps.popover.reposition();
		});
		this.watchLinks(el);
	}

	/** Another conversation: nothing drawn so far is worth remembering. */
	reset(): void {
		this.folds = newFolds();
		this.lastAssistant = -1;
		this.activity = '';
	}

	/**
	 * What the agent is doing now, in the running run's header. A header drawn anew shows it at
	 * once; words that change after fade in, as streamed text does (LIB-FEAT-099).
	 */
	setActivity(text: string): void {
		this.activity = text;
		const el = this.activityEl;
		if (!el || el.textContent === text) return;
		// A narrow pane cuts it short; the whole text shows on hover.
		el.setAttr('aria-label', text);
		if (el.textContent) appendStreamDelta(el, el.textContent, text);
		else el.setText(text);
	}

	/** A run was drawn as still at work, so it has to be drawn again once it ends. */
	get hasRunningRun(): boolean {
		return this.folds.runningKey !== null;
	}

	dispose(): void {
		if (this.streamTimer !== null) window.clearTimeout(this.streamTimer);
	}

	/** Draws the whole log again, keeping the folds, the open popover and the reading position. */
	draw(events: IndexedEvent[], o: DrawOptions): void {
		const atBottom = this.followBottom;
		const scroll = this.el.scrollTop;
		this.el.empty();
		this.live = null;
		this.activityEl = null;
		this.popFills = new Map();
		this.events = events;
		this.statusOf = o.status;
		// The thinking read while it streamed is now the thinking of the response it was saved as.
		let lastAssistant = -1;
		for (const { index, event } of events)
			if (event.type === 'assistant') lastAssistant = index;
		const popover = this.deps.popover;
		if (popover.openKey === 'thinking:live' && lastAssistant > this.lastAssistant)
			popover.openKey = `thinking:${lastAssistant}:thinking`;
		this.lastAssistant = lastAssistant;
		if (o.emptyText && !events.length)
			this.el.createDiv({ cls: 'librarian-sessions-empty', text: o.emptyText });
		this.drawRuns(events, o.running, o.status);
		const stream = o.stream === undefined ? this.pendingStream : o.stream;
		if (stream) this.stream(stream, o.status);
		popover.reopen(
			(key) =>
				this.popFills.get(key) ?? (key === 'thinking:live' ? this.lastThinking() : null),
		);
		if (atBottom) this.scrollToBottom(true);
		else this.el.scrollTop = scroll;
	}

	/** Every run of a conversation: the message that asked, the work block, the answer. */
	private drawRuns(events: IndexedEvent[], stageRunning: boolean, status: DrawOptions['status']) {
		const results = new Map<string, ToolResult>();
		for (const { event } of events)
			if (event.type === 'tool_result') results.set(event.toolCallId, event);
		const runs = groupRuns(events);
		const folds = this.folds;
		const running = stageRunning ? (runs[runs.length - 1]?.key ?? null) : null;
		const finished =
			folds.runningKey !== null && folds.runningKey !== running ? folds.runningKey : null;
		if (running !== folds.runningKey) folds.runningFolded = false;
		folds.runningKey = running;
		for (const run of runs) {
			if (run.user) this.renderUser(run.key, run.user);
			this.renderRun(run, results, run.key === running, run.key === finished, status);
		}
	}

	/** The newest saved thinking step: where a live thinking popover goes once its stream ends. */
	private lastThinking(): { anchor: HTMLElement; content: () => PopoverContent } | null {
		let found: { anchor: HTMLElement; content: () => PopoverContent } | null = null;
		for (const [key, pop] of this.popFills)
			if (key.startsWith('thinking:') && key !== 'thinking:live') found = pop;
		return found;
	}

	/**
	 * One request's work (LIB-FEAT-252): a header that says Working, then how long it worked, a
	 * dotted timeline of what it did that folds under the header, and the answer below. The
	 * running run stays open until the user folds it; a finished one folds, animated when it has
	 * just finished, and stays open once the user opens it.
	 */
	private renderRun(
		run: Run,
		results: Map<string, ToolResult>,
		running: boolean,
		justFinished: boolean,
		status: DrawOptions['status'],
	) {
		const view = viewOf(run);
		// Before the first message there may be only a model change: nothing to show.
		if (!run.user && !view.steps.length && !view.errors.length && view.answer === null) return;
		const hasSteps = view.steps.length > 0;
		const folds = this.folds;
		const block = this.el.createDiv({ cls: 'librarian-work' });
		block.toggleClass('is-running', running);
		const header = block.createDiv({ cls: 'librarian-work-header' });
		if (running) renderSpinner(header);
		const took =
			view.startedAt !== null && view.endedAt !== null ? view.endedAt - view.startedAt : 0;
		header.createSpan({
			cls: 'librarian-work-title',
			text: running ? 'Working' : `Worked for ${formatDuration(took)}`,
		});
		const chevron = header.createSpan({ cls: 'librarian-work-chevron' });
		setIcon(chevron, 'chevron-right');
		if (running && this.opts.activity)
			this.activityEl = header.createSpan({
				cls: 'librarian-work-activity',
				text: this.activity,
				attr: { 'aria-label': this.activity },
			});
		const body = block.createDiv({ cls: 'librarian-work-body' });
		const timeline = body.createDiv({ cls: 'librarian-timeline' });
		for (const step of view.steps) this.renderStep(timeline, step, results, running, status);
		const userOpened = folds.open.has(run.key);
		const open = running ? !folds.runningFolded : userOpened || justFinished;
		block.toggleClass('is-collapsed', !open);
		// Nothing to unfold: a quick answer, or a run that has not done anything yet.
		block.toggleClass('is-empty', !hasSteps && !running);
		if (hasSteps || running) {
			header.setAttr('role', 'button');
			header.setAttr('tabindex', '0');
			header.setAttr('aria-expanded', String(open));
			const toggle = () => {
				const opening = block.hasClass('is-collapsed');
				block.toggleClass('is-collapsed', !opening);
				header.setAttr('aria-expanded', String(opening));
				if (running) folds.runningFolded = !opening;
				else if (opening) folds.open.add(run.key);
				else folds.open.delete(run.key);
				if (!opening) this.deps.popover.close();
			};
			header.addEventListener('click', toggle);
			header.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					toggle();
				}
			});
		}
		if (justFinished && !userOpened)
			window.requestAnimationFrame(() => {
				block.addClass('is-collapsed');
				header.setAttr('aria-expanded', 'false');
			});
		if (view.answer !== null) {
			const answer = this.el.createDiv({ cls: 'librarian-msg librarian-msg-assistant' });
			void this.renderMarkdown(answer.createDiv(), view.answer);
		}
		if (running)
			this.live = {
				block,
				timeline,
				response: null,
				thinking: null,
				thinkingText: '',
				thinkingLive: false,
				text: null,
				tools: null,
				calls: [],
			};
		for (const message of view.errors) this.renderStoredError(message);
	}

	private renderStep(
		timeline: HTMLElement,
		step: Step,
		results: Map<string, ToolResult>,
		running: boolean,
		status: DrawOptions['status'],
	) {
		const row = timeline.createDiv({ cls: `librarian-step is-${step.kind}` });
		if (running && !this.folds.seen.has(step.key)) row.addClass('librarian-step-new');
		if (running) this.folds.seen.add(step.key);
		switch (step.kind) {
			case 'thinking':
				this.stepButton(row, `thinking:${step.key}`, 'brain', 'Thinking', () => ({
					icon: 'brain',
					title: 'Thinking',
					text: step.text,
				}));
				break;
			case 'text':
				void this.renderMarkdown(renderMessage(row).text, step.text);
				break;
			case 'tools': {
				for (const call of step.calls) {
					if (call.name === SPAWN_AGENT_NAME) continue;
					const result = results.get(call.id);
					// A finished run's call with no result was cut off; it did not run.
					const shown =
						status(call.id) ??
						(result ? (result.ok ? 'ok' : 'failed') : running ? 'pending' : 'skipped');
					const chip = renderChip(row, call, shown);
					this.bindPopover(
						chip,
						`call:${call.id}`,
						this.toolContent(() => ({
							toolCallId: call.id,
							name: call.name,
							args: call.args,
							status: status(call.id) ?? shown,
							result: result?.content ?? null,
							truncated: result?.truncated ?? false,
						})),
					);
				}
				// Sub-agents stand in a list under the calls beside them: each has a line of its own
				// to say what it is doing, which a chip has no room for (LIB-FEAT-140).
				const agents = step.calls.filter((c) => c.name === SPAWN_AGENT_NAME);
				if (agents.length) {
					const card = row.createDiv({ cls: 'librarian-agents' });
					for (const call of agents)
						renderAgentRow(
							card,
							this.deps.agentRowOf(call, results.get(call.id), running),
							this.deps.openAgent,
						);
				}
				break;
			}
			case 'compaction':
				row.createSpan({
					cls: 'librarian-step-note',
					text: `Context compacted: ${compactTokens(step.before)} to ${compactTokens(step.after)}`,
				});
				break;
		}
	}

	/** A step shown by its icon and a short label; what it holds opens in the popover. */
	private stepButton(
		row: HTMLElement,
		key: string,
		icon: string,
		label: string,
		content: () => PopoverContent,
	): HTMLButtonElement {
		const button = row.createEl('button', { cls: 'librarian-chip librarian-step-button' });
		setIcon(button.createSpan({ cls: 'librarian-chip-icon' }), icon);
		button.createSpan({ cls: 'librarian-chip-name', text: label });
		this.bindPopover(button, key, content);
		return button;
	}

	private bindPopover(anchor: HTMLElement, key: string, content: () => PopoverContent) {
		anchor.dataset.popKey = key;
		anchor.setAttr('aria-haspopup', 'dialog');
		anchor.setAttr('aria-expanded', 'false');
		this.popFills.set(key, { anchor, content });
		anchor.addEventListener('click', () => this.deps.popover.toggle(anchor, content));
	}

	/** A tool call's popover: its name, summary and status over what it was given and got back. */
	private toolContent(data: () => ToolCardData): () => PopoverContent {
		return () => {
			const d = data();
			return {
				icon: toolIcon(d.name),
				title: d.name || 'Tool call',
				// A bash call's summary is its command, which the Command section already shows.
				subtitle: d.name === 'bash' ? undefined : summarizeCall(d.name, d.args, d.result),
				status: { text: STATUS_LABELS[d.status], cls: `is-${d.status}` },
				live: d.status === 'pending' || d.status === 'running',
				body: (el) => renderToolDetails(el, d),
			};
		};
	}

	/**
	 * Markdown with [[links]] and `path:line` sources that open their notes. A streaming drawing
	 * passes a component of its own that is never loaded: the renderer adds a child to it each
	 * time, which would otherwise pile up on the view for as long as it is open.
	 */
	private renderMarkdown(el: HTMLElement, text: string, component = this.deps.component) {
		const { app, findReadLine } = this.deps;
		el.addClass('librarian-markdown', 'markdown-rendered');
		return MarkdownRenderer.render(app, text, el, '', component).then(() => {
			linkSources(
				el,
				(ref) => void openSource(app, ref, findReadLine),
				(path) => app.vault.getFileByPath(path) !== null,
			);
		});
	}

	renderStoredError(message: string): void {
		const block = this.el.createDiv({ cls: 'librarian-error is-stored' });
		block.createDiv({ text: message });
	}

	/**
	 * A message on the right: the user's in the chat, the main agent's in the agent pane, which a
	 * caption above names. Only the chat's own messages rewind.
	 */
	private renderUser(index: number, event: Extract<SessionEvent, { type: 'user' }>) {
		if (this.opts.asker)
			this.el.createDiv({ cls: 'librarian-msg-asker', text: this.opts.asker });
		const wrap = this.el.createDiv({ cls: 'librarian-msg librarian-msg-user' });
		renderBubble(this.deps.app, wrap, event.content, event.images ?? []);
		const rewind = this.opts.rewind;
		if (!rewind) return;
		const button = wrap.createEl('button', {
			cls: 'clickable-icon librarian-rewind',
			attr: { 'aria-label': 'Rewind to here' },
		});
		setIcon(button, 'undo-2');
		button.addEventListener('click', () => rewind(index));
	}

	/** The response on its way, drawn at most every 120 ms; null when it ended. */
	queueStream(message: AssistantMessage | null, statusOf: DrawOptions['status']): void {
		this.statusOf = statusOf;
		if (message === null) {
			// The response ended. What it showed stays until the conversation is drawn again with
			// it saved, so nothing blinks out while it is written to the session; one asked again
			// clears it when it starts (stream).
			if (this.streamTimer !== null) {
				window.clearTimeout(this.streamTimer);
				this.streamTimer = null;
				if (this.pendingStream) this.stream(this.pendingStream, statusOf);
			}
			this.pendingStream = null;
			return;
		}
		this.pendingStream = message;
		if (this.streamTimer !== null) return;
		this.streamTimer = window.setTimeout(() => {
			this.streamTimer = null;
			if (this.pendingStream) this.stream(this.pendingStream, this.statusOf);
		}, 120);
	}

	/**
	 * Where text on its way goes, drawn as Markdown all along with only the new words fading in: a
	 * message chip at the end of the timeline that eases to each new size, or the answer's place
	 * under the block, where it stays once saved.
	 */
	private streamText(live: Live, answer: boolean): NonNullable<Live['text']> {
		const draw = (markdown: string, into: HTMLElement) =>
			this.renderMarkdown(into, markdown, new Component());
		const follow = () => this.scrollToBottom();
		if (answer) {
			const el = createDiv({ cls: 'librarian-msg librarian-msg-assistant' });
			live.block.after(el);
			const text = el.createDiv({ cls: 'librarian-markdown markdown-rendered' });
			return {
				el,
				answer,
				markdown: new StreamingMarkdown(text, draw, (swap) => {
					swap();
					follow();
				}),
			};
		}
		const el = live.timeline.createDiv({ cls: 'librarian-step is-text librarian-step-new' });
		live.timeline.insertBefore(el, live.tools);
		const { box, text } = renderMessage(el);
		return {
			el,
			answer,
			markdown: new StreamingMarkdown(text, draw, (swap) => {
				grow(box, text, swap, follow);
				follow();
			}),
		};
	}

	/**
	 * The response on its way: its thinking, its note and its tool calls grow the running run's
	 * timeline in the order it writes them. Its text is a note until it reads as the answer
	 * (streamText). `statusOf` knows the calls' states: the controller's for the chat, the run's own
	 * for a sub-agent.
	 */
	stream(message: AssistantMessage, statusOf: DrawOptions['status']): void {
		const live = this.live;
		if (!live) return;
		// Read again when a popover draws: the run may have been drawn anew since.
		const current = () => this.live;
		// Another response, such as one asked again after it failed: what the last one left goes.
		if (live.response !== null && live.response !== message.timestamp) {
			live.thinking?.remove();
			live.text?.el.remove();
			live.tools?.remove();
			Object.assign(live, {
				thinking: null,
				thinkingText: '',
				thinkingLive: false,
				text: null,
				tools: null,
				calls: [],
			});
		}
		live.response = message.timestamp;
		const thinking = message.content
			.filter((c) => c.type === 'thinking')
			.map((c) => (c as { thinking: string }).thinking)
			.join('');
		if (thinking && !live.thinking) {
			live.thinking = live.timeline.createDiv({
				cls: 'librarian-step is-thinking librarian-step-new',
			});
			const note = live.text && !live.text.answer ? live.text.el : null;
			live.timeline.insertBefore(live.thinking, note ?? live.tools);
			const chip = this.stepButton(
				live.thinking,
				'thinking:live',
				'brain',
				'Thinking',
				() => ({
					icon: 'brain',
					title: 'Thinking',
					live: current()?.thinkingLive === true,
					text: current()?.thinkingText ?? '',
				}),
			);
			// Turns while the thinking grows, as a running call's chip does, and goes when it stops.
			renderSpinner(chip.createSpan({ cls: 'librarian-chip-mark' }));
		}
		live.thinkingText = thinking;
		const text = message.content
			.filter((c) => c.type === 'text')
			.map((c) => (c as { text: string }).text)
			.join('');
		// A few characters first, so an opening mark such as ## has shown what the text is.
		const answer = looksLikeAnswer(text);
		if (text.trim().length >= 4 && (!live.text || (answer && !live.text.answer))) {
			live.text?.el.remove();
			live.text = this.streamText(live, answer);
		}
		live.text?.markdown.set(text);
		const calls = message.content.filter((c) => c.type === 'toolCall');
		live.calls = calls.map((c) => ({ id: c.id, name: c.name, args: c.arguments }));
		// A call that joins a row already on the timeline comes in the way the row did.
		const joining = live.tools !== null;
		if (calls.length && !live.tools)
			live.tools = live.timeline.createDiv({
				cls: 'librarian-step is-tools librarian-step-new',
			});
		calls.forEach((block, i) => {
			const tools = live.tools;
			if (!tools) return;
			const status: ToolCardStatus = statusOf(block.id) ?? 'pending';
			// Keyed by the call's place in the response: its id and name may still be arriving.
			const existing = tools.querySelector<HTMLElement>(`[data-stream-index="${i}"]`);
			const isAgent = block.name === SPAWN_AGENT_NAME;
			const call = { id: block.id, name: block.name, args: block.arguments };
			if (existing && existing.hasClass('librarian-agent-row') === isAgent) {
				if (isAgent) {
					existing.dataset.agentCallId = block.id;
					updateAgentRow(existing, this.deps.agentRowOf(call, undefined, true));
					return;
				}
				existing.dataset.toolCallId = block.id;
				const name = existing.querySelector<HTMLElement>('.librarian-chip-name');
				if (name && block.name && name.textContent !== block.name)
					appendStreamDelta(name, name.textContent ?? '', block.name);
				return;
			}
			// A chip whose name turned out to be spawn_agent becomes a row, as the log will show it.
			existing?.remove();
			if (isAgent) {
				const had = tools.querySelector<HTMLElement>('.librarian-agents');
				const card = had ?? tools.createDiv({ cls: 'librarian-agents' });
				const row = renderAgentRow(
					card,
					this.deps.agentRowOf(call, undefined, true),
					this.deps.openAgent,
				);
				row.dataset.streamIndex = String(i);
				if (joining) (had ? row : card).addClass('librarian-step-new');
				return;
			}
			const chip = renderChip(tools, { id: block.id, name: block.name }, status);
			chip.dataset.streamIndex = String(i);
			if (joining) chip.addClass('librarian-step-new');
			// Chips stay ahead of the agents' list, as they are drawn from the log.
			const agentsCard = tools.querySelector('.librarian-agents');
			if (agentsCard) tools.insertBefore(chip, agentsCard);
			this.bindPopover(
				chip,
				`call:${block.id || i}`,
				this.toolContent(() => {
					const now = current()?.calls[i] ?? call;
					return {
						toolCallId: now.id,
						name: now.name,
						args: now.args,
						status: statusOf(now.id) ?? status,
						result: null,
						truncated: false,
					};
				}),
			);
		});
		live.thinkingLive = thinking.length > 0 && !text && calls.length === 0;
		live.thinking
			?.querySelector('.librarian-chip-mark')
			?.toggleClass('is-hidden', !live.thinkingLive);
		// An open popover on a step still streaming shows what has arrived since it opened.
		const popover = this.deps.popover;
		const open = popover.openKey;
		if (
			open === 'thinking:live' ||
			(open?.startsWith('call:') &&
				live.tools?.querySelector(`[data-pop-key="${CSS.escape(open)}"]`))
		)
			popover.refresh();
		this.scrollToBottom();
	}

	/** A call moved on: its chip, and its row while its agent has not reported itself yet. */
	setToolStatus(toolCallId: string, status: ToolCardStatus): void {
		this.el
			.querySelectorAll<HTMLElement>(
				`.librarian-chip[data-tool-call-id="${CSS.escape(toolCallId)}"]`,
			)
			.forEach((chip) => {
				setChipStatus(chip, status);
			});
		// A spawn_agent call waiting for its approval, before its agent runs and reports itself.
		if (!this.deps.hasLiveAgent(toolCallId)) {
			const call = this.events
				.map((e) => e.event)
				.find((e) => e.type === 'tool_call' && e.toolCallId === toolCallId);
			if (call?.type === 'tool_call')
				this.updateAgentRows(
					toolCallId,
					this.deps.agentRowOf(
						{ id: toolCallId, name: call.name, args: call.args },
						undefined,
						true,
					),
				);
		}
		if (this.deps.popover.openKey === `call:${toolCallId}`) this.deps.popover.refresh();
	}

	/** The rows of one spawn_agent call, wherever they are drawn in this pane. */
	updateAgentRows(callId: string, data: AgentRowData): void {
		this.el
			.querySelectorAll<HTMLElement>(
				`.librarian-agent-row[data-agent-call-id="${CSS.escape(callId)}"]`,
			)
			.forEach((row) => {
				updateAgentRow(row, data);
			});
	}

	scrollToBottom(force = false): void {
		if (!force && !this.followBottom) return;
		this.followBottom = true;
		this.el.scrollTop = this.el.scrollHeight;
	}

	/**
	 * MarkdownRenderer draws [[links]] but leaves opening them to the view; a new tab keeps the chat
	 * where it is (LIB-FEAT-226). A web link offers its text and its address to copy (LIB-FEAT-244).
	 */
	private watchLinks(el: HTMLElement) {
		el.addEventListener('click', (e) => {
			const link = (e.target as HTMLElement).closest('a.internal-link');
			const target = link?.getAttribute('data-href') ?? link?.getAttribute('href');
			if (!target) return;
			e.preventDefault();
			void this.deps.app.workspace.openLinkText(target, '', 'tab');
		});
		el.addEventListener('contextmenu', (e) => {
			const link = (e.target as HTMLElement).closest('a.external-link');
			const href = link?.getAttribute('href');
			if (!link || !href) return;
			e.preventDefault();
			const copy = (text: string) => void navigator.clipboard.writeText(text);
			new Menu()
				.addItem((i) =>
					i
						.setTitle('Copy text')
						.setIcon('copy')
						.onClick(() => copy(link.textContent ?? '')),
				)
				.addItem((i) =>
					i
						.setTitle('Copy link')
						.setIcon('link')
						.onClick(() => copy(href)),
				)
				.showAtMouseEvent(e);
		});
	}
}

/** A user message as the conversation shows it: the typed text, then its chips and images. */
export function renderBubble(
	app: App,
	wrap: HTMLElement,
	content: string,
	images: readonly string[],
): void {
	const bubble = wrap.createDiv({ cls: 'librarian-bubble' });
	const chips: { tag: string; id: string }[] = [];
	const shown = content.replace(ATTACHED_BLOCK, (_m, tag: string, id: string) => {
		chips.push({ tag, id });
		return '';
	});
	bubble.createDiv({ cls: 'librarian-user-text', text: shown });
	for (const { tag, id } of chips) {
		const chip = bubble.createDiv({ cls: 'librarian-attached' });
		setIcon(chip.createSpan(), CHIP_ICONS[tag] ?? 'file-text');
		chip.createSpan({ text: ` ${id}` });
	}
	if (images.length) {
		const row = bubble.createDiv({ cls: 'librarian-msg-images' });
		for (const path of images) {
			const file = app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile)
				row.createEl('img', { attr: { src: app.vault.getResourcePath(file), alt: path } });
			else row.createSpan({ cls: 'librarian-image-missing', text: `Image missing: ${path}` });
		}
	}
}
