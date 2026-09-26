import {
	ItemView,
	type Menu,
	Notice,
	Platform,
	setIcon,
	type ViewStateResult,
	type WorkspaceLeaf,
} from 'obsidian';
import type { AgentController, ApprovalRequest, ControllerEvent } from '../agent/agent-controller';
import type { ComposerDraft, SessionViewer } from '../agent/session-hub';
import { SPAWN_AGENT_NAME, type SubagentState } from '../agent/subagent';
import type LibrarianPlugin from '../main';
import { NO_STREAMING_NOTICE } from '../provider/transport';
import { replay } from '../session/session-manager';
import type {
	IndexedEvent,
	SessionEvent,
	SessionMetadata,
	StoredToolCall,
} from '../session/session-types';
import { AGENT_STATUS_LABELS, type AgentRowData, liveRow, storedRow } from './agent-rows';
import { renderApprovalCard } from './cards';
import { Composer } from './composer';
import { ConversationPane, type PaneDeps } from './conversation-pane';
import { steadyLabel } from './segmented';
import {
	ConfirmModal,
	confirmDeleteSession,
	renderActiveRows,
	renderSessionList,
} from './session-list';
import { activityText, renderSpinner, StepPopover } from './work-log';

export const VIEW_TYPE_LIBRARIAN = 'librarian-chat';

/**
 * The chat: the session head on top (LIB-FEAT-275), banners, the conversation (the session's own,
 * or a sub-agent's in the agent pane), the session list in its place when asked, and the composer
 * below. It shows one session's runtime at a time; the others run on in the hub (LIB-FEAT-274).
 * The conversations draw themselves (ConversationPane) and the composer sends (Composer); this view
 * wires the runtime's events to them and keeps what the two share: the popover, the approval card
 * and the agent pane.
 */
export class LibrarianView extends ItemView implements SessionViewer {
	/** The session this chat shows. */
	runtime: AgentController;
	private unsubscribe: (() => void) | null = null;
	private unsubscribeMcp: (() => void) | null = null;
	private unsubscribeHub: (() => void) | null = null;
	/** The popover a timeline step opens (LIB-FEAT-252). */
	private popover!: StepPopover;
	/** The session's own conversation. */
	private main!: ConversationPane;
	/** The agent pane (LIB-FEAT-140): a sub-agent run's conversation in place of the chat's. */
	private agentPane!: ConversationPane;
	private agentEl!: HTMLElement;
	private agentHeadEl!: HTMLElement;
	/** The spawn_agent call whose run the pane shows; null while the chat shows its own. */
	private agentCall: string | null = null;
	/** A finished run read back from its session file, for a pane opened after the run. */
	private agentStored: { data: AgentRowData; events: IndexedEvent[] } | null = null;
	/** What the pane was last drawn from: it is drawn again only when that moved. */
	private agentDrawn: string | null = null;
	private agentTimer: number | null = null;
	/** The chat's own conversation changed while the pane covered it: drawn again on the way back. */
	private mainDirty = false;
	private composer!: Composer;
	private switchEl!: HTMLElement;
	private headTitleEl!: HTMLElement;
	private headChevronEl!: HTMLElement;
	private badgeEl!: HTMLElement;
	private bannerEl!: HTMLElement;
	private mcpBannerEl!: HTMLElement;
	/** Sessions no chat on screen shows that wait for an approval (LIB-FEAT-276). */
	private attentionEl!: HTMLElement;
	private noticeEl!: HTMLElement;
	private sessionsEl!: HTMLElement;
	/** Compacting asked for outside a run has no block, so it gets a line of its own. */
	private compactLineEl: HTMLElement | null = null;
	private approvalEl: HTMLElement | null = null;
	private historyMode = false;
	/** The session list's Active rows as last drawn: the Recent part is read again only when they change. */
	private activeKey = '';
	/** What was typed in a session not sent yet, back when this chat opens a new one again. */
	private newDraft: ComposerDraft | null = null;
	/** The session a restored layout asked for before the view was built. */
	private pendingSession: string | null = null;
	private opened = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: LibrarianPlugin,
	) {
		super(leaf);
		this.runtime = plugin.hub.create();
	}

	getViewType(): string {
		return VIEW_TYPE_LIBRARIAN;
	}

	getDisplayText(): string {
		return this.plugin.manifest.name;
	}

	getIcon(): string {
		return 'book-open';
	}

	/** On screen now: the tab showing in its group, in a pane that is open. */
	isShown(): boolean {
		return this.opened && this.containerEl.isShown();
	}

	/** The layout keeps which session each chat shows, so a restart opens it again (LIB-FEAT-277). */
	getState(): Record<string, unknown> {
		return { ...super.getState(), session: this.runtime.session?.id ?? null };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const id = (state as { session?: unknown } | null)?.session;
		if (typeof id === 'string' && id !== this.runtime.session?.id) {
			if (this.opened) await this.openSession(id).catch(() => undefined);
			else this.pendingSession = id;
		}
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('librarian');
		if (Platform.isMobile) root.addClass('is-mobile');
		this.buildHead(root);
		this.bannerEl = root.createDiv({ cls: 'librarian-key-banner is-hidden' });
		this.mcpBannerEl = root.createDiv({
			cls: 'librarian-key-banner librarian-mcp-banner is-hidden',
		});
		this.attentionEl = root.createDiv({
			cls: 'librarian-key-banner librarian-attention is-hidden',
		});
		this.noticeEl = root.createDiv({ cls: 'librarian-notice is-hidden' });
		const messagesEl = root.createDiv({ cls: 'librarian-messages' });
		// The popover stays inside whichever conversation shows: the chat's, or the agent pane's.
		this.popover = new StepPopover(root, () =>
			(this.agentCall ? this.agentPane.el : messagesEl).getBoundingClientRect(),
		);
		const deps: PaneDeps = {
			app: this.app,
			component: this,
			popover: this.popover,
			findReadLine: (path: string, line: number) => this.runtime.findReadLine(path, line),
			agentRowOf: (call: StoredToolCall, result: ToolResult | undefined, running: boolean) =>
				this.agentRowOf(call, result, running),
			openAgent: (callId: string) => void this.openAgent(callId),
			hasLiveAgent: (callId: string) => this.runtime.agents.has(callId),
		};
		this.main = new ConversationPane(messagesEl, deps, {
			rewind: (index) => this.confirmRewind(index),
			activity: true,
		});
		this.registerDomEvent(document, 'pointerdown', (e) => {
			if (!this.popover.contains(e.target)) this.popover.close();
		});
		this.registerDomEvent(document, 'keydown', (e) => {
			if (e.key !== 'Escape') return;
			// Escape closes the popover first, then the agent pane when it has the focus.
			if (this.popover.openKey) this.popover.close();
			else if (this.agentCall && this.agentEl.contains(document.activeElement))
				this.closeAgent();
		});
		this.sessionsEl = root.createDiv({ cls: 'librarian-sessions is-hidden' });
		this.buildAgentPane(root, deps);
		this.composer = new Composer(root, this.plugin, {
			component: this,
			runtime: () => this.runtime,
			newSession: () => this.newSession(),
			toggleHistory: () => this.toggleHistory(),
			compactNow: () => this.compactNow(),
			showNotice: (message) => this.showNotice(message),
			onSend: async () => {
				this.main.followBottom = true;
				this.hideNotice();
				if (this.historyMode) await this.toggleHistory();
			},
		});
		this.unsubscribeMcp = this.plugin.mcp.subscribe(() => this.renderMcpBanner());
		this.renderMcpBanner();
		this.unsubscribeHub = this.plugin.hub.subscribe(() => this.onHubChange());
		this.registerEvent(
			this.app.workspace.on('file-open', () => this.composer.renderActiveNote()),
		);
		this.opened = true;
		this.attach();
		const pending = this.pendingSession;
		this.pendingSession = null;
		if (pending && pending !== this.runtime.session?.id)
			await this.openSession(pending).catch(() => undefined);
	}

	async onClose(): Promise<void> {
		this.detach();
		this.opened = false;
		this.unsubscribeMcp?.();
		this.unsubscribeHub?.();
		this.main.dispose();
		this.agentPane.dispose();
		if (this.agentTimer !== null) window.clearTimeout(this.agentTimer);
	}

	// The session this chat shows (LIB-FEAT-274)

	/** Starts showing `this.runtime`: its log, its queue, its model and what was typed for it. */
	private attach(): void {
		const runtime = this.runtime;
		const hub = this.plugin.hub;
		hub.show(this, runtime);
		this.unsubscribe = runtime.subscribe((e) => this.onControllerEvent(e));
		this.main.reset();
		this.main.followBottom = true;
		this.composer.showRuntime();
		const id = runtime.session?.id;
		const draft = id ? hub.takeDraft(id) : this.newDraft;
		if (!id) this.newDraft = null;
		if (draft) this.composer.restoreDraft(draft);
		const unsent = id ? hub.takeUnsent(id) : [];
		if (unsent.length) this.composer.restoreUnsent(unsent);
		this.renderEvents(runtime.events);
		this.renderState(runtime.state);
		this.renderHead();
		this.renderAttention();
		void runtime.refreshReadiness();
	}

	/** Stops showing it. What was typed stays with its session, and nothing it does stops. */
	private detach(): void {
		const runtime = this.runtime;
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.agentCall) this.closeAgent(false);
		this.popover.close();
		this.main.queueStream(null, () => undefined);
		const draft = this.composer.takeDraft();
		const id = runtime.session?.id;
		if (id) this.plugin.hub.keepDraft(id, draft);
		else this.newDraft = draft;
		this.plugin.hub.hide(this, runtime);
	}

	/** Shows another session's runtime here; the one shown so far runs on. */
	async show(runtime: AgentController): Promise<void> {
		if (runtime === this.runtime) return;
		this.detach();
		this.runtime = runtime;
		this.attach();
		this.app.workspace.requestSaveLayout();
	}

	// The view header's "more options" menu holds what the old toolbar did.

	onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		menu.addItem((item) =>
			item
				.setTitle('Session history')
				.setIcon('history')
				.onClick(() => void this.toggleHistory()),
		);
		menu.addItem((item) =>
			item
				.setTitle('New session')
				.setIcon('plus')
				.onClick(() => void this.newSession()),
		);
		menu.addItem((item) =>
			item
				.setTitle('Compact context')
				.setIcon('shrink')
				.onClick(() => void this.compactNow()),
		);
		const current = this.runtime.session;
		if (current)
			menu.addItem((item) =>
				item
					.setTitle('Delete session')
					.setIcon('trash-2')
					.onClick(() => this.confirmDelete(current)),
			);
		menu.addItem((item) =>
			item
				.setTitle('Settings')
				.setIcon('settings')
				.onClick(() => this.plugin.openSettings()),
		);
	}

	/** Asks, then deletes the session; the history list redraws when it is showing. */
	private confirmDelete(session: SessionMetadata) {
		confirmDeleteSession(this.plugin, session, async () => {
			if (this.historyMode) await this.renderSessions();
		});
	}

	private async compactNow() {
		if (!this.runtime.session) return this.showNotice('Open a session first.');
		const outcome = await this.runtime.compactNow();
		// A failure has already said why.
		if (outcome !== 'failed')
			this.showNotice(
				outcome === 'compacted' ? 'Context compacted.' : 'Nothing to compact yet.',
			);
	}

	// What the plugin's commands and the e2e scripts call

	renderModelSelect(): void {
		this.composer.renderModelSelect();
	}

	submit(): Promise<void> {
		return this.composer.submit();
	}

	/** A new session in this chat. The one shown so far keeps running (LIB-FEAT-275). */
	async newSession(): Promise<void> {
		if (this.historyMode) await this.toggleHistory();
		this.main.followBottom = true;
		// Already a session nobody has written to: nothing to make.
		if (this.runtime.session || this.runtime.isRunning)
			await this.show(this.plugin.hub.create());
		this.composer.renderModelSelect();
		this.composer.focus();
	}

	/** Used by the "Add active note to prompt" command. */
	includeActiveNoteInPrompt(): void {
		this.composer.includeActiveNoteInPrompt();
	}

	focusInput(): void {
		this.composer.focus();
	}

	// The session head (LIB-FEAT-275)

	/** One line on top: which session shows, what the others do, and a new session. */
	private buildHead(root: HTMLElement) {
		const head = root.createDiv({ cls: 'librarian-session-head' });
		this.switchEl = head.createEl('button', {
			cls: 'librarian-session-switch',
			attr: { 'aria-label': 'Switch session', 'aria-haspopup': 'true' },
		});
		setIcon(
			this.switchEl.createSpan({ cls: 'librarian-session-head-icon' }),
			'messages-square',
		);
		this.headTitleEl = this.switchEl.createSpan({ cls: 'librarian-session-head-title' });
		this.headChevronEl = this.switchEl.createSpan({ cls: 'librarian-session-head-chevron' });
		this.badgeEl = this.switchEl.createSpan({ cls: 'librarian-session-badge is-hidden' });
		this.switchEl.addEventListener('click', () => void this.toggleHistory());
		const add = head.createEl('button', {
			cls: 'clickable-icon librarian-session-new',
			attr: { 'aria-label': 'New session' },
		});
		setIcon(add, 'square-pen');
		add.addEventListener('click', () => void this.newSession());
	}

	/** The title, and a badge for the sessions no chat on screen shows that run, ask or ended. */
	private renderHead() {
		if (!this.opened) return;
		const hub = this.plugin.hub;
		this.headTitleEl.setText(hub.titleOf(this.runtime));
		setIcon(this.headChevronEl, this.historyMode ? 'chevron-up' : 'chevron-down');
		const others = hub
			.entries()
			.filter((e) => e.runtime !== this.runtime && !(e.runtime && hub.isVisible(e.runtime)));
		const asking = others.filter((e) => e.activity === 'asking').length;
		const running = others.filter((e) => e.activity === 'running').length;
		const ended = others.length - asking - running;
		const busy = asking + running;
		this.badgeEl.className = `librarian-session-badge ${
			asking ? 'is-asking' : busy ? 'is-running' : ended ? 'is-unread' : 'is-hidden'
		}`;
		this.badgeEl.setText(busy ? String(busy) : '');
		const parts = [
			running ? `${running} running` : '',
			asking ? `${asking} waiting for your approval` : '',
			ended ? `${ended} finished` : '',
		].filter(Boolean);
		this.switchEl.setAttr(
			'aria-label',
			parts.length ? `Switch session. Other sessions: ${parts.join(', ')}` : 'Switch session',
		);
	}

	/** One line per session no chat on screen shows that waits for an approval (LIB-FEAT-276). */
	private renderAttention() {
		if (!this.opened) return;
		const hub = this.plugin.hub;
		const waiting = hub
			.entries()
			.filter(
				(e) =>
					e.activity === 'asking' &&
					e.runtime &&
					e.runtime !== this.runtime &&
					!hub.isVisible(e.runtime),
			);
		this.attentionEl.toggleClass('is-hidden', waiting.length === 0);
		this.attentionEl.empty();
		for (const entry of waiting.slice(0, 3)) {
			const row = this.attentionEl.createDiv({ cls: 'librarian-key-banner-row' });
			row.createSpan({ text: `"${entry.title}" is waiting for your approval.` });
			const open = row.createEl('button', { cls: 'mod-cta', text: 'Open' });
			open.addEventListener('click', () => void this.openSession(entry.sessionId));
		}
		const more = waiting.length - 3;
		if (more > 0)
			this.attentionEl.createDiv({
				cls: 'librarian-key-banner-row',
				text: `${more} more ${more === 1 ? 'session is' : 'sessions are'} waiting for your approval.`,
			});
	}

	/** Another session moved on: the head, the banner, and the Active rows when the list shows. */
	private onHubChange() {
		this.renderHead();
		this.renderAttention();
		if (this.historyMode) this.renderActive();
	}

	// Controller events

	private onControllerEvent(event: ControllerEvent) {
		switch (event.type) {
			case 'state':
				this.renderState(event.state);
				break;
			case 'session':
				this.main.reset();
				this.popover.close();
				// Another conversation: its agents are not the ones the pane showed.
				if (this.agentCall) this.closeAgent(false);
				this.composer.renderModelSelect();
				this.renderHead();
				this.app.workspace.requestSaveLayout();
				break;
			case 'events':
				this.renderEvents(event.events);
				break;
			case 'stream':
				this.main.queueStream(event.message, this.mainStatus);
				break;
			case 'tool-status':
				this.main.setToolStatus(event.toolCallId, event.status);
				break;
			case 'approval':
				this.renderApproval(event.request);
				break;
			case 'usage':
				this.composer.renderUsage(event.usage);
				break;
			case 'notice':
				this.showNotice(event.message);
				break;
			case 'error':
				this.renderError(event.message);
				break;
			case 'queue':
				this.composer.renderQueue(event.queue);
				break;
			case 'unsent':
				this.composer.restoreUnsent(event.messages);
				break;
			case 'agent':
				this.onAgent(event.agent);
				break;
		}
	}

	private readonly mainStatus = (id: string) => this.runtime.toolStatusOf(id);

	private renderState(state: AgentController['state']) {
		this.bannerEl.toggleClass('is-hidden', state !== 'no-key');
		if (state === 'no-key') this.renderKeyBanner();
		this.composer.renderState(state);
		this.renderActivity(state);
		// The last events of a run are drawn while it still runs; once it has ended, it folds.
		if (this.runtime.session && !this.runtime.isRunning && this.main.hasRunningRun)
			this.renderEvents(this.runtime.events);
	}

	private renderKeyBanner() {
		const provider = this.runtime.selection?.provider;
		this.bannerEl.empty();
		if (!provider) return;
		this.bannerEl.createDiv({
			cls: 'librarian-key-banner-title',
			text: `API key for "${provider.name}" is not set on this device.`,
		});
		const row = this.bannerEl.createDiv({ cls: 'librarian-key-banner-row' });
		const input = row.createEl('input', {
			type: 'password',
			attr: { placeholder: 'API key (leave empty for no key)', 'aria-label': 'API key' },
		});
		const save = row.createEl('button', { cls: 'mod-cta', text: 'Save' });
		save.addEventListener(
			'click',
			() =>
				void (async () => {
					this.plugin.secrets.set(provider.secretId, input.value.trim());
					await this.plugin.refreshReadiness();
					this.composer.focus();
				})(),
		);
	}

	/** One line per enabled MCP server that is waiting for a sign-in or an API key. */
	private renderMcpBanner() {
		const waiting = this.plugin.mcp.needingSignIn();
		this.mcpBannerEl.toggleClass('is-hidden', waiting.length === 0);
		this.mcpBannerEl.empty();
		for (const server of waiting) {
			const row = this.mcpBannerEl.createDiv({ cls: 'librarian-key-banner-row' });
			row.createSpan({ text: `Sign in to "${server.name}" to use its tools.` });
			const button = row.createEl('button', { cls: 'mod-cta' });
			// One width for every row's button, whichever it says.
			steadyLabel(
				button,
				['Sign in', 'Open settings'],
				server.auth === 'apiKey' ? 'Open settings' : 'Sign in',
			);
			button.addEventListener('click', () => {
				if (server.auth === 'apiKey') this.plugin.openSettings();
				else void this.plugin.mcp.signIn(server.id);
			});
		}
	}

	private showNotice(message: string) {
		this.noticeEl.setText(message);
		this.noticeEl.removeClass('is-hidden');
		new Notice(message);
	}

	private hideNotice() {
		this.noticeEl.addClass('is-hidden');
	}

	private renderError(message: string) {
		const block = this.main.el.createDiv({ cls: 'librarian-error' });
		block.createDiv({ text: message });
		const row = block.createDiv({ cls: 'librarian-error-buttons' });
		const retry = row.createEl('button', { text: 'Retry' });
		retry.addEventListener('click', () => void this.retryLast());
		const settings = row.createEl('button', { text: 'Open settings' });
		settings.addEventListener('click', () => this.plugin.openSettings());
		this.main.scrollToBottom();
	}

	private async retryLast() {
		const last = [...this.runtime.events].reverse().find((e) => e.event.type === 'user');
		if (last?.event.type !== 'user') return;
		await this.runtime.send(last.event.content, last.event.images ?? []);
	}

	// The chat's own conversation

	/** What the agent is doing, in the running run's header, or on a line of its own for compacting. */
	private renderActivity(state: AgentController['state']) {
		const provider = this.runtime.selection?.provider;
		const nonStreaming = provider
			? this.plugin.transport.effectiveMode(provider) === 'requestUrl'
			: false;
		// Sub-agents at work: how far they are, which the rows under it tell one by one.
		const activity = activityText(
			state,
			[...this.runtime.agents.values()],
			nonStreaming ? NO_STREAMING_NOTICE : undefined,
		);
		this.main.setActivity(activity);
		const standalone = state === 'compacting' && !this.runtime.isRunning;
		if (standalone && !this.compactLineEl) {
			this.compactLineEl = this.main.el.createDiv({ cls: 'librarian-work is-running' });
			const header = this.compactLineEl.createDiv({ cls: 'librarian-work-header' });
			renderSpinner(header);
			header.createSpan({ cls: 'librarian-work-title', text: 'Compacting context' });
			this.main.scrollToBottom();
		} else if (!standalone) {
			this.compactLineEl?.remove();
			this.compactLineEl = null;
		}
	}

	private renderEvents(events: IndexedEvent[]) {
		// The agent pane covers the chat's own conversation; it is drawn on the way back.
		if (this.agentCall) {
			this.mainDirty = true;
			return;
		}
		this.compactLineEl = null;
		this.approvalEl = null;
		this.main.draw(events, { running: this.runtime.isRunning, status: this.mainStatus });
		if (this.runtime.pendingApproval) this.renderApproval(this.runtime.pendingApproval);
		this.renderActivity(this.runtime.state);
	}

	private renderApproval(request: ApprovalRequest | null) {
		this.approvalEl?.remove();
		this.approvalEl = null;
		if (!request) return;
		const agentCall = request.agentCallId;
		// Wherever the user is looking: the chat, or the agent pane.
		const pane = this.agentCall ? this.agentPane : this.main;
		this.approvalEl = renderApprovalCard(
			pane.el,
			request.name,
			// A resume may leave agent out: the card names the agent it goes on with.
			request.name === SPAWN_AGENT_NAME
				? { ...request.args, agent: this.runtime.agentOfCall(request.args) }
				: request.args,
			request.existingLength,
			{
				approve: () => request.resolve('approve'),
				reject: () => request.resolve('reject'),
				always: () => request.resolve('always'),
			},
			request.canAlways,
			request.permissionKey,
			request.calledFrom,
			{
				waiting: request.waiting,
				...(agentCall && request.agentTitle
					? {
							agent: {
								title: request.agentTitle,
								type: request.agentType ?? '',
								// Already there when the pane shows that agent.
								open:
									this.agentCall === agentCall
										? undefined
										: () => void this.openAgent(agentCall),
							},
						}
					: {}),
			},
		);
		pane.scrollToBottom(this.agentCall !== null);
	}

	// Rewind

	private confirmRewind(index: number) {
		const preview = this.runtime.previewRewind(index);
		if (!preview) return;
		new ConfirmModal(
			this.app,
			`${preview.turns} ${preview.turns === 1 ? 'turn' : 'turns'} will be collapsed.`,
			(el) => {
				el.createEl('p', {
					text: 'The conversation returns to just before this message and the message is put back in the composer.',
				});
				if (preview.changes.length) {
					el.createEl('p', {
						text: `${preview.changes.length} ${preview.changes.length === 1 ? 'note change' : 'note changes'} made by the agent will be reverted:`,
					});
					const list = el.createEl('ul');
					for (const change of preview.changes)
						list.createEl('li', { text: change.path });
					el.createEl('p', {
						cls: 'librarian-modal-note',
						text: 'Notes you edited yourself since then are left untouched.',
					});
				}
			},
			'Rewind',
			async () => {
				const result = await this.runtime.rewind(index);
				if (!result) return;
				// Ahead of anything already there, such as queued messages the rewind handed back.
				this.composer.prependDraft(result.userText);
				if (result.unchanged.length) {
					const block = this.main.el.createDiv({ cls: 'librarian-error is-stored' });
					block.createDiv({
						text: `${result.unchanged.length} ${result.unchanged.length === 1 ? 'file was' : 'files were'} left unchanged`,
					});
					const list = block.createEl('ul');
					for (const item of result.unchanged)
						list.createEl('li', { text: `${item.path}: ${item.reason}` });
					block.createDiv({
						cls: 'librarian-tool-note',
						text: 'Use File recovery in Settings to restore an older version by hand.',
					});
				}
			},
		).open();
	}

	// Agent pane (LIB-FEAT-140)

	/**
	 * A sub-agent run's conversation, which takes the place of the chat's while it is open: a head
	 * with the way back, the run's title, its agent and its state, then the conversation as the
	 * chat draws its own, with the main agent's task on the right.
	 */
	private buildAgentPane(root: HTMLElement, deps: PaneDeps) {
		this.agentEl = root.createDiv({ cls: 'librarian-agent-view is-hidden' });
		this.agentHeadEl = this.agentEl.createDiv({ cls: 'librarian-agent-head' });
		const back = this.agentHeadEl.createEl('button', {
			cls: 'clickable-icon librarian-agent-back',
			attr: { 'aria-label': 'Back to the conversation' },
		});
		setIcon(back, 'chevron-left');
		back.addEventListener('click', () => this.closeAgent());
		setIcon(this.agentHeadEl.createSpan({ cls: 'librarian-agent-row-icon' }), 'bot');
		const heading = this.agentHeadEl.createDiv({ cls: 'librarian-agent-heading' });
		heading.createSpan({ cls: 'librarian-agent-heading-title' });
		heading.createSpan({ cls: 'librarian-agent-type' });
		this.agentHeadEl.createSpan({ cls: 'librarian-agent-state' });
		const body = this.agentEl.createDiv({ cls: 'librarian-messages librarian-agent-body' });
		this.agentPane = new ConversationPane(body, deps, { asker: 'Main agent' });
	}

	/** A sub-agent moved on: its rows on the timeline, the run head, and the pane if it shows it. */
	private onAgent(state: SubagentState) {
		this.main.updateAgentRows(state.callId, liveRow(state));
		this.renderActivity(this.runtime.state);
		if (this.agentCall !== state.callId || this.agentTimer !== null) return;
		// Its stream moves as fast as the chat's; one redraw per stretch keeps the pane smooth.
		this.agentTimer = window.setTimeout(() => {
			this.agentTimer = null;
			this.renderAgentPane();
		}, 150);
	}

	/** A spawn_agent call's row: from the run in memory while there is one, else from the log. */
	private agentRowOf(
		call: StoredToolCall,
		result: ToolResult | undefined,
		running: boolean,
	): AgentRowData {
		const live = this.runtime.agents.get(call.id);
		if (live) return liveRow(live);
		const agent = this.runtime.agentOfCall(call.args);
		return storedRow(call, result, running, {
			agent,
			color: this.plugin.agentDefs.get(agent)?.color,
			asking: this.runtime.toolStatusOf(call.id) === 'awaiting-approval',
		});
	}

	/** Opens a sub-agent run's conversation in place of the chat's. */
	async openAgent(callId: string): Promise<void> {
		this.popover.close();
		if (this.historyMode) await this.toggleHistory();
		this.agentCall = callId;
		this.agentPane.reset();
		this.agentStored = this.runtime.agents.has(callId) ? null : await this.storedAgent(callId);
		// A switch while the file was read won the race.
		if (this.agentCall !== callId) return;
		this.main.el.addClass('is-hidden');
		this.agentEl.removeClass('is-hidden');
		this.composer.setPlaceholder('Ask the main agent');
		this.agentPane.followBottom = true;
		// Drawn whole: a redraw while the file was read may have drawn the pane it left.
		this.agentDrawn = null;
		this.renderAgentPane();
		this.agentHeadEl.querySelector<HTMLElement>('.librarian-agent-back')?.focus();
	}

	/** Back to the chat's own conversation, drawn again if it changed meanwhile. */
	closeAgent(redraw = true): void {
		if (!this.agentCall) return;
		this.agentCall = null;
		this.agentStored = null;
		this.agentDrawn = null;
		if (this.agentTimer !== null) window.clearTimeout(this.agentTimer);
		this.agentTimer = null;
		this.popover.close();
		this.agentPane.el.empty();
		this.agentEl.addClass('is-hidden');
		this.main.el.removeClass('is-hidden');
		this.composer.setPlaceholder('Ask a question');
		if (!redraw) return;
		if (this.mainDirty) {
			this.mainDirty = false;
			this.renderEvents(this.runtime.events);
		} else this.renderApproval(this.runtime.pendingApproval);
	}

	/** A finished run read back from its session file, which the spawn_agent result names. */
	private async storedAgent(
		callId: string,
	): Promise<{ data: AgentRowData; events: IndexedEvent[] } | null> {
		const events = this.runtime.events;
		const call = events.find(
			(e) => e.event.type === 'tool_call' && e.event.toolCallId === callId,
		)?.event as Extract<SessionEvent, { type: 'tool_call' }> | undefined;
		if (!call) return null;
		const result = events.find(
			(e) => e.event.type === 'tool_result' && e.event.toolCallId === callId,
		)?.event as ToolResult | undefined;
		const data = this.agentRowOf(
			{ id: callId, name: call.name, args: call.args },
			result,
			false,
		);
		// A failed run has no result naming it, but its session knows the call that started it.
		const sessionId =
			result?.agentSession ??
			(await this.plugin.sessions.list()).find((s) => s.parentCallId === callId)?.id;
		const stored = sessionId
			? replay(await this.plugin.sessions.load(sessionId)).filter(
					(e) => e.event.type !== 'meta',
				)
			: [];
		return { data, events: stored };
	}

	/** Draws the pane again from the run in memory, or from the file for a finished one. */
	private renderAgentPane() {
		const callId = this.agentCall;
		if (!callId) return;
		const live = this.runtime.agents.get(callId);
		const data = live ? liveRow(live) : this.agentStored?.data;
		const head = this.agentHeadEl;
		head.querySelector('.librarian-agent-row-icon')?.setAttr(
			'class',
			`librarian-agent-row-icon${data?.color ? ` is-${data.color}` : ''}`,
		);
		head.querySelector('.librarian-agent-heading-title')?.setText(data?.title ?? 'Agent');
		head.querySelector('.librarian-agent-type')?.setText(data?.agent ?? '');
		const state = head.querySelector<HTMLElement>('.librarian-agent-state');
		if (state && data) {
			state.className = `librarian-agent-state is-${data.status}`;
			state.setText(AGENT_STATUS_LABELS[data.status]);
		}
		const running = live ? live.status === 'waiting' || live.status === 'running' : false;
		const events = live ? live.events : (this.agentStored?.events ?? []);
		const status = (id: string) => live?.toolStatus.get(id);
		// Drawn again only when its log, its state or a call's state moved. The response on its way
		// grows in place, as the chat's does: drawn anew each time it would restart the spinner's
		// turn and the open popover's entrance, and lose a selection (LIB-TEST-142).
		const drawn = `${events.length}:${running}:${[...(live?.toolStatus.values() ?? [])].join()}`;
		if (drawn !== this.agentDrawn) {
			this.agentDrawn = drawn;
			this.approvalEl = null;
			this.agentPane.draw(events, {
				running,
				status,
				stream: live?.stream ?? null,
				emptyText: running ? 'Waiting for a slot.' : 'Its conversation was not saved.',
			});
			if (this.runtime.pendingApproval) this.renderApproval(this.runtime.pendingApproval);
		} else if (live?.stream) this.agentPane.stream(live.stream, status);
		this.agentPane.scrollToBottom();
	}

	// The session list (LIB-FEAT-275)

	async toggleHistory(): Promise<void> {
		if (this.agentCall) this.closeAgent();
		this.historyMode = !this.historyMode;
		this.main.el.toggleClass('is-hidden', this.historyMode);
		this.sessionsEl.toggleClass('is-hidden', !this.historyMode);
		this.renderHead();
		if (this.historyMode) await this.renderSessions();
	}

	/**
	 * The list with every session that runs, asks or ended unseen in its Active group, the one
	 * this chat shows among them while it runs or asks: at work, it is not Recent (LIB-FEAT-275).
	 */
	private async renderSessions() {
		const active = this.plugin.hub.entries();
		this.activeKey = active.map((e) => e.sessionId).join('\n');
		await renderSessionList(this.sessionsEl, this.plugin, (id) => this.openSession(id), {
			current: this.runtime.session?.id ?? null,
			active,
			stop: (entry) => entry.runtime?.stop(),
		});
	}

	/** The Active rows again; when a session joined or left them, the whole list. */
	private renderActive() {
		const active = this.plugin.hub.entries();
		const key = active.map((e) => e.sessionId).join('\n');
		const box = this.sessionsEl.querySelector<HTMLElement>('.librarian-sessions-active');
		if (key !== this.activeKey) {
			void this.renderSessions();
			return;
		}
		if (box)
			renderActiveRows(
				box,
				active,
				(id) => this.openSession(id),
				(entry) => entry.runtime?.stop(),
				this.runtime.session?.id ?? null,
			);
	}

	/** Opens a session in this chat, from the list, a banner or the settings. Nothing stops. */
	async openSession(id: string): Promise<void> {
		this.main.followBottom = true;
		await this.show(await this.plugin.hub.open(id));
		if (this.historyMode) await this.toggleHistory();
		this.composer.renderModelSelect();
	}
}

type ToolResult = Extract<SessionEvent, { type: 'tool_result' }>;
