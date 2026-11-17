import type { AssistantMessage } from '@earendil-works/pi-ai';
import { type App, Component, MarkdownRenderer, Menu, setIcon, TFile } from 'obsidian';
import type { AgentUiState, ToolCardStatus } from '../agent/agent-controller';
import { SPAWN_AGENT_NAME } from '../agent/subagent';
import { estimateText } from '../context/context-manager';
import type { IndexedEvent, SessionEvent, StoredToolCall } from '../session/session-types';
import {
	type AgentRowData,
	agentResultOf,
	renderAgentRow,
	type StoredAgentResult,
	updateAgentRow,
} from './agent-rows';
import {
	renderToolDetails,
	STATUS_LABELS,
	summarizeCall,
	type ToolCardData,
	toolIcon,
} from './cards';
import { ATTACHED_BLOCK } from './mentions';
import { Orb, type OrbState } from './orb';
import { linkSources, openSource } from './sources';
import { appendStreamDelta, StreamingMarkdown } from './stream-text';
import {
	compactCount,
	firstLine,
	formatDuration,
	groupRuns,
	grow,
	lastLine,
	looksLikeAnswer,
	type PopoverContent,
	place,
	type Run,
	renderChip,
	renderMessage,
	type Step,
	type StepPopover,
	setChipStatus,
	thoughtHeading,
	updateChip,
	viewOf,
	workMood,
} from './work-log';

type ToolResult = Extract<SessionEvent, { type: 'tool_result' }>;

const CHIP_ICONS: Record<string, string> = {
	attached_note: 'file-text',
	attached_file: 'file',
	attached_folder: 'folder',
	skill_content: 'sparkles',
};

/** Which runs of a conversation are open or folded. */
interface Folds {
	/** Finished runs the user opened. */
	open: Set<number>;
	/** The user folded the running run. */
	runningFolded: boolean;
	/** The run being worked on as last drawn, to draw it again once it finishes. */
	runningKey: number | null;
}

function newFolds(): Folds {
	return { open: new Set(), runningFolded: false, runningKey: null };
}

/**
 * A run's work block on the page. A drawing goes on with the block the last one left instead of
 * making another, so a line that is already there neither blinks nor comes in again.
 */
interface Block {
	el: HTMLElement;
	header: HTMLElement;
	timeline: HTMLElement;
	/** When the message that asked for the run was sent: another message is another run. */
	asked: string;
	/** As its header was last made: at work, with an orb, or done; null before the first. */
	running: boolean | null;
	orb: Orb | null;
	title: HTMLElement | null;
	meta: HTMLElement | null;
	/** What the header of a run at work shows now, and since when: a new one waits its turn. */
	shown: { orb: OrbState | null; at: number };
}

/**
 * How long the header of a run at work holds what it says before it says the next thing, so a
 * call that is over in a moment does not flash by and the orb changes its motion seldom.
 */
const HOLD_MS = 1200;

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
		result: StoredAgentResult | undefined,
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
	/** What the chat adds to the running run's header, as last set (workMood's `said`). */
	private said = '';
	/**
	 * The running run's header (LIB-FEAT-308): its orb, what it is doing, and how long the run has
	 * taken and how many tokens it has written, counted from the log up to the response on its way.
	 * `topic` is the heading of the run's latest saved thought (LIB-FEAT-321).
	 */
	private head: {
		block: Block;
		orb: Orb;
		title: HTMLElement;
		meta: HTMLElement;
		startedAt: number;
		tokens: number;
		topic: string | null;
	} | null = null;
	/** Draws the header again once what it shows has held long enough. */
	private holdTimer: number | null = null;
	/** The agent's state as last told; null where only the stream is known, as in the agent pane. */
	private mood: AgentUiState | null = null;
	/** The response on its way, as an estimate of its tokens. */
	private liveTokens = 0;
	/** Each drawn step's popover, by key, to open it again after a redraw. */
	private popFills = new Map<string, { anchor: HTMLElement; content: () => PopoverContent }>();
	/** The last saved response as last drawn, to tell when the streaming one has been saved. */
	private lastAssistant = -1;
	/** The log as last drawn, for the rows a status change refreshes. */
	private events: IndexedEvent[] = [];
	private statusOf: (toolCallId: string) => ToolCardStatus | undefined = () => undefined;
	private pendingStream: AssistantMessage | null = null;
	/** The messages that told the main agent a sub-agent had finished, by its spawn_agent call. */
	private told = new Map<string, Extract<SessionEvent, { type: 'user' }>>();
	private streamTimer: number | null = null;
	/**
	 * What the drawing under way has put on the page, by what it is, with what it shows; `last` is
	 * what the one before it did. An element that still shows the same is kept where it stands.
	 */
	private kept = new Map<string, { el: HTMLElement; sig: string }>();
	private last = new Map<string, { el: HTMLElement; sig: string }>();
	/** The work blocks, by their run, in the same two generations. */
	private blocks = new Map<number, Block>();
	private lastBlocks = new Map<number, Block>();

	constructor(
		readonly el: HTMLElement,
		private readonly deps: PaneDeps,
		private readonly opts: PaneOptions = {},
	) {
		el.addEventListener('scroll', () => {
			this.followBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
			deps.popover.reposition();
		});
		// One listener for every line that opens a popover: a line kept from one drawing to the
		// next opens what it holds now, without listening twice.
		el.addEventListener('click', (e) => {
			const anchor = (e.target as HTMLElement).closest<HTMLElement>('[data-pop-key]');
			const fill = this.popFills.get(anchor?.dataset.popKey ?? '');
			if (anchor && fill) deps.popover.toggle(anchor, fill.content);
		});
		this.watchLinks(el);
		// The header of a run at work counts its seconds.
		deps.component.registerInterval(window.setInterval(() => this.renderHead(), 1000));
	}

	/** Another conversation: nothing drawn so far is worth remembering. */
	reset(): void {
		this.folds = newFolds();
		this.lastAssistant = -1;
		this.said = '';
	}

	/** The agent's state now, and what the chat adds to the running run's header (workMood). */
	setActivity(said: string, state: AgentUiState | null = null): void {
		this.said = said;
		this.mood = state;
		this.renderHead();
	}

	/**
	 * The running run's header as it stands now: its orb's motion, what it is doing, its time and
	 * tokens. What it is doing changes once the last has held for HOLD_MS (LIB-FEAT-321): the new
	 * words fade in as streamed text does (LIB-FEAT-099) and the orb dissolves into its new motion.
	 */
	private renderHead(): void {
		const head = this.head;
		if (!head?.title.isConnected) return;
		const topic = thoughtHeading(this.live?.thinkingText ?? '') ?? head.topic;
		const { title, orb } = workMood(
			this.mood,
			this.live?.thinkingLive === true,
			topic,
			this.said,
		);
		const shown = head.block.shown;
		if (title !== head.title.textContent || orb !== shown.orb) {
			const wait = shown.at + HOLD_MS - Date.now();
			if (wait <= 0) {
				// A header made anew starts in its motion; one at work dissolves into the next.
				head.orb.set(orb, shown.orb !== null);
				appendStreamDelta(head.title, head.title.textContent ?? '', title);
				// Cut short in a narrow pane; the whole of it shows on hover.
				head.title.setAttr('aria-label', title);
				head.block.shown = { orb, at: Date.now() };
			} else
				this.holdTimer ??= window.setTimeout(() => {
					this.holdTimer = null;
					this.renderHead();
				}, wait);
		}
		const tokens = head.tokens + this.liveTokens;
		const meta = `${formatDuration(Date.now() - head.startedAt)}${tokens ? `, ${compactCount(tokens)} tokens` : ''}`;
		if (head.meta.textContent !== meta) head.meta.setText(meta);
	}

	/** A run was drawn as still at work, so it has to be drawn again once it ends. */
	get hasRunningRun(): boolean {
		return this.folds.runningKey !== null;
	}

	dispose(): void {
		if (this.streamTimer !== null) window.clearTimeout(this.streamTimer);
		if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
	}

	/**
	 * The element the last drawing made for `key`, as long as it still shows `sig`; else one made
	 * anew. Kept, it stays where it stands: nothing blinks, and no fade or entrance plays again.
	 */
	private keep(
		key: string,
		sig: string,
		make: () => HTMLElement,
	): { el: HTMLElement; made: boolean } {
		const had = this.last.get(key);
		const made = had?.sig !== sig;
		const el = had && !made ? had.el : make();
		this.kept.set(key, { el, sig });
		return { el, made };
	}

	/**
	 * Draws the log, keeping the folds, the open popover and the reading position. What the last
	 * drawing put on the page stays there as long as it shows the same: only what the log has
	 * gained or changed since is made or updated (LIB-FEAT-315).
	 */
	draw(events: IndexedEvent[], o: DrawOptions): void {
		const atBottom = this.followBottom;
		const scroll = this.el.scrollTop;
		// The response that was on its way has shown its steps already: saved, they do not come in again.
		const streamed = this.live?.response != null;
		this.last = this.kept;
		this.kept = new Map();
		this.lastBlocks = this.blocks;
		this.blocks = new Map();
		this.live = null;
		this.head = null;
		// What the last response wrote is in the log now, counted from there.
		this.liveTokens = 0;
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
		const nodes: HTMLElement[] = [];
		const emptyText = o.emptyText;
		if (emptyText && !events.length)
			nodes.push(
				this.keep('empty', emptyText, () =>
					createDiv({ cls: 'librarian-sessions-empty', text: emptyText }),
				).el,
			);
		nodes.push(...this.drawRuns(events, o.running, o.status, streamed));
		// What is left of a response on its way, an approval card or an error goes with this.
		place(this.el, nodes);
		this.last = new Map();
		this.lastBlocks = new Map();
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
	private drawRuns(
		events: IndexedEvent[],
		stageRunning: boolean,
		status: DrawOptions['status'],
		streamed: boolean,
	): HTMLElement[] {
		const results = new Map<string, ToolResult>();
		this.told = new Map();
		for (const { event } of events) {
			if (event.type === 'tool_result') results.set(event.toolCallId, event);
			// The word that a sub-agent finished, by the call that started it (LIB-FEAT-311).
			else if (event.type === 'user' && event.agent) this.told.set(event.agent.callId, event);
		}
		const runs = groupRuns(events);
		const folds = this.folds;
		const running = stageRunning ? (runs[runs.length - 1]?.key ?? null) : null;
		if (running !== folds.runningKey) folds.runningFolded = false;
		folds.runningKey = running;
		const nodes: HTMLElement[] = [];
		for (const run of runs) {
			if (run.user) nodes.push(...this.drawUser(run.key, run.user));
			nodes.push(...this.drawRun(run, results, run.key === running, status, streamed));
		}
		return nodes;
	}

	/** The newest saved thinking step: where a live thinking popover goes once its stream ends. */
	private lastThinking(): { anchor: HTMLElement; content: () => PopoverContent } | null {
		let found: { anchor: HTMLElement; content: () => PopoverContent } | null = null;
		for (const [key, pop] of this.popFills)
			if (key.startsWith('thinking:') && key !== 'thinking:live') found = pop;
		return found;
	}

	/** A work block with nothing in it yet: its header, which folds it, and its timeline. */
	private makeBlock(key: number, asked: string): Block {
		// On the page from the start: an orb reads its color there and moves only while it is on it.
		const el = this.el.createDiv({ cls: 'librarian-work' });
		const header = el.createDiv({ cls: 'librarian-work-header' });
		const timeline = el
			.createDiv({ cls: 'librarian-work-body' })
			.createDiv({ cls: 'librarian-timeline' });
		const toggle = () => {
			// Nothing to unfold: a quick answer.
			if (el.hasClass('is-empty')) return;
			const opening = el.hasClass('is-collapsed');
			el.toggleClass('is-collapsed', !opening);
			header.setAttr('aria-expanded', String(opening));
			if (el.hasClass('is-running')) this.folds.runningFolded = !opening;
			else if (opening) this.folds.open.add(key);
			else this.folds.open.delete(key);
			if (!opening) this.deps.popover.close();
		};
		header.addEventListener('click', toggle);
		header.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				toggle();
			}
		});
		return {
			el,
			header,
			timeline,
			asked,
			running: null,
			orb: null,
			title: null,
			meta: null,
			shown: { orb: null, at: 0 },
		};
	}

	/**
	 * The block's header for a run at work or a run done. At work: the orb, what it is doing, and
	 * the time and tokens so far (renderHead). Done: a mark and how long it took.
	 */
	private makeHeader(block: Block, running: boolean): void {
		const header = block.header;
		header.empty();
		block.orb = running ? new Orb(header) : null;
		if (!block.orb) setIcon(header.createSpan({ cls: 'librarian-work-mark' }), 'asterisk');
		block.title = header.createSpan({ cls: 'librarian-work-title' });
		block.meta = running ? header.createSpan({ cls: 'librarian-work-meta' }) : null;
		setIcon(header.createSpan({ cls: 'librarian-work-chevron' }), 'chevron-right');
		// A header made anew says what the run does at once, without waiting its turn.
		block.shown = { orb: null, at: 0 };
		block.running = running;
	}

	/**
	 * One request's work (LIB-FEAT-252): a header that says Working, then how long it worked, a
	 * timeline of what it did that folds under the header, and the answer below. The running run
	 * stays open until the user folds it; a finished one folds, and stays open once the user opens
	 * it. The run's block from the last drawing is gone on with: its header is made again only when
	 * the run starts or ends, and its timeline gains the steps it lacks.
	 */
	private drawRun(
		run: Run,
		results: Map<string, ToolResult>,
		running: boolean,
		status: DrawOptions['status'],
		streamed: boolean,
	): HTMLElement[] {
		const view = viewOf(run);
		// Before the first message there may be only a model change: nothing to show.
		if (!run.user && !view.steps.length && !view.errors.length && view.answer === null)
			return [];
		// Agents that finished together are told of one after another: the work follows the last.
		if (run.user?.agent && !run.events.length && !running) return [];
		const asked = run.user?.t ?? '';
		const had = this.lastBlocks.get(run.key);
		// One taken off the page, as when the agent pane is closed, has an orb that stopped: made anew.
		const block =
			had?.asked === asked && had.el.isConnected ? had : this.makeBlock(run.key, asked);
		this.blocks.set(run.key, block);
		const { el, header } = block;
		if (block.running !== running) {
			this.makeHeader(block, running);
			el.toggleClass('is-running', running);
			// A block that was open at work folds here, eased by its transition.
			el.toggleClass(
				'is-collapsed',
				running ? this.folds.runningFolded : !this.folds.open.has(run.key),
			);
		}
		if (running && block.orb && block.title && block.meta) {
			let topic: string | null = null;
			for (const step of view.steps)
				if (step.kind === 'thinking') topic = thoughtHeading(step.text) ?? topic;
			this.head = {
				block,
				orb: block.orb,
				title: block.title,
				meta: block.meta,
				startedAt: view.startedAt ?? Date.now(),
				tokens: run.events.reduce(
					(n, e) => n + (e.event.type === 'assistant' ? (e.event.usage?.output ?? 0) : 0),
					0,
				),
				topic,
			};
			this.renderHead();
		} else if (block.title) {
			const took =
				view.startedAt !== null && view.endedAt !== null
					? view.endedAt - view.startedAt
					: 0;
			const text = `Worked for ${formatDuration(took)}`;
			if (block.title.textContent !== text) block.title.setText(text);
		}
		// A step new to a block already on the page comes in, unless a stream has just shown it.
		const fresh = running && had === block && !streamed;
		place(
			block.timeline,
			view.steps.map((step) => this.drawStep(step, results, running, status, fresh)),
		);
		// Nothing to unfold: a quick answer, or a run that has not done anything yet.
		const folds = view.steps.length > 0 || running;
		el.toggleClass('is-empty', !folds);
		if (folds) {
			header.setAttr('role', 'button');
			header.setAttr('tabindex', '0');
			header.setAttr('aria-expanded', String(!el.hasClass('is-collapsed')));
		} else
			for (const name of ['role', 'tabindex', 'aria-expanded']) header.removeAttribute(name);
		const nodes = [el];
		const answer = view.answer;
		if (answer !== null)
			nodes.push(
				this.keep(`answer:${run.key}`, answer, () => {
					const el = createDiv({ cls: 'librarian-msg librarian-msg-assistant' });
					void this.renderMarkdown(el.createDiv(), answer);
					return el;
				}).el,
			);
		if (running)
			this.live = {
				block: el,
				timeline: block.timeline,
				response: null,
				thinking: null,
				thinkingText: '',
				thinkingLive: false,
				text: null,
				tools: null,
				calls: [],
			};
		view.errors.forEach((message, i) => {
			nodes.push(
				this.keep(`error:${run.key}:${i}`, message, () => {
					const el = createDiv({ cls: 'librarian-error is-stored' });
					el.createDiv({ text: message });
					return el;
				}).el,
			);
		});
		return nodes;
	}

	/**
	 * One step's row on the timeline: the one the last drawing left, with what its calls hold now,
	 * or a new one. `fresh` is a row that comes in.
	 */
	private drawStep(
		step: Step,
		results: Map<string, ToolResult>,
		running: boolean,
		status: DrawOptions['status'],
		fresh: boolean,
	): HTMLElement {
		const sig =
			step.kind === 'tools'
				? step.calls.map((c) => c.id).join()
				: step.kind === 'compaction'
					? `${step.before}:${step.after}`
					: step.text;
		const { el: row, made } = this.keep(`step:${step.key}`, sig, () =>
			createDiv({
				cls: `librarian-step is-${step.kind}${fresh ? ' librarian-step-new' : ''}`,
			}),
		);
		switch (step.kind) {
			case 'thinking': {
				const key = `thinking:${step.key}`;
				const content = () => ({ icon: 'brain', title: 'Thinking', text: step.text });
				const button = row.querySelector<HTMLElement>('button');
				if (button) {
					this.bindPopover(button, key, content);
					break;
				}
				// A thought with a heading reads as the task the calls under it serve (LIB-FEAT-321).
				const heading = thoughtHeading(step.text);
				this.stepButton(
					row,
					key,
					heading ?? 'Thinking',
					content,
					heading ? '' : firstLine(step.text, 100).replaceAll('**', ''),
				).toggleClass('has-heading', heading !== null);
				break;
			}
			case 'text':
				if (made) void this.renderMarkdown(renderMessage(row).text, step.text);
				break;
			case 'tools': {
				for (const call of step.calls) {
					if (call.name === SPAWN_AGENT_NAME) continue;
					const result = results.get(call.id);
					// A finished run's call with no result was cut off; it did not run.
					const shown =
						status(call.id) ??
						(result ? (result.ok ? 'ok' : 'failed') : running ? 'pending' : 'skipped');
					const had = row.querySelector<HTMLElement>(
						`.librarian-chip[data-tool-call-id="${CSS.escape(call.id)}"]`,
					);
					// A line already there says what its call has come to since: only that fades in.
					if (had) updateChip(had, call, shown, result?.content ?? null);
					this.bindPopover(
						had ?? renderChip(row, call, shown, result?.content ?? null),
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
					const card =
						row.querySelector<HTMLElement>('.librarian-agents') ??
						row.createDiv({ cls: 'librarian-agents' });
					for (const call of agents) {
						const data = this.deps.agentRowOf(
							call,
							agentResultOf(results.get(call.id), this.told.get(call.id)),
							running,
						);
						const had = card.querySelector<HTMLElement>(
							`.librarian-agent-row[data-agent-call-id="${CSS.escape(call.id)}"]`,
						);
						if (had) updateAgentRow(had, data);
						else renderAgentRow(card, data, this.deps.openAgent);
					}
				}
				break;
			}
			case 'compaction':
				if (!made) break;
				row.createSpan({ cls: 'librarian-bullet' });
				row.createSpan({
					cls: 'librarian-step-note',
					text: `Context compacted: ${compactTokens(step.before)} to ${compactTokens(step.after)}`,
				});
				break;
		}
		return row;
	}

	/**
	 * A step shown by a mark, a short label and the start of what it holds, such as a thinking;
	 * the whole of it opens in the popover.
	 */
	private stepButton(
		row: HTMLElement,
		key: string,
		label: string,
		content: () => PopoverContent,
		preview: string,
	): HTMLButtonElement {
		const button = row.createEl('button', { cls: 'librarian-chip librarian-step-button' });
		setIcon(button.createSpan({ cls: 'librarian-chip-icon' }), 'asterisk');
		const line = button.createSpan({ cls: 'librarian-chip-line' });
		line.createSpan({ cls: 'librarian-chip-name', text: label });
		line.createSpan({ cls: 'librarian-chip-preview', text: preview });
		this.bindPopover(button, key, content);
		return button;
	}

	/** The line opens `content` in the popover: the pane's click listener looks it up by `key`. */
	private bindPopover(anchor: HTMLElement, key: string, content: () => PopoverContent) {
		anchor.dataset.popKey = key;
		anchor.setAttr('aria-haspopup', 'dialog');
		// A line kept with its popover open stays marked so.
		if (!anchor.hasAttribute('aria-expanded')) anchor.setAttr('aria-expanded', 'false');
		this.popFills.set(key, { anchor, content });
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

	/**
	 * A message on the right: the user's in the chat, the main agent's in the agent pane, which a
	 * caption above names. Only the chat's own messages rewind.
	 */
	private drawUser(index: number, event: Extract<SessionEvent, { type: 'user' }>): HTMLElement[] {
		const sig = `${event.t}\n${event.content}`;
		// Not the user's words: a sub-agent finished and the main agent was told (LIB-FEAT-311).
		// One line says so, and opens that agent's conversation.
		const agent = event.agent;
		if (agent)
			return [
				this.keep(`user:${index}`, sig, () => {
					const title = /title="([^"]*)"/.exec(event.content)?.[1] || 'Agent';
					const line = createEl('button', { cls: 'librarian-agent-told' });
					setIcon(line.createSpan({ cls: 'librarian-agent-told-icon' }), 'bot');
					line.createSpan({
						text: `${title} ${agent.status === 'done' ? 'finished' : agent.status === 'stopped' ? 'stopped early' : 'failed'}`,
					});
					line.addEventListener('click', () => this.deps.openAgent(agent.callId));
					return line;
				}).el,
			];
		const nodes: HTMLElement[] = [];
		const asker = this.opts.asker;
		if (asker)
			nodes.push(
				this.keep(`asker:${index}`, asker, () =>
					createDiv({ cls: 'librarian-msg-asker', text: asker }),
				).el,
			);
		nodes.push(
			this.keep(`user:${index}`, sig, () => {
				const wrap = createDiv({ cls: 'librarian-msg librarian-msg-user' });
				renderBubble(this.deps.app, wrap, event.content, event.images ?? []);
				const rewind = this.opts.rewind;
				if (!rewind) return wrap;
				const button = wrap.createEl('button', {
					cls: 'clickable-icon librarian-rewind',
					attr: { 'aria-label': 'Rewind to here' },
				});
				setIcon(button, 'undo-2');
				button.addEventListener('click', () => rewind(index));
				return wrap;
			}).el,
		);
		return nodes;
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
			this.stepButton(
				live.thinking,
				'thinking:live',
				'Thinking',
				() => ({
					icon: 'brain',
					title: 'Thinking',
					live: current()?.thinkingLive === true,
					text: current()?.thinkingText ?? '',
				}),
				'',
			);
		}
		live.thinkingText = thinking;
		// Its line shows the thought now being written, the newest line of it.
		const preview = live.thinking?.querySelector<HTMLElement>('.librarian-chip-preview');
		// Bold marks, as a heading on its way has them, are not words to show.
		const newest = lastLine(thinking, 100).replaceAll('**', '');
		if (preview && preview.textContent !== newest) preview.setText(newest);
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
				// Its arguments grow in the brackets as they arrive.
				updateChip(existing, call, status);
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
			const chip = renderChip(tools, call, status);
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
		// Its mark pulses while the thinking grows, and rests once the response moves on.
		live.thinking?.querySelector('.librarian-chip')?.toggleClass('is-live', live.thinkingLive);
		this.liveTokens =
			estimateText(thinking) +
			estimateText(text) +
			calls.reduce((n, c) => n + estimateText(c.name + JSON.stringify(c.arguments ?? {})), 0);
		this.renderHead();
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
