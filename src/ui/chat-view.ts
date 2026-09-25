import { ItemView, type Menu, Notice, Platform, setIcon, type WorkspaceLeaf } from 'obsidian';
import type { AgentController, ApprovalRequest, ControllerEvent } from '../agent/agent-controller';
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
import { ConfirmModal, confirmDeleteSession, renderSessionList } from './session-list';
import { renderSpinner, StepPopover } from './work-log';

export const VIEW_TYPE_LIBRARIAN = 'librarian-chat';

/**
 * The chat: banners on top, the conversation (the chat's own, or a sub-agent's in the agent pane),
 * the history list in its place when asked, and the composer below. The conversations draw
 * themselves (ConversationPane) and the composer sends (Composer); this view wires the controller's
 * events to them and keeps what the two share: the popover, the approval card and the agent pane.
 */
export class LibrarianView extends ItemView {
	private readonly controller: AgentController;
	private unsubscribe: (() => void) | null = null;
	private unsubscribeMcp: (() => void) | null = null;
	/** The popover a timeline step opens (LIB-FEAT-252). */
	private popover!: StepPopover;
	/** The chat's own conversation. */
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
	private bannerEl!: HTMLElement;
	private mcpBannerEl!: HTMLElement;
	private noticeEl!: HTMLElement;
	private sessionsEl!: HTMLElement;
	/** Compacting asked for outside a run has no block, so it gets a line of its own. */
	private compactLineEl: HTMLElement | null = null;
	private approvalEl: HTMLElement | null = null;
	private historyMode = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: LibrarianPlugin,
	) {
		super(leaf);
		this.controller = plugin.controller;
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

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('librarian');
		if (Platform.isMobile) root.addClass('is-mobile');
		this.bannerEl = root.createDiv({ cls: 'librarian-key-banner is-hidden' });
		this.mcpBannerEl = root.createDiv({
			cls: 'librarian-key-banner librarian-mcp-banner is-hidden',
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
			findReadLine: (path: string, line: number) => this.controller.findReadLine(path, line),
			agentRowOf: (call: StoredToolCall, result: ToolResult | undefined, running: boolean) =>
				this.agentRowOf(call, result, running),
			openAgent: (callId: string) => void this.openAgent(callId),
			hasLiveAgent: (callId: string) => this.controller.agents.has(callId),
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
		this.unsubscribe = this.controller.subscribe((e) => this.onControllerEvent(e));
		this.unsubscribeMcp = this.plugin.mcp.subscribe(() => this.renderMcpBanner());
		this.renderMcpBanner();
		this.registerEvent(
			this.app.workspace.on('file-open', () => this.composer.renderActiveNote()),
		);
		if (this.controller.session) this.renderEvents(this.controller.events);
		await this.controller.refreshReadiness();
	}

	async onClose(): Promise<void> {
		this.unsubscribeMcp?.();
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.main.dispose();
		this.agentPane.dispose();
		if (this.agentTimer !== null) window.clearTimeout(this.agentTimer);
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
		const current = this.controller.session;
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
		if (!this.controller.session) return this.showNotice('Open a session first.');
		const outcome = await this.controller.compactNow();
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

	async newSession(): Promise<void> {
		if (this.historyMode) await this.toggleHistory();
		this.main.followBottom = true;
		await this.controller.newSession();
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

	private readonly mainStatus = (id: string) => this.controller.toolStatusOf(id);

	private renderState(state: AgentController['state']) {
		this.bannerEl.toggleClass('is-hidden', state !== 'no-key');
		if (state === 'no-key') this.renderKeyBanner();
		this.composer.renderState(state);
		this.renderActivity(state);
		// The last events of a run are drawn while it still runs; once it has ended, it folds.
		if (this.controller.session && !this.controller.isRunning && this.main.hasRunningRun)
			this.renderEvents(this.controller.events);
	}

	private renderKeyBanner() {
		const provider = this.controller.selection?.provider;
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
					await this.controller.refreshReadiness();
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
		const last = [...this.controller.events].reverse().find((e) => e.event.type === 'user');
		if (last?.event.type !== 'user') return;
		await this.controller.send(last.event.content, last.event.images ?? []);
	}

	// The chat's own conversation

	/** What the agent is doing, in the running run's header, or on a line of its own for compacting. */
	private renderActivity(state: AgentController['state']) {
		const provider = this.controller.selection?.provider;
		const nonStreaming = provider
			? this.plugin.transport.effectiveMode(provider) === 'requestUrl'
			: false;
		// Sub-agents at work: how far they are, which the rows under it tell one by one.
		const agents = [...this.controller.agents.values()];
		const busy = agents.filter((a) => a.status === 'waiting' || a.status === 'running').length;
		const activity =
			state === 'compacting'
				? 'Compacting context'
				: state === 'requesting'
					? nonStreaming
						? NO_STREAMING_NOTICE
						: 'Waiting for the model'
					: state === 'tool-running'
						? busy
							? `Running agents, ${agents.length - busy} of ${agents.length} done`
							: 'Running tools'
						: state === 'awaiting-approval'
							? 'Waiting for your approval'
							: '';
		const activityEl = this.main.activityEl;
		if (activityEl) {
			activityEl.setText(activity);
			// A narrow pane cuts it short; the whole text shows on hover.
			activityEl.setAttr('aria-label', activity);
		}
		const standalone = state === 'compacting' && !this.controller.isRunning;
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
		this.main.draw(events, { running: this.controller.isRunning, status: this.mainStatus });
		if (this.controller.pendingApproval) this.renderApproval(this.controller.pendingApproval);
		this.renderActivity(this.controller.state);
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
				? { ...request.args, agent: this.controller.agentOfCall(request.args) }
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
		const preview = this.controller.previewRewind(index);
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
				const result = await this.controller.rewind(index);
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
		this.renderActivity(this.controller.state);
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
		const live = this.controller.agents.get(call.id);
		if (live) return liveRow(live);
		const agent = this.controller.agentOfCall(call.args);
		return storedRow(call, result, running, {
			agent,
			color: this.plugin.agentDefs.get(agent)?.color,
			asking: this.controller.toolStatusOf(call.id) === 'awaiting-approval',
		});
	}

	/** Opens a sub-agent run's conversation in place of the chat's. */
	async openAgent(callId: string): Promise<void> {
		this.popover.close();
		if (this.historyMode) await this.toggleHistory();
		this.agentCall = callId;
		this.agentPane.reset();
		this.agentStored = this.controller.agents.has(callId)
			? null
			: await this.storedAgent(callId);
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
			this.renderEvents(this.controller.events);
		} else this.renderApproval(this.controller.pendingApproval);
	}

	/** A finished run read back from its session file, which the spawn_agent result names. */
	private async storedAgent(
		callId: string,
	): Promise<{ data: AgentRowData; events: IndexedEvent[] } | null> {
		const events = this.controller.events;
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
		const live = this.controller.agents.get(callId);
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
			if (this.controller.pendingApproval)
				this.renderApproval(this.controller.pendingApproval);
		} else if (live?.stream) this.agentPane.stream(live.stream, status);
		this.agentPane.scrollToBottom();
	}

	// History

	async toggleHistory(): Promise<void> {
		if (this.agentCall) this.closeAgent();
		this.historyMode = !this.historyMode;
		this.main.el.toggleClass('is-hidden', this.historyMode);
		this.sessionsEl.toggleClass('is-hidden', !this.historyMode);
		if (this.historyMode) await this.renderSessions();
	}

	private async renderSessions() {
		await renderSessionList(this.sessionsEl, this.plugin, (session) =>
			this.openSession(session.id),
		);
	}

	/** Opens a session picked from the history list or from the settings, leaving the history. */
	async openSession(id: string): Promise<void> {
		this.main.followBottom = true;
		await this.controller.openSession(id);
		if (this.historyMode) await this.toggleHistory();
		this.composer.renderModelSelect();
	}
}

type ToolResult = Extract<SessionEvent, { type: 'tool_result' }>;
