import { sessionTitle } from '../session/session-manager';
import { plainLine } from '../ui/agent-rows';
import type { MentionTarget } from '../ui/mentions';
import { activityText, firstLine } from '../ui/work-log';
import type { AgentController, ControllerEvent, QueuedMessage } from './agent-controller';
import { GENERAL_AGENT } from './agent-definitions';

/**
 * Every session that has a runtime (LIB-ADR-043, LIB-FEAT-274). Each session runs on an
 * AgentController of its own and a chat view shows one of them, so opening or making another
 * session never stops the one that works. The hub makes and finds the runtimes, lets go of those
 * that neither run nor show, keeps what was typed in each, and tells the chats which sessions run,
 * ask for approval or ended while nobody looked (LIB-FEAT-275, LIB-FEAT-276).
 */

/** What a chat view is to the hub. */
export interface SessionViewer {
	/** On screen now: the tab showing in its group, in a pane that is open. */
	isShown(): boolean;
}

/** What was in the composer, kept for its session while the chat shows another. */
export interface ComposerDraft {
	text: string;
	images: string[];
	mentions: MentionTarget[];
	activeNote: boolean;
}

/** A session that needs a look: it runs, it asks, or it ended while no chat on screen showed it. */
export type SessionActivity = 'running' | 'asking' | 'unread' | 'failed';

export interface SessionEntry {
	sessionId: string;
	title: string;
	activity: SessionActivity;
	/** What it is doing, or the first line of its answer or of its error. */
	line: string;
	/** Its runtime; a session that ended unseen may have been let go and keep only this entry. */
	runtime: AgentController | null;
}

interface Tracked {
	off: () => void;
	viewers: Set<SessionViewer>;
	/** Whether its run was on when it last said its state. */
	running: boolean;
	/** The error its run ended on, if it failed. */
	failed: string | null;
	/** The Notice that it waits for an approval went out, once per stretch unseen. */
	asked: boolean;
}

const ORDER: Record<SessionActivity, number> = { asking: 0, running: 1, failed: 2, unread: 3 };

function isEmpty(draft: ComposerDraft): boolean {
	return (
		!draft.text.trim() && !draft.images.length && !draft.mentions.length && !draft.activeNote
	);
}

export class SessionHub {
	private readonly tracked = new Map<AgentController, Tracked>();
	/** Sessions that ended while no chat on screen showed them, by session id. */
	private readonly marks = new Map<
		string,
		{ activity: 'unread' | 'failed'; title: string; line: string }
	>();
	private readonly drafts = new Map<string, ComposerDraft>();
	/** Queued messages a run handed back while no chat showed it, by session id. */
	private readonly unsent = new Map<string, QueuedMessage[]>();
	private readonly opening = new Map<string, Promise<AgentController>>();
	private readonly listeners = new Set<() => void>();
	private last: AgentController | null = null;
	private timer: number | null = null;

	constructor(
		private readonly deps: {
			create: () => AgentController;
			notify: (message: string) => void;
		},
	) {}

	get runtimes(): AgentController[] {
		return [...this.tracked.keys()];
	}

	/** A runtime for a session not sent yet: its first message makes the session file. */
	create(): AgentController {
		const runtime = this.deps.create();
		const t: Tracked = {
			off: () => {},
			viewers: new Set(),
			running: false,
			failed: null,
			asked: false,
		};
		t.off = runtime.subscribe((e) => this.onEvent(runtime, t, e));
		this.tracked.set(runtime, t);
		return runtime;
	}

	/** The runtime of a session: the one that has it, else a new one read from its log. */
	open(id: string): Promise<AgentController> {
		const found = this.find(id);
		if (found) return Promise.resolve(found);
		const pending = this.opening.get(id);
		if (pending) return pending;
		const runtime = this.create();
		const loading = runtime
			.openSession(id)
			.then(() => runtime)
			.catch((error: unknown) => {
				this.letGo(runtime);
				throw error;
			})
			.finally(() => this.opening.delete(id));
		this.opening.set(id, loading);
		return loading;
	}

	find(id: string): AgentController | undefined {
		for (const runtime of this.tracked.keys()) if (runtime.session?.id === id) return runtime;
		return undefined;
	}

	/** A chat shows it now; what ended unseen in it is seen. */
	show(viewer: SessionViewer, runtime: AgentController): void {
		this.tracked.get(runtime)?.viewers.add(viewer);
		this.last = runtime;
		this.seen(runtime);
		this.changed();
	}

	/** A chat no longer shows it. One that neither runs nor shows goes; its log keeps it all. */
	hide(viewer: SessionViewer, runtime: AgentController): void {
		this.tracked.get(runtime)?.viewers.delete(viewer);
		this.sweep(runtime);
		this.changed();
	}

	/** The chat used last, whose session the commands and `plugin.controller` reach. */
	focus(runtime: AgentController): void {
		if (this.tracked.has(runtime)) this.last = runtime;
	}

	focused(): AgentController {
		if (this.last && this.tracked.has(this.last)) return this.last;
		return this.runtimes[0] ?? this.create();
	}

	/** Some chat on screen shows it. */
	isVisible(runtime: AgentController): boolean {
		for (const viewer of this.tracked.get(runtime)?.viewers ?? [])
			if (viewer.isShown()) return true;
		return false;
	}

	/** Sessions some chat shows, on screen or not. */
	shownIds(): Set<string> {
		const ids = new Set<string>();
		for (const [runtime, t] of this.tracked)
			if (t.viewers.size && runtime.session) ids.add(runtime.session.id);
		return ids;
	}

	titleOf(runtime: AgentController): string {
		return sessionTitle(runtime.session?.title, runtime.events);
	}

	/** Panes moved or a session was renamed: what is on screen now is seen, and the chats redraw. */
	refresh(): void {
		for (const runtime of this.tracked.keys()) this.seen(runtime);
		this.changed();
	}

	/** Sessions that run, ask, or ended unseen: the ones asking first. */
	entries(): SessionEntry[] {
		const out: SessionEntry[] = [];
		const live = new Set<string>();
		for (const runtime of this.tracked.keys()) {
			const id = runtime.session?.id;
			if (!id) continue;
			const card = runtime.pendingApproval;
			if (!card && !runtime.isRunning) continue;
			live.add(id);
			const target = [card?.args.path, card?.args.command, card?.args.from].find(
				(v): v is string => typeof v === 'string' && v.trim() !== '',
			);
			out.push({
				sessionId: id,
				title: this.titleOf(runtime),
				activity: card ? 'asking' : 'running',
				line: card
					? `Waiting for your approval: ${card.name}${target ? ` ${firstLine(target)}` : ''}`
					: activityOf(runtime),
				runtime,
			});
		}
		for (const [id, mark] of this.marks)
			if (!live.has(id)) out.push({ sessionId: id, ...mark, runtime: this.find(id) ?? null });
		return out.sort((a, b) => ORDER[a.activity] - ORDER[b.activity]);
	}

	/** Stops a session and forgets it, before its file goes. A chat showing it is left empty. */
	async remove(id: string): Promise<void> {
		this.marks.delete(id);
		this.drafts.delete(id);
		this.unsent.delete(id);
		const runtime = this.find(id);
		if (runtime) {
			await runtime.closeSession();
			this.sweep(runtime);
		}
		this.changed();
	}

	/** The plugin unloads. */
	stopAll(): void {
		for (const runtime of this.tracked.keys()) runtime.stop();
	}

	keepDraft(id: string, draft: ComposerDraft): void {
		if (isEmpty(draft)) this.drafts.delete(id);
		else this.drafts.set(id, draft);
	}

	takeDraft(id: string): ComposerDraft | undefined {
		const draft = this.drafts.get(id);
		this.drafts.delete(id);
		return draft;
	}

	takeUnsent(id: string): QueuedMessage[] {
		const messages = this.unsent.get(id) ?? [];
		this.unsent.delete(id);
		return messages;
	}

	/** The agent a spawn_agent call starts: a resumed run's, from the session that started it. */
	agentOfCall(args: unknown): string {
		const a = (args ?? {}) as { agent?: unknown; resume?: unknown };
		const resume = typeof a.resume === 'string' ? a.resume.trim() : '';
		if (resume)
			for (const runtime of this.tracked.keys())
				if (runtime.ownsAgentSession(resume)) return runtime.agentOfCall(args);
		return typeof a.agent === 'string' && a.agent.trim() ? a.agent.trim() : GENERAL_AGENT;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		for (const listener of this.listeners) listener();
	}

	/** A response streams many times a second; the chats hear of it at most every 150 ms. */
	private changedSoon(): void {
		if (this.timer !== null) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.changed();
		}, 150);
	}

	private onEvent(runtime: AgentController, t: Tracked, e: ControllerEvent): void {
		switch (e.type) {
			case 'error':
				t.failed = e.message;
				return;
			case 'approval':
				if (e.request && !t.asked && !this.isVisible(runtime)) {
					t.asked = true;
					this.deps.notify(`"${this.titleOf(runtime)}" is waiting for your approval.`);
				}
				this.changed();
				return;
			case 'state': {
				const running = runtime.isRunning;
				if (running && !t.running) {
					t.running = true;
					t.failed = null;
				} else if (!running && t.running) {
					t.running = false;
					this.ended(runtime, t);
				}
				this.changedSoon();
				return;
			}
			case 'unsent': {
				// A chat showing it puts them back in its composer; with none, they wait for one.
				const id = runtime.session?.id;
				if (!t.viewers.size && id)
					this.unsent.set(id, [...(this.unsent.get(id) ?? []), ...e.messages]);
				return;
			}
			case 'session':
				this.changed();
				return;
			case 'stream':
			case 'tool-status':
			case 'agent':
				this.changedSoon();
				return;
		}
	}

	/** A run ended. Unseen, it is marked and told of, unless the user stopped it. */
	private ended(runtime: AgentController, t: Tracked): void {
		t.asked = false;
		const id = runtime.session?.id;
		if (id && !runtime.stopping && !this.isVisible(runtime)) {
			const title = this.titleOf(runtime);
			if (t.failed) {
				const line = plainLine(t.failed);
				this.marks.set(id, { activity: 'failed', title, line });
				this.deps.notify(`"${title}" failed: ${line}`);
			} else {
				this.marks.set(id, { activity: 'unread', title, line: answerOf(runtime) });
				this.deps.notify(`"${title}" finished.`);
			}
		}
		this.sweep(runtime);
	}

	private seen(runtime: AgentController): void {
		const id = runtime.session?.id;
		if (!id || !this.isVisible(runtime)) return;
		this.marks.delete(id);
		const t = this.tracked.get(runtime);
		if (t) t.asked = false;
	}

	private sweep(runtime: AgentController): void {
		const t = this.tracked.get(runtime);
		if (!t || t.viewers.size || runtime.isRunning) return;
		this.letGo(runtime);
	}

	private letGo(runtime: AgentController): void {
		this.tracked.get(runtime)?.off();
		this.tracked.delete(runtime);
		if (this.last === runtime) this.last = null;
	}
}

/** What a running session does, in the words of the work block's header. */
function activityOf(runtime: AgentController): string {
	return (
		activityText(runtime.state, [...runtime.agents.values()]) ||
		(runtime.state === 'streaming' ? 'Writing the answer' : 'Working')
	);
}

/** The first line of a session's last answer, for a session that ended unseen. */
function answerOf(runtime: AgentController): string {
	for (let i = runtime.events.length - 1; i >= 0; i--) {
		const e = runtime.events[i]!.event;
		if (e.type === 'assistant' && e.content.trim()) return plainLine(e.content);
	}
	return 'Finished';
}
