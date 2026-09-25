import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
	Component,
	FuzzySuggestModal,
	ItemView,
	MarkdownRenderer,
	Menu,
	Modal,
	Notice,
	Platform,
	setIcon,
	TFile,
	type WorkspaceLeaf,
} from 'obsidian';
import type {
	AgentController,
	ApprovalRequest,
	ControllerEvent,
	QueuedMessage,
	ToolCardStatus,
} from '../agent/agent-controller';
import { vaultReferenceReader } from '../agent/prompt';
import { expandReferences } from '../agent/references';
import { SPAWN_AGENT_NAME, type SubagentState } from '../agent/subagent';
import { type ContextUsage, cacheHitRatio } from '../context/context-manager';
import type LibrarianPlugin from '../main';
import { selectableThinkingLevels } from '../provider/provider-manager';
import { NO_STREAMING_NOTICE } from '../provider/transport';
import { replay } from '../session/session-manager';
import type {
	IndexedEvent,
	SessionEvent,
	SessionMetadata,
	StoredToolCall,
} from '../session/session-types';
import { skillKey } from '../skills/skill-manager';
import { isBinaryPath } from '../tools/path-policy';
import {
	AGENT_STATUS_LABELS,
	type AgentRowData,
	liveRow,
	renderAgentRow,
	storedRow,
	updateAgentRow,
} from './agent-rows';
import {
	renderApprovalCard,
	renderToolDetails,
	STATUS_LABELS,
	summarizeCall,
	type ToolCardData,
	toolIcon,
} from './cards';
import {
	ATTACHED_BLOCK,
	applyMention,
	draftOf,
	folderBlock,
	type MentionTarget,
	mentionLabel,
	mentionQuery,
	rankMentions,
} from './mentions';
import { segment, setChecked, steadyLabel } from './segmented';
import { ConfirmModal, confirmDeleteSession, renderSessionList } from './session-list';
import { fillTemplate, matchCommands, parseSlash, type SlashCommand } from './slash-commands';
import { linkSources, openSource } from './sources';
import { StreamingMarkdown } from './stream-text';
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
	StepPopover,
	setChipStatus,
	viewOf,
} from './work-log';

export const VIEW_TYPE_LIBRARIAN = 'librarian-chat';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

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
 * Where a conversation is drawn and how its state is read: the chat's own, or a sub-agent's in
 * the agent pane (LIB-FEAT-140), which looks the same with the main agent's messages on the right.
 */
interface Stage {
	el: HTMLElement;
	/** Its last run is still at work. */
	running: boolean;
	status(toolCallId: string): ToolCardStatus | undefined;
	folds: Folds;
	/** Over each message on the right, who wrote it, when that is not the user. */
	asker?: string;
	/** The chat's own conversation offers rewinding to each of its messages. */
	rewind?: (index: number) => void;
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

/** One row of the list above the input: a slash command, a skill name or an @mention target. */
interface Suggestion {
	name: string;
	description: string;
	accept: (run: boolean) => void | Promise<void>;
}

function formatTokens(n: number): string {
	return n.toLocaleString('en-US');
}

function compactTokens(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Models on top, effort below: the same two choices the old header selects offered. */
class ModelPickerModal extends Modal {
	constructor(
		app: LibrarianPlugin['app'],
		private readonly plugin: LibrarianPlugin,
		private readonly controller: AgentController,
		private readonly onChange: () => void,
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText('Model');
		this.modalEl.addClass('librarian-modal');
		this.render();
	}

	private render() {
		const el = this.contentEl;
		el.empty();
		const current = this.controller.selection;
		const options = this.plugin.providers.listSelectable();
		const list = el.createDiv({ cls: 'librarian-picker-list' });
		for (const { provider, model } of options) {
			const selected = current?.provider.id === provider.id && current.model.id === model.id;
			const row = list.createDiv({
				cls: `librarian-picker-row${selected ? ' is-selected' : ''}`,
				attr: { role: 'button', tabindex: '0' },
			});
			const text = row.createDiv({ cls: 'librarian-picker-text' });
			text.createDiv({ cls: 'librarian-picker-title', text: model.name });
			text.createDiv({
				cls: 'librarian-picker-sub',
				text: `${provider.name}${model.input.includes('image') ? ', images' : ''}`,
			});
			if (selected) setIcon(row.createSpan({ cls: 'librarian-picker-check' }), 'check');
			const pick = () =>
				void this.controller.setModel(provider.id, model.id).then(() => {
					this.onChange();
					this.render();
				});
			row.addEventListener('click', pick);
			row.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') pick();
			});
		}
		if (!options.length) {
			el.createDiv({
				cls: 'librarian-modal-note',
				text: 'No tool-calling model is configured.',
			});
			const open = el.createEl('button', { text: 'Open settings' });
			open.addEventListener('click', () => {
				this.close();
				this.plugin.openSettings();
			});
		}
		const levels = current ? selectableThinkingLevels(current.model) : [];
		if (levels.length > 1) {
			el.createDiv({ cls: 'librarian-picker-heading', text: 'Effort' });
			const seg = el.createDiv({
				cls: 'librarian-segmented',
				attr: { role: 'radiogroup', 'aria-label': 'Effort' },
			});
			for (const level of levels) {
				const option = segment(
					seg,
					level,
					() =>
						void this.controller.setThinkingLevel(level).then(() => {
							this.onChange();
							this.render();
						}),
				);
				option.setText(level);
				setChecked(option, level === this.controller.thinkingLevel);
			}
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

class VaultImageModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: LibrarianPlugin['app'],
		private readonly onPick: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder('Pick an image from the vault');
	}

	getItems(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter((f) => IMAGE_EXTENSIONS.has(f.extension.toLowerCase()));
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		this.onPick(item);
	}
}

export class LibrarianView extends ItemView {
	private readonly controller: AgentController;
	private unsubscribe: (() => void) | null = null;
	/** The popover a timeline step opens (LIB-FEAT-252). */
	private popover!: StepPopover;
	/** How the chat's own conversation is folded; the agent pane keeps its own. */
	private mainFolds = newFolds();
	/** The agent pane (LIB-FEAT-140): a sub-agent run's conversation in place of the chat's. */
	private agentEl!: HTMLElement;
	private agentHeadEl!: HTMLElement;
	private agentBodyEl!: HTMLElement;
	/** The spawn_agent call whose run the pane shows; null while the chat shows its own. */
	private agentCall: string | null = null;
	private agentFolds = newFolds();
	/** A finished run read back from its session file, for a pane opened after the run. */
	private agentStored: { data: AgentRowData; events: IndexedEvent[] } | null = null;
	/** Where the run's response on its way goes, as the chat's `live`. */
	private agentLive: Live | null = null;
	/** What the pane was last drawn from: it is drawn again only when that moved. */
	private agentDrawn: string | null = null;
	private agentTimer: number | null = null;
	/** The chat's own conversation changed while the pane covered it: drawn again on the way back. */
	private mainDirty = false;
	private followAgentBottom = true;
	/** Each drawn step's popover, by key, to open it again after a redraw. */
	private popFills = new Map<string, { anchor: HTMLElement; content: () => PopoverContent }>();
	/** The last saved response as last drawn, to tell when the streaming one has been saved. */
	private lastAssistant = -1;

	private modelButton!: HTMLButtonElement;
	private attachButton!: HTMLButtonElement;
	private cameraInput!: HTMLInputElement;
	private bannerEl!: HTMLElement;
	private mcpBannerEl!: HTMLElement;
	private unsubscribeMcp: (() => void) | null = null;
	private noticeEl!: HTMLElement;
	private messagesEl!: HTMLElement;
	private sessionsEl!: HTMLElement;
	/** Auto-scroll follows new content only while the user is reading at the bottom. */
	private followBottom = true;
	private live: Live | null = null;
	/** What the agent is doing, in the running run's header. */
	private runActivityEl: HTMLElement | null = null;
	/** Compacting asked for outside a run has no block, so it gets a line of its own. */
	private compactLineEl: HTMLElement | null = null;
	private approvalEl: HTMLElement | null = null;
	private composerEl!: HTMLElement;
	private activeNoteEl!: HTMLElement;
	private imagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	/** The send slot shows Stop: a run is on and the composer is empty. */
	private stopMode = false;
	private queueEl!: HTMLElement;
	private imageNoticeEl!: HTMLElement;
	private ringEl!: HTMLElement;
	private popoverEl!: HTMLElement;
	private pickModelEl!: HTMLElement;
	private fileInput!: HTMLInputElement;

	private historyMode = false;
	private includeActiveNote = false;
	private suggestEl!: HTMLElement;
	private suggestions: Suggestion[] = [];
	private suggestIndex = 0;
	private mentionsEl!: HTMLElement;
	private pendingMentions: MentionTarget[] = [];
	private keyboardLog = 'none yet';
	private animatingSince = 0;
	private pendingImages: string[] = [];
	private streamTimer: number | null = null;
	private pendingStream: AssistantMessage | null = null;

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
		this.messagesEl = root.createDiv({ cls: 'librarian-messages' });
		// The popover stays inside whichever conversation shows: the chat's, or the agent pane's.
		this.popover = new StepPopover(root, () =>
			(this.agentCall ? this.agentBodyEl : this.messagesEl).getBoundingClientRect(),
		);
		this.messagesEl.addEventListener('scroll', () => {
			const el = this.messagesEl;
			this.followBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
			this.popover.reposition();
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
		this.watchLinks(this.messagesEl);
		this.sessionsEl = root.createDiv({ cls: 'librarian-sessions is-hidden' });
		this.buildAgentPane(root);
		// Messages sent while the agent works, waiting above the composer (LIB-FEAT-184).
		this.queueEl = root.createDiv({ cls: 'librarian-queue is-hidden' });
		this.buildComposer(root);
		this.unsubscribe = this.controller.subscribe((e) => this.onControllerEvent(e));
		this.unsubscribeMcp = this.plugin.mcp.subscribe(() => this.renderMcpBanner());
		this.renderMcpBanner();
		this.registerEvent(this.app.workspace.on('file-open', () => this.renderActiveNote()));
		// Phones and tablets alike: Obsidian keeps the app full height while the keyboard rises on
		// both, so the composer has to ride up on its own there too (styles.css).
		if (Platform.isMobile) {
			// Obsidian dispatches these on window from the native keyboard. What is recorded here
			// is only for the /layout command, which reports the mobile layout numbers.
			const k = () =>
				getComputedStyle(document.documentElement).getPropertyValue('--keyboard-height');
			this.registerDomEvent(window, 'keyboardWillShow' as keyof WindowEventMap, () => {
				this.keyboardLog = `show K=${k().trim()} at ${new Date().toLocaleTimeString()}`;
			});
			const safe = () =>
				getComputedStyle(document.documentElement)
					.getPropertyValue('--safe-area-inset-bottom')
					.trim();
			this.registerDomEvent(window, 'keyboardWillHide' as keyof WindowEventMap, () => {
				this.keyboardLog += `, hide K=${k().trim()} safe=${safe()}`;
			});
			// The padding measured while the keyboard is closed; the closing animation keeps it
			// (styles.css) so the composer does not drop behind the navbar and jump back.
			const rememberClosed = () => {
				if (parseFloat(k()) > 0 || document.body.hasClass('keyboard-animating')) return;
				this.composerEl.style.setProperty(
					'--librarian-closed-padding',
					getComputedStyle(this.composerEl).paddingBottom,
				);
			};
			window.requestAnimationFrame(rememberClosed);
			const observer = new MutationObserver(() => {
				const on = document.body.hasClass('keyboard-animating');
				if (on && !this.animatingSince) this.animatingSince = Date.now();
				if (!on && this.animatingSince) {
					this.keyboardLog += `, animating ${Date.now() - this.animatingSince} ms, safe after=${safe()}`;
					this.animatingSince = 0;
					window.requestAnimationFrame(rememberClosed);
				}
			});
			observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
			this.register(() => observer.disconnect());
		}
		this.renderModelSelect();
		this.renderActiveNote();
		if (this.controller.session) this.renderEvents(this.controller.events);
		this.renderQueue(this.controller.queue);
		await this.controller.refreshReadiness();
	}

	async onClose(): Promise<void> {
		this.unsubscribeMcp?.();
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.streamTimer !== null) window.clearTimeout(this.streamTimer);
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

	/** Refreshes the model button in the composer and the pick-a-model block. */
	renderModelSelect() {
		const options = this.plugin.providers.listSelectable();
		const current = this.controller.selection;
		this.modelButton.empty();
		this.modelButton.createSpan({
			cls: 'librarian-model-name',
			text: current ? current.model.name : options.length ? 'Pick a model' : 'No model',
		});
		const level = this.controller.thinkingLevel;
		if (current && level !== 'off')
			this.modelButton.createSpan({ cls: 'librarian-model-effort', text: level });
		this.pickModelEl?.empty();
		if (this.pickModelEl) {
			this.pickModelEl.createSpan({ text: 'Pick a model to continue' });
			const select = this.pickModelEl.createEl('select', { cls: 'dropdown' });
			select.createEl('option', { value: '', text: 'Choose a model' });
			for (const { provider, model } of options) {
				select.createEl('option', {
					value: `${provider.id}\u0000${model.id}`,
					text: `${provider.name} / ${model.name}`,
				});
			}
			select.addEventListener('change', () => {
				const [providerId, modelId] = select.value.split('\u0000');
				if (providerId && modelId)
					void this.controller
						.setModel(providerId, modelId)
						.then(() => this.renderModelSelect());
			});
			if (!options.length) {
				const open = this.pickModelEl.createEl('button', { text: 'Open settings' });
				open.addEventListener('click', () => this.plugin.openSettings());
			}
		}
	}

	// Composer

	private buildComposer(root: HTMLElement) {
		this.pickModelEl = root.createDiv({ cls: 'librarian-pick-model is-hidden' });
		this.composerEl = root.createDiv({ cls: 'librarian-composer' });
		this.suggestEl = this.composerEl.createDiv({ cls: 'librarian-slash is-hidden' });
		const box = this.composerEl.createDiv({ cls: 'librarian-composer-box' });
		this.activeNoteEl = box.createDiv({ cls: 'librarian-active-note is-hidden' });
		this.mentionsEl = box.createDiv({ cls: 'librarian-mentions is-hidden' });
		this.imagesEl = box.createDiv({ cls: 'librarian-images is-hidden' });
		this.imageNoticeEl = box.createDiv({ cls: 'librarian-image-notice is-hidden' });
		this.inputEl = box.createEl('textarea', {
			cls: 'librarian-input',
			attr: { placeholder: 'Ask a question', rows: '2', 'aria-label': 'Message' },
		});
		this.inputEl.addEventListener('input', () => {
			this.updateSendEnabled();
			this.renderSuggestions();
		});
		this.inputEl.addEventListener('keydown', (e) => {
			if (this.suggestions.length && !e.isComposing && this.handleSuggestKey(e)) return;
			if (e.key === 'Enter' && !e.shiftKey && !Platform.isMobile && !e.isComposing) {
				e.preventDefault();
				void this.submit();
			}
		});
		this.inputEl.addEventListener('paste', (e) => {
			const items = e.clipboardData?.items;
			if (!items) return;
			for (const item of Array.from(items)) {
				if (!item.type.startsWith('image/')) continue;
				const file = item.getAsFile();
				if (file) {
					e.preventDefault();
					void this.addImageFile(file);
				}
			}
		});
		const row = box.createDiv({ cls: 'librarian-composer-row' });
		this.attachButton = row.createEl('button', {
			cls: 'librarian-attach clickable-icon',
			attr: { 'aria-label': 'Attach', 'aria-haspopup': 'true' },
		});
		setIcon(this.attachButton, 'plus');
		this.attachButton.addEventListener('click', (e) => this.showAttachMenu(e));
		this.fileInput = row.createEl('input', {
			type: 'file',
			cls: 'is-hidden',
			attr: { accept: 'image/*', multiple: 'true' },
		});
		this.fileInput.addEventListener('change', () => {
			for (const file of Array.from(this.fileInput.files ?? [])) void this.addImageFile(file);
			this.fileInput.value = '';
		});
		this.cameraInput = row.createEl('input', {
			type: 'file',
			cls: 'is-hidden',
			attr: { accept: 'image/*', capture: 'environment' },
		});
		this.cameraInput.addEventListener('change', () => {
			for (const file of Array.from(this.cameraInput.files ?? []))
				void this.addImageFile(file);
			this.cameraInput.value = '';
		});
		this.modelButton = row.createEl('button', {
			cls: 'librarian-model-button',
			attr: { 'aria-label': 'Model and effort', 'aria-haspopup': 'dialog' },
		});
		this.modelButton.addEventListener('click', () =>
			new ModelPickerModal(this.app, this.plugin, this.controller, () =>
				this.renderModelSelect(),
			).open(),
		);
		row.createDiv({ cls: 'librarian-composer-spacer' });
		// Not a button: hovering (or a tap, which fires mouseenter) shows the popover; nothing to click.
		this.ringEl = row.createDiv({
			cls: 'librarian-context-indicator',
			attr: { role: 'img', 'aria-label': 'Context usage' },
		});
		this.popoverEl = row.createDiv({ cls: 'librarian-context-popover is-hidden' });
		this.ringEl.addEventListener('mouseenter', () => this.showPopover(true));
		this.ringEl.addEventListener('mouseleave', () => this.showPopover(false));
		// Appears only when there is something to send; Stop while the agent runs and the input is
		// empty. It keeps its box while hidden so CSS can grow it from a dot and slide the ring.
		this.sendButton = row.createEl('button', {
			cls: 'librarian-send is-hidden',
			attr: { 'aria-label': 'Send', 'aria-hidden': 'true', tabindex: '-1' },
		});
		const disc = this.sendButton.createSpan({ cls: 'librarian-send-disc' });
		setIcon(disc.createSpan({ cls: 'librarian-send-arrow' }), 'arrow-up');
		disc.createSpan({ cls: 'librarian-send-stop' });
		this.sendButton.addEventListener('click', () => {
			if (this.stopMode) this.controller.stop();
			else void this.submit();
		});
	}

	/**
	 * The "+" menu: images from the camera, the device or the vault, the active note, and the
	 * settings. Obsidian hides the view header in a sidebar, so this is the only menu the chat
	 * always shows and the one place Settings is reachable from there.
	 */
	private showAttachMenu(e: MouseEvent) {
		const menu = new Menu();
		const images = this.modelAcceptsImages();
		if (Platform.isMobile)
			menu.addItem((item) =>
				item
					.setTitle('Camera')
					.setIcon('camera')
					.setDisabled(!images)
					.onClick(() => this.cameraInput.click()),
			);
		menu.addItem((item) =>
			item
				.setTitle(Platform.isMobile ? 'Photos' : 'Choose an image')
				.setIcon('image')
				.setDisabled(!images)
				.onClick(() => this.fileInput.click()),
		);
		menu.addItem((item) =>
			item
				.setTitle('Image from vault')
				.setIcon('folder')
				.setDisabled(!images)
				.onClick(() =>
					new VaultImageModal(this.app, (f) => this.addImagePath(f.path)).open(),
				),
		);
		if (!images)
			menu.addItem((item) =>
				item.setTitle('This model does not accept images').setDisabled(true),
			);
		menu.addItem((item) =>
			item
				.setTitle(this.includeActiveNote ? 'Remove active note' : 'Attach active note')
				.setIcon('file-text')
				.onClick(() => this.toggleActiveNote()),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle('Settings')
				.setIcon('settings')
				.onClick(() => this.plugin.openSettings()),
		);
		menu.showAtMouseEvent(e);
	}

	private showPopover(show: boolean) {
		this.popoverEl.toggleClass('is-hidden', !show);
	}

	private renderActiveNote() {
		const file = this.app.workspace.getActiveFile();
		this.activeNoteEl.empty();
		if (!this.includeActiveNote || !file || file.extension !== 'md') {
			this.includeActiveNote = false;
			this.activeNoteEl.addClass('is-hidden');
			return;
		}
		this.activeNoteEl.removeClass('is-hidden');
		setIcon(this.activeNoteEl.createSpan(), 'file-text');
		this.activeNoteEl.createSpan({ text: ` ${file.path}` });
		const remove = this.activeNoteEl.createEl('button', {
			cls: 'clickable-icon',
			attr: { 'aria-label': 'Remove note' },
		});
		setIcon(remove, 'x');
		remove.addEventListener('click', () => this.toggleActiveNote());
	}

	toggleActiveNote() {
		const file = this.app.workspace.getActiveFile();
		if (!this.includeActiveNote && file?.extension !== 'md') {
			new Notice('Open a Markdown note first.');
			return;
		}
		this.includeActiveNote = !this.includeActiveNote;
		this.renderActiveNote();
		void this.controller.recalculateUsage();
	}

	private modelAcceptsImages(): boolean {
		return this.controller.selection?.model.input.includes('image') ?? false;
	}

	private async addImageFile(file: File) {
		if (!this.modelAcceptsImages()) {
			this.imageNoticeEl.setText(
				'This model does not accept images. Pick a model with image input.',
			);
			this.imageNoticeEl.removeClass('is-hidden');
			return;
		}
		const ext = (file.name.split('.').pop() || 'png').toLowerCase();
		const name = `librarian-${Date.now()}.${IMAGE_EXTENSIONS.has(ext) ? ext : 'png'}`;
		const active = this.app.workspace.getActiveFile();
		const path = await this.app.fileManager.getAvailablePathForAttachment(name, active?.path);
		const created = await this.app.vault.createBinary(path, await file.arrayBuffer());
		this.addImagePath(created.path);
	}

	private addImagePath(path: string) {
		if (!this.pendingImages.includes(path)) this.pendingImages.push(path);
		this.renderImages();
	}

	private renderImages() {
		this.imagesEl.empty();
		this.imagesEl.toggleClass('is-hidden', this.pendingImages.length === 0);
		for (const path of this.pendingImages) {
			const chip = this.imagesEl.createDiv({ cls: 'librarian-image-chip' });
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile)
				chip.createEl('img', {
					attr: { src: this.app.vault.getResourcePath(file), alt: path },
				});
			chip.createSpan({ text: path.slice(path.lastIndexOf('/') + 1) });
			const remove = chip.createEl('button', {
				cls: 'clickable-icon',
				attr: { 'aria-label': 'Remove image' },
			});
			setIcon(remove, 'x');
			remove.addEventListener('click', () => {
				this.pendingImages = this.pendingImages.filter((p) => p !== path);
				this.renderImages();
				this.updateSendEnabled();
			});
		}
		this.updateSendEnabled();
		void this.controller.recalculateUsage();
	}

	private updateSendEnabled() {
		const blockedByImages = this.pendingImages.length > 0 && !this.modelAcceptsImages();
		this.imageNoticeEl.toggleClass('is-hidden', !blockedByImages);
		if (blockedByImages)
			this.imageNoticeEl.setText(
				'This model does not accept images. Pick a model with image input.',
			);
		const state = this.controller.state;
		const running = this.controller.isRunning;
		// While the agent runs, Send queues the message (LIB-FEAT-184).
		const canSend =
			state !== 'no-key' &&
			state !== 'model-unavailable' &&
			!blockedByImages &&
			(this.inputEl.value.trim().length > 0 || this.pendingImages.length > 0);
		const show = running || canSend;
		this.stopMode = running && !canSend;
		const button = this.sendButton;
		if (show && button.hasClass('is-hidden')) {
			// Appearing, it wears its glyph at once; only a change while shown morphs through the dot.
			button.addClass('is-instant');
			button.toggleClass('is-running', this.stopMode);
			button.getBoundingClientRect();
			button.removeClass('is-instant');
		} else if (show) {
			button.toggleClass('is-running', this.stopMode);
		}
		button.toggleClass('is-hidden', !show);
		button.setAttr('aria-hidden', String(!show));
		button.setAttr('tabindex', show ? '0' : '-1');
		button.setAttr('aria-label', this.stopMode ? 'Stop' : 'Send');
		this.inputEl.disabled = state === 'no-key' || state === 'model-unavailable';
	}

	async submit() {
		const typed = this.inputEl.value.trim();
		if (!typed && this.pendingImages.length === 0) return;
		const slash = parseSlash(typed);
		if (slash && this.pendingImages.length === 0) {
			const command = this.slashCommands().find((c) => c.name === slash.name);
			if (!command) {
				this.showNotice(`Unknown command: /${slash.name}`);
				return;
			}
			this.inputEl.value = '';
			this.renderSuggestions();
			this.updateSendEnabled();
			await command.run(slash.args);
			return;
		}
		await this.sendText(typed);
	}

	/** Built-in actions plus one command per note in the commands folder. */
	private slashCommands(): SlashCommand[] {
		const builtIn: SlashCommand[] = [
			{ name: 'new', description: 'Start a new session', run: () => this.newSession() },
			{
				name: 'settings',
				description: 'Open the Librarian settings',
				run: () => this.plugin.openSettings(),
			},
			{
				name: 'history',
				description: 'Open session history',
				run: () => this.toggleHistory(),
			},
			{
				name: 'compact',
				description: 'Compact the context now',
				run: async () => {
					if (!this.controller.session) return this.showNotice('Open a session first.');
					const outcome = await this.controller.compactNow();
					if (outcome !== 'failed')
						this.showNotice(
							outcome === 'compacted'
								? 'Context compacted.'
								: 'Nothing to compact yet.',
						);
				},
			},
			{
				name: 'note',
				description: 'Attach the active note to the next message',
				run: () => this.includeActiveNoteInPrompt(),
			},
			{
				name: 'model',
				description: 'Switch model: /model <part of its name>',
				run: async (args) => {
					const query = args.toLowerCase();
					const hit = this.plugin.providers
						.listSelectable()
						.find(({ provider, model }) =>
							`${provider.name} ${model.name} ${model.id}`
								.toLowerCase()
								.includes(query),
						);
					if (!hit || !query)
						return this.showNotice('No model matches. Try /model <name>.');
					await this.controller.setModel(hit.provider.id, hit.model.id);
					this.renderModelSelect();
				},
			},
			{
				name: 'thinking',
				description: 'Set the thinking level: /thinking off|low|medium|high',
				run: async (args) => {
					const model = this.controller.selection?.model;
					const levels = model ? selectableThinkingLevels(model) : [];
					const level = levels.find((l) => l === args.toLowerCase());
					if (!level)
						return this.showNotice(`Thinking levels: ${levels.join(', ') || 'off'}`);
					await this.controller.setThinkingLevel(level);
					this.renderModelSelect();
				},
			},
			{
				name: 'skill',
				description: 'Run a skill: /skill <name> [request]',
				run: async (args) => {
					const [name = '', ...rest] = args.split(/\s+/);
					const skills = this.plugin.skills.skills;
					if (!name)
						return this.showNotice(
							skills.map((s) => `${s.name}: ${s.description}`).join('\n') ||
								'No skills found.',
						);
					const skill = this.plugin.skills.get(name);
					if (!skill) return this.showNotice(`Unknown skill: ${name}`);
					if (this.plugin.permissions.get(skillKey(skill.name)) === 'blocked')
						return this.showNotice(`Skill "${skill.name}" is blocked in Settings.`);
					const request = rest.join(' ').trim();
					await this.sendText(
						`${request || `Use the ${skill.name} skill.`}\n\n${await this.plugin.skills.activation(skill)}`,
						skill.location,
					);
				},
			},
			{
				name: 'layout',
				description: 'Show the layout numbers of this view (debugging)',
				run: () => {
					const css = (el: Element, prop: string) =>
						getComputedStyle(el).getPropertyValue(prop).trim();
					const rect = (selector: string) => {
						const el = document.querySelector(selector);
						if (!el) return 'none';
						const r = el.getBoundingClientRect();
						return `${Math.round(r.top)}-${Math.round(r.bottom)}`;
					};
					const html = document.documentElement;
					const body = document.body;
					const lines = [
						`inner ${window.innerHeight}, visual ${Math.round(window.visualViewport?.height ?? 0)}, screen ${window.screen.height}`,
						`keyboard-height ${css(html, '--keyboard-height')}, navbar-height ${css(body, '--navbar-height')}, safe-bottom ${css(html, '--safe-area-inset-bottom')}`,
						`view-bottom-spacing ${css(this.composerEl, '--view-bottom-spacing')}, composer padding-bottom ${css(this.composerEl, 'padding-bottom')}`,
						`body: ${Array.from(body.classList)
							.filter((c) => /phone|mobile|nav|keyboard|screen|ios|android/.test(c))
							.join(' ')}`,
						`app-container ${rect('.app-container')}, workspace ${rect('.workspace')}, leaf ${rect('.workspace-leaf.mod-active')}, view ${rect('.workspace-leaf.mod-active .view-content')}`,
						`composer ${rect('.librarian-composer')}, box ${rect('.librarian-composer-box')}, navbar ${rect('.mobile-navbar')}, toolbar ${rect('.mobile-toolbar')}`,
						`keyboard: ${this.keyboardLog}`,
					];
					new Notice(lines.join('\n'), 0);
				},
			},
			{
				name: 'help',
				description: 'List the commands',
				run: () =>
					this.showNotice(
						this.slashCommands()
							.map((c) => `/${c.name}: ${c.description}`)
							.join('\n'),
					),
			},
		];
		const folder = this.plugin.settings.commandsFolder;
		const custom: SlashCommand[] = folder
			? this.app.vault
					.getMarkdownFiles()
					.filter((f) => f.path.startsWith(`${folder}/`))
					.map((file) => {
						const description = this.app.metadataCache.getFileCache(file)?.frontmatter
							?.description as unknown;
						return {
							name: file.basename.toLowerCase().replace(/\s+/g, '-'),
							description: typeof description === 'string' ? description : file.path,
							run: async (args: string) => {
								const raw = await this.app.vault.cachedRead(file);
								const end =
									this.app.metadataCache.getFileCache(file)?.frontmatterPosition
										?.end.offset;
								const body = (end ? raw.slice(end) : raw).trim();
								await this.sendText(fillTemplate(body, args), file.path);
							},
						};
					})
			: [];
		const names = new Set(builtIn.map((c) => c.name));
		return [...builtIn, ...custom.filter((c) => !names.has(c.name))];
	}

	/**
	 * What the input offers right now: commands after `/`, skill names after `/skill `, notes and
	 * folders after `@` at the caret. The same list and keys serve all three.
	 */
	private renderSuggestions() {
		const value = this.inputEl.value;
		const caret = this.inputEl.selectionStart ?? value.length;
		let list: Suggestion[] = [];
		const skillArgs = /^\/skill\s+(\S*)$/.exec(value);
		if (skillArgs) {
			const prefix = skillArgs[1]!.toLowerCase();
			list = this.plugin.skills.skills
				.filter((s) => s.name.startsWith(prefix))
				.map((s) => ({
					name: s.name,
					description: s.description,
					// Always insert: the user goes on to type the request after the name.
					accept: () => this.acceptText(`/skill ${s.name} `, false),
				}));
		} else if (value.startsWith('/')) {
			list = matchCommands(this.slashCommands(), value).map((c) => ({
				name: `/${c.name}`,
				description: c.description,
				accept: (run) => this.acceptText(`/${c.name} `, run),
			}));
		} else {
			const query = mentionQuery(value, caret);
			if (query)
				list = rankMentions(this.mentionTargets(), query.query).map((t) => ({
					name: `@${mentionLabel(t)}`,
					description: t.path,
					accept: () => this.acceptMention(query, caret, t),
				}));
		}
		this.suggestions = list;
		this.suggestIndex = 0;
		this.suggestEl.empty();
		this.suggestEl.toggleClass('is-hidden', list.length === 0);
		list.forEach((item, i) => {
			const row = this.suggestEl.createDiv({
				cls: `librarian-slash-item${i === 0 ? ' is-selected' : ''}`,
			});
			row.createSpan({ cls: 'librarian-slash-name', text: item.name });
			row.createSpan({ cls: 'librarian-slash-desc', text: item.description });
			row.addEventListener('mousedown', (e) => {
				e.preventDefault();
				this.suggestIndex = i;
				void item.accept(true);
			});
		});
	}

	private mentionTargets(): MentionTarget[] {
		return [
			...this.app.vault
				.getAllFolders()
				.map((f): MentionTarget => ({ path: f.path, kind: 'folder' })),
			...this.app.vault
				.getFiles()
				.map((f): MentionTarget => ({ path: f.path, kind: 'file' })),
		];
	}

	/** Arrow keys move, Tab completes, Enter runs a command or completes a mention, Escape closes. */
	private handleSuggestKey(e: KeyboardEvent): boolean {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			const n = this.suggestions.length;
			this.suggestIndex = (this.suggestIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
			this.suggestEl.querySelectorAll('.librarian-slash-item').forEach((el, i) => {
				el.toggleClass('is-selected', i === this.suggestIndex);
			});
			e.preventDefault();
			return true;
		}
		if (e.key === 'Tab' || e.key === 'Enter') {
			e.preventDefault();
			void this.suggestions[this.suggestIndex]?.accept(e.key === 'Enter');
			return true;
		}
		if (e.key === 'Escape') {
			this.closeSuggestions();
			return true;
		}
		return false;
	}

	private closeSuggestions() {
		this.suggestions = [];
		this.suggestEl.addClass('is-hidden');
	}

	private async acceptText(text: string, run: boolean) {
		this.inputEl.value = text;
		this.closeSuggestions();
		this.updateSendEnabled();
		if (run) await this.submit();
		else this.inputEl.focus();
	}

	/** Puts `@label` in the text and a chip with the full path under it. */
	private acceptMention(
		query: ReturnType<typeof mentionQuery>,
		caret: number,
		target: MentionTarget,
	) {
		if (!query) return;
		const next = applyMention(this.inputEl.value, query, caret, mentionLabel(target));
		this.inputEl.value = next.text;
		this.inputEl.setSelectionRange(next.caret, next.caret);
		const ext = target.path.slice(target.path.lastIndexOf('.') + 1).toLowerCase();
		// An image mention is an image attachment, with the same model check as the + menu.
		if (target.kind === 'file' && IMAGE_EXTENSIONS.has(ext)) this.addImagePath(target.path);
		else if (!this.pendingMentions.some((m) => m.path === target.path))
			this.pendingMentions.push(target);
		this.renderMentions();
		this.closeSuggestions();
		this.updateSendEnabled();
		this.inputEl.focus();
	}

	private renderMentions() {
		this.mentionsEl.empty();
		this.mentionsEl.toggleClass('is-hidden', this.pendingMentions.length === 0);
		for (const target of this.pendingMentions) {
			const chip = this.mentionsEl.createDiv({ cls: 'librarian-mention' });
			setIcon(chip.createSpan(), target.kind === 'folder' ? 'folder' : 'file-text');
			chip.createSpan({ text: ` ${target.path}` });
			const remove = chip.createEl('button', {
				cls: 'clickable-icon',
				attr: { 'aria-label': 'Remove mention' },
			});
			setIcon(remove, 'x');
			remove.addEventListener('click', () => {
				this.pendingMentions = this.pendingMentions.filter((m) => m.path !== target.path);
				this.renderMentions();
			});
		}
		void this.controller.recalculateUsage();
	}

	/** Sends a message: the attached note, the mention chips, then any `@path` notes the text refers to. */
	private async sendText(typed: string, from = '') {
		let text = typed;
		this.followBottom = true;
		// Notes already attached are not inlined a second time by the `@path` expansion.
		const seen = new Set<string>([from]);
		if (this.includeActiveNote) {
			const file = this.app.workspace.getActiveFile();
			if (file && file.extension === 'md') {
				const content = await this.app.vault.cachedRead(file);
				text = `${text}\n\n<attached_note path="${file.path}">\n${content}\n</attached_note>`;
				seen.add(file.path);
			}
			this.includeActiveNote = false;
			this.renderActiveNote();
		}
		for (const mention of this.pendingMentions) {
			if (mention.kind === 'file') {
				const file = this.app.vault.getFileByPath(mention.path);
				if (!file || seen.has(file.path)) continue;
				if (isBinaryPath(file.path)) {
					// Nothing to inline; the path tells the model the file exists.
					text = `${text}\n\n<attached_file path="${file.path}" />`;
				} else {
					const content = await this.app.vault.cachedRead(file);
					text = `${text}\n\n<attached_note path="${file.path}">\n${content}\n</attached_note>`;
				}
				seen.add(file.path);
			} else {
				const notes = this.app.vault
					.getFiles()
					.filter((f) => f.path.startsWith(`${mention.path}/`))
					.map((f) => f.path)
					.sort();
				text = `${text}\n\n${folderBlock(mention.path, notes)}`;
			}
		}
		this.pendingMentions = [];
		this.renderMentions();
		const expanded = await expandReferences(text, from, vaultReferenceReader(this.app), {
			seen,
		});
		text = expanded.text;
		const images = [...this.pendingImages];
		this.pendingImages = [];
		this.inputEl.value = '';
		this.closeSuggestions();
		// Started before the redraw so the button morphs from Send to Stop instead of leaving.
		const sending = this.controller.send(text, images);
		this.renderImages();
		this.hideNotice();
		if (this.historyMode) await this.toggleHistory();
		await sending;
	}

	async newSession() {
		if (this.historyMode) await this.toggleHistory();
		this.followBottom = true;
		await this.controller.newSession();
		this.renderModelSelect();
		this.inputEl.focus();
	}

	// Controller events

	private onControllerEvent(event: ControllerEvent) {
		switch (event.type) {
			case 'state':
				this.renderState(event.state);
				break;
			case 'session':
				this.mainFolds = newFolds();
				this.lastAssistant = -1;
				this.popover.close();
				// Another conversation: its agents are not the ones the pane showed.
				if (this.agentCall) this.closeAgent(false);
				this.renderModelSelect();
				break;
			case 'events':
				this.renderEvents(event.events);
				break;
			case 'stream':
				this.queueStream(event.message);
				break;
			case 'tool-status':
				this.updateToolStatus(event.toolCallId, event.status);
				break;
			case 'approval':
				this.renderApproval(event.request);
				break;
			case 'usage':
				this.renderUsage(event.usage);
				break;
			case 'notice':
				this.showNotice(event.message);
				break;
			case 'error':
				this.renderError(event.message);
				break;
			case 'queue':
				this.renderQueue(event.queue);
				break;
			case 'unsent':
				this.restoreUnsent(event.messages);
				break;
			case 'agent':
				this.onAgent(event.agent);
				break;
		}
	}

	/** Messages waiting for the run, each with Send now on its left (LIB-FEAT-184, LIB-FEAT-185). */
	private renderQueue(queue: readonly QueuedMessage[]) {
		this.queueEl.empty();
		this.queueEl.toggleClass('is-hidden', queue.length === 0);
		for (const item of queue) {
			const row = this.queueEl.createDiv({
				cls: 'librarian-msg librarian-msg-user librarian-queued',
			});
			if (item.now) {
				row.createSpan({ cls: 'librarian-send-now is-sending', text: 'Sending' });
			} else {
				const now = row.createEl('button', { cls: 'librarian-send-now', text: 'Send now' });
				now.addEventListener('click', () => this.controller.sendNow(item.id));
			}
			this.renderBubble(row, item.text, item.images);
		}
		this.queueEl.scrollTop = this.queueEl.scrollHeight;
	}

	/** Messages the run did not send go back into the composer, ahead of what is there already. */
	private restoreUnsent(messages: QueuedMessage[]) {
		const drafts = messages.map((m) => draftOf(m.text));
		this.inputEl.value = [...drafts.map((d) => d.text), this.inputEl.value.trim()]
			.filter(Boolean)
			.join('\n\n');
		for (const target of drafts.flatMap((d) => d.mentions))
			if (!this.pendingMentions.some((m) => m.path === target.path))
				this.pendingMentions.push(target);
		this.renderMentions();
		for (const path of messages.flatMap((m) => m.images))
			if (!this.pendingImages.includes(path)) this.pendingImages.push(path);
		this.renderImages();
	}

	private renderState(state: AgentController['state']) {
		this.bannerEl.toggleClass('is-hidden', state !== 'no-key');
		if (state === 'no-key') this.renderKeyBanner();
		this.pickModelEl.toggleClass('is-hidden', state !== 'model-unavailable');
		this.renderModelSelect();
		this.composerEl.toggleClass('is-hidden', state === 'model-unavailable');
		this.renderActivity(state);
		// The last events of a run are drawn while it still runs; once it has ended, it folds.
		if (
			this.controller.session &&
			!this.controller.isRunning &&
			this.mainFolds.runningKey !== null
		)
			this.renderEvents(this.controller.events);
		this.updateSendEnabled();
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
					this.inputEl.focus();
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
		const block = this.messagesEl.createDiv({ cls: 'librarian-error' });
		block.createDiv({ text: message });
		const row = block.createDiv({ cls: 'librarian-error-buttons' });
		const retry = row.createEl('button', { text: 'Retry' });
		retry.addEventListener('click', () => void this.retryLast());
		const settings = row.createEl('button', { text: 'Open settings' });
		settings.addEventListener('click', () => this.plugin.openSettings());
		this.scrollToBottom();
	}

	private async retryLast() {
		const last = [...this.controller.events].reverse().find((e) => e.event.type === 'user');
		if (last?.event.type !== 'user') return;
		await this.controller.send(last.event.content, last.event.images ?? []);
	}

	// Messages

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
		if (this.runActivityEl) {
			this.runActivityEl.setText(activity);
			// A narrow pane cuts it short; the whole text shows on hover.
			this.runActivityEl.setAttr('aria-label', activity);
		}
		const standalone = state === 'compacting' && !this.controller.isRunning;
		if (standalone && !this.compactLineEl) {
			this.compactLineEl = this.messagesEl.createDiv({ cls: 'librarian-work is-running' });
			const header = this.compactLineEl.createDiv({ cls: 'librarian-work-header' });
			renderSpinner(header);
			header.createSpan({ cls: 'librarian-work-title', text: 'Compacting context' });
			this.scrollToBottom();
		} else if (!standalone) {
			this.compactLineEl?.remove();
			this.compactLineEl = null;
		}
	}

	/** The chat's own conversation, as its stage. */
	private mainStage(): Stage {
		return {
			el: this.messagesEl,
			running: this.controller.isRunning,
			status: (id) => this.controller.toolStatusOf(id),
			folds: this.mainFolds,
			rewind: (index) => this.confirmRewind(index),
		};
	}

	private renderEvents(events: IndexedEvent[]) {
		// The agent pane covers the chat's own conversation; it is drawn on the way back.
		if (this.agentCall) {
			this.mainDirty = true;
			return;
		}
		const atBottom = this.followBottom;
		this.messagesEl.empty();
		this.live = null;
		this.runActivityEl = null;
		this.compactLineEl = null;
		this.approvalEl = null;
		this.popFills = new Map();
		// The thinking read while it streamed is now the thinking of the response it was saved as.
		let lastAssistant = -1;
		for (const { index, event } of events)
			if (event.type === 'assistant') lastAssistant = index;
		if (this.popover.openKey === 'thinking:live' && lastAssistant > this.lastAssistant)
			this.popover.openKey = `thinking:${lastAssistant}:thinking`;
		this.lastAssistant = lastAssistant;
		this.drawRuns(this.mainStage(), events);
		if (this.pendingStream) this.renderStream(this.pendingStream);
		if (this.controller.pendingApproval) this.renderApproval(this.controller.pendingApproval);
		this.renderActivity(this.controller.state);
		this.popover.reopen(
			(key) =>
				this.popFills.get(key) ?? (key === 'thinking:live' ? this.lastThinking() : null),
		);
		if (atBottom) this.scrollToBottom(true);
	}

	/** Every run of a conversation: the message that asked, the work block, the answer. */
	private drawRuns(stage: Stage, events: IndexedEvent[]) {
		const results = new Map<string, Extract<SessionEvent, { type: 'tool_result' }>>();
		for (const { event } of events)
			if (event.type === 'tool_result') results.set(event.toolCallId, event);
		const runs = groupRuns(events);
		const folds = stage.folds;
		const running = stage.running ? (runs[runs.length - 1]?.key ?? null) : null;
		const finished =
			folds.runningKey !== null && folds.runningKey !== running ? folds.runningKey : null;
		if (running !== folds.runningKey) folds.runningFolded = false;
		folds.runningKey = running;
		for (const run of runs) {
			if (run.user) this.renderUser(run.key, run.user, stage);
			this.renderRun(run, results, run.key === running, run.key === finished, stage);
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
		results: Map<string, Extract<SessionEvent, { type: 'tool_result' }>>,
		running: boolean,
		justFinished: boolean,
		stage: Stage,
	) {
		const view = viewOf(run);
		// Before the first message there may be only a model change: nothing to show.
		if (!run.user && !view.steps.length && !view.errors.length && view.answer === null) return;
		const hasSteps = view.steps.length > 0;
		const main = stage.el === this.messagesEl;
		const folds = stage.folds;
		const block = stage.el.createDiv({ cls: 'librarian-work' });
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
		if (running && main)
			this.runActivityEl = header.createSpan({ cls: 'librarian-work-activity' });
		const body = block.createDiv({ cls: 'librarian-work-body' });
		const timeline = body.createDiv({ cls: 'librarian-timeline' });
		for (const step of view.steps) this.renderStep(timeline, step, results, running, stage);
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
				if (!opening) this.popover.close();
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
			const answer = stage.el.createDiv({
				cls: 'librarian-msg librarian-msg-assistant',
			});
			void this.renderMarkdown(answer.createDiv(), view.answer);
		}
		if (running) {
			const live: Live = {
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
			if (main) this.live = live;
			else this.agentLive = live;
		}
		for (const message of view.errors) this.renderStoredError(message, stage.el);
	}

	private renderStep(
		timeline: HTMLElement,
		step: Step,
		results: Map<string, Extract<SessionEvent, { type: 'tool_result' }>>,
		running: boolean,
		stage: Stage,
	) {
		const row = timeline.createDiv({ cls: `librarian-step is-${step.kind}` });
		if (running && !stage.folds.seen.has(step.key)) row.addClass('librarian-step-new');
		if (running) stage.folds.seen.add(step.key);
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
					const status =
						stage.status(call.id) ??
						(result ? (result.ok ? 'ok' : 'failed') : running ? 'pending' : 'skipped');
					const chip = renderChip(row, call, status);
					this.bindPopover(
						chip,
						`call:${call.id}`,
						this.toolContent(() => ({
							toolCallId: call.id,
							name: call.name,
							args: call.args,
							status: stage.status(call.id) ?? status,
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
							this.agentRowOf(call, results.get(call.id), running),
							(id) => void this.openAgent(id),
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
		anchor.addEventListener('click', () => this.popover.toggle(anchor, content));
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
	private renderMarkdown(el: HTMLElement, text: string, component: Component = this) {
		el.addClass('librarian-markdown', 'markdown-rendered');
		return MarkdownRenderer.render(this.app, text, el, '', component).then(() => {
			linkSources(
				el,
				(ref) =>
					void openSource(this.app, ref, (p, l) => this.controller.findReadLine(p, l)),
				(path) => this.app.vault.getFileByPath(path) !== null,
			);
		});
	}

	private renderStoredError(message: string, el = this.messagesEl) {
		const block = el.createDiv({ cls: 'librarian-error is-stored' });
		block.createDiv({ text: message });
	}

	/**
	 * A message on the right: the user's in the chat, the main agent's in the agent pane, which a
	 * caption above names. Only the chat's own messages rewind.
	 */
	private renderUser(
		index: number,
		event: Extract<SessionEvent, { type: 'user' }>,
		stage: Stage = this.mainStage(),
	) {
		if (stage.asker) stage.el.createDiv({ cls: 'librarian-msg-asker', text: stage.asker });
		const wrap = stage.el.createDiv({ cls: 'librarian-msg librarian-msg-user' });
		this.renderBubble(wrap, event.content, event.images ?? []);
		const rewind = stage.rewind;
		if (!rewind) return;
		const button = wrap.createEl('button', {
			cls: 'clickable-icon librarian-rewind',
			attr: { 'aria-label': 'Rewind to here' },
		});
		setIcon(button, 'undo-2');
		button.addEventListener('click', () => rewind(index));
	}

	/** A user message as the conversation shows it: the typed text, then its chips and images. */
	private renderBubble(wrap: HTMLElement, content: string, images: readonly string[]) {
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
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile)
					row.createEl('img', {
						attr: { src: this.app.vault.getResourcePath(file), alt: path },
					});
				else
					row.createSpan({
						cls: 'librarian-image-missing',
						text: `Image missing: ${path}`,
					});
			}
		}
	}

	private queueStream(message: AssistantMessage | null) {
		if (message === null) {
			// The response ended. What it showed stays until the conversation is drawn again with
			// it saved, so nothing blinks out while it is written to the session; one asked again
			// clears it when it starts (renderStream).
			if (this.streamTimer !== null) {
				window.clearTimeout(this.streamTimer);
				this.streamTimer = null;
				if (this.pendingStream) this.renderStream(this.pendingStream);
			}
			this.pendingStream = null;
			return;
		}
		this.pendingStream = message;
		if (this.streamTimer !== null) return;
		this.streamTimer = window.setTimeout(() => {
			this.streamTimer = null;
			if (this.pendingStream) this.renderStream(this.pendingStream);
		}, 120);
	}

	/**
	 * Where text on its way goes, drawn as Markdown all along with only the new words fading in: a
	 * message chip at the end of the timeline that eases to each new size, or the answer's place
	 * under the block, where it stays once saved.
	 */
	private streamText(live: Live, answer: boolean, follow: () => void): NonNullable<Live['text']> {
		const draw = (markdown: string, into: HTMLElement) =>
			this.renderMarkdown(into, markdown, new Component());
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
	 * (streamText). `agent` is a sub-agent's response in the agent pane, whose calls its own state
	 * knows.
	 */
	private renderStream(message: AssistantMessage, agent?: SubagentState) {
		const live = agent ? this.agentLive : this.live;
		if (!live) return;
		// Read again when a popover draws: the run may have been drawn anew since.
		const current = () => (agent ? this.agentLive : this.live);
		const statusOf = (id: string) =>
			agent ? agent.toolStatus.get(id) : this.controller.toolStatusOf(id);
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
			live.text = this.streamText(live, answer, () => {
				if (!agent) this.scrollToBottom();
				else if (this.followAgentBottom) this.scrollAgentToBottom();
			});
		}
		live.text?.markdown.set(text);
		const calls = message.content.filter((c) => c.type === 'toolCall');
		live.calls = calls.map((c) => ({ id: c.id, name: c.name, args: c.arguments }));
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
			if (existing && existing.hasClass('librarian-agent-row') === isAgent) {
				if (isAgent) {
					existing.dataset.agentCallId = block.id;
					updateAgentRow(
						existing,
						this.agentRowOf(
							{ id: block.id, name: block.name, args: block.arguments },
							undefined,
							true,
						),
					);
					return;
				}
				existing.dataset.toolCallId = block.id;
				const name = existing.querySelector('.librarian-chip-name');
				if (name && block.name) name.textContent = block.name;
				return;
			}
			// A chip whose name turned out to be spawn_agent becomes a row, as the log will show it.
			existing?.remove();
			if (isAgent) {
				const card =
					tools.querySelector<HTMLElement>('.librarian-agents') ??
					tools.createDiv({ cls: 'librarian-agents' });
				const row = renderAgentRow(
					card,
					this.agentRowOf(
						{ id: block.id, name: block.name, args: block.arguments },
						undefined,
						true,
					),
					(id) => void this.openAgent(id),
				);
				row.dataset.streamIndex = String(i);
				return;
			}
			const chip = renderChip(tools, { id: block.id, name: block.name }, status);
			chip.dataset.streamIndex = String(i);
			// Chips stay ahead of the agents' list, as they are drawn from the log.
			const card = tools.querySelector('.librarian-agents');
			if (card) tools.insertBefore(chip, card);
			this.bindPopover(
				chip,
				`call:${block.id || i}`,
				this.toolContent(() => {
					const now = current()?.calls[i] ?? {
						id: block.id,
						name: block.name,
						args: block.arguments,
					};
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
		const open = this.popover.openKey;
		if (
			open === 'thinking:live' ||
			(open?.startsWith('call:') &&
				live.tools?.querySelector(`[data-pop-key="${CSS.escape(open)}"]`))
		)
			this.popover.refresh();
		// The agent pane follows its own end once it has drawn (renderAgentPane).
		if (!agent) this.scrollToBottom();
	}

	private updateToolStatus(toolCallId: string, status: ToolCardStatus) {
		this.messagesEl
			.querySelectorAll<HTMLElement>(
				`.librarian-chip[data-tool-call-id="${CSS.escape(toolCallId)}"]`,
			)
			.forEach((chip) => {
				setChipStatus(chip, status);
			});
		// A spawn_agent call waiting for its approval, before its agent runs and reports itself.
		if (!this.controller.agents.has(toolCallId))
			this.messagesEl
				.querySelectorAll<HTMLElement>(
					`.librarian-agent-row[data-agent-call-id="${CSS.escape(toolCallId)}"]`,
				)
				.forEach((row) => {
					const call = this.controller.events
						.map((e) => e.event)
						.find((e) => e.type === 'tool_call' && e.toolCallId === toolCallId);
					if (call?.type !== 'tool_call') return;
					updateAgentRow(
						row,
						this.agentRowOf(
							{ id: toolCallId, name: call.name, args: call.args },
							undefined,
							true,
						),
					);
				});
		if (this.popover.openKey === `call:${toolCallId}`) this.popover.refresh();
	}

	private renderApproval(request: ApprovalRequest | null) {
		this.approvalEl?.remove();
		this.approvalEl = null;
		if (!request) return;
		const agentCall = request.agentCallId;
		// Wherever the user is looking: the chat, or the agent pane.
		this.approvalEl = renderApprovalCard(
			this.agentCall ? this.agentBodyEl : this.messagesEl,
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
		if (this.agentCall) this.scrollAgentToBottom();
		else this.scrollToBottom();
	}

	private scrollToBottom(force = false) {
		if (!force && !this.followBottom) return;
		this.followBottom = true;
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	// Context usage

	private renderUsage(usage: ContextUsage | null) {
		this.ringEl.className = `librarian-context-indicator is-${usage?.state ?? 'normal'}`;
		this.popoverEl.empty();
		if (!usage) {
			this.ringEl.setCssProps({ '--librarian-usage': '0%' });
			this.popoverEl.createDiv({ text: 'No model selected' });
			return;
		}
		const percent = Math.min(100, (usage.usedTokens / usage.maxTokens) * 100);
		this.ringEl.setCssProps({ '--librarian-usage': `${percent.toFixed(1)}%` });
		this.ringEl.setAttr('aria-label', `Context usage ${percent.toFixed(1)}%`);
		this.popoverEl.createDiv({ cls: 'librarian-popover-title', text: 'Context usage' });
		this.popoverEl.createDiv({
			text: `${formatTokens(usage.usedTokens)} / ${formatTokens(usage.maxTokens)} tokens`,
		});
		this.popoverEl.createDiv({ text: `${percent.toFixed(1)}% used` });
		const last = usage.lastResponse;
		const hit = cacheHitRatio(last);
		this.popoverEl.createDiv({
			text: `Cache hit: ${hit === null ? 'not reported' : `${(hit * 100).toFixed(1)}%`}`,
		});
		// The four counts the server reports for a response, as it reported them for the last one.
		for (const [label, n] of [
			['Input', last?.input],
			['Output', last?.output],
			['Cache read', last?.cacheRead],
			['Cache write', last?.cacheWrite],
		] as const) {
			const line = this.popoverEl.createDiv({ cls: 'librarian-popover-row' });
			line.createSpan({ text: label });
			line.createSpan({ text: n === undefined ? '-' : formatTokens(n) });
		}
		this.popoverEl.createDiv({
			cls: 'librarian-popover-detail',
			text:
				usage.usedTokens > 0
					? 'As reported by the server for the last response.'
					: 'Updates when the server reports the first response.',
		});
		if (usage.state !== 'normal') {
			this.popoverEl.createDiv({
				cls: 'librarian-popover-detail',
				text:
					usage.state === 'critical'
						? 'Compaction will run before the next request.'
						: 'Approaching the compaction threshold.',
			});
		}
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
				this.inputEl.value = [result.userText, this.inputEl.value.trim()]
					.filter(Boolean)
					.join('\n\n');
				this.updateSendEnabled();
				this.inputEl.focus();
				if (result.unchanged.length) {
					const block = this.messagesEl.createDiv({ cls: 'librarian-error is-stored' });
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
			void this.app.workspace.openLinkText(target, '', 'tab');
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

	// Agent pane (LIB-FEAT-140)

	/**
	 * A sub-agent run's conversation, which takes the place of the chat's while it is open: a head
	 * with the way back, the run's title, its agent and its state, then the conversation as the
	 * chat draws its own, with the main agent's task on the right.
	 */
	private buildAgentPane(root: HTMLElement) {
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
		this.agentBodyEl = this.agentEl.createDiv({
			cls: 'librarian-messages librarian-agent-body',
		});
		this.agentBodyEl.addEventListener('scroll', () => {
			const el = this.agentBodyEl;
			this.followAgentBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
			this.popover.reposition();
		});
		this.watchLinks(this.agentBodyEl);
	}

	/** A sub-agent moved on: its rows on the timeline, the run head, and the pane if it shows it. */
	private onAgent(state: SubagentState) {
		const data = liveRow(state);
		this.messagesEl
			.querySelectorAll<HTMLElement>(
				`.librarian-agent-row[data-agent-call-id="${CSS.escape(state.callId)}"]`,
			)
			.forEach((row) => {
				updateAgentRow(row, data);
			});
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
		result: Extract<SessionEvent, { type: 'tool_result' }> | undefined,
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
	async openAgent(callId: string) {
		this.popover.close();
		if (this.historyMode) await this.toggleHistory();
		this.agentCall = callId;
		this.agentFolds = newFolds();
		this.agentStored = this.controller.agents.has(callId)
			? null
			: await this.storedAgent(callId);
		// A switch while the file was read won the race.
		if (this.agentCall !== callId) return;
		this.messagesEl.addClass('is-hidden');
		this.agentEl.removeClass('is-hidden');
		this.inputEl.setAttr('placeholder', 'Ask the main agent');
		this.followAgentBottom = true;
		// Drawn whole: a redraw while the file was read may have drawn the pane it left.
		this.agentDrawn = null;
		this.renderAgentPane();
		this.agentHeadEl.querySelector<HTMLElement>('.librarian-agent-back')?.focus();
	}

	/** Back to the chat's own conversation, drawn again if it changed meanwhile. */
	closeAgent(redraw = true) {
		if (!this.agentCall) return;
		this.agentCall = null;
		this.agentStored = null;
		this.agentLive = null;
		this.agentDrawn = null;
		if (this.agentTimer !== null) window.clearTimeout(this.agentTimer);
		this.agentTimer = null;
		this.popover.close();
		this.agentBodyEl.empty();
		this.agentEl.addClass('is-hidden');
		this.messagesEl.removeClass('is-hidden');
		this.inputEl.setAttr('placeholder', 'Ask a question');
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
		)?.event as Extract<SessionEvent, { type: 'tool_result' }> | undefined;
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
		const body = this.agentBodyEl;
		const scroll = body.scrollTop;
		// Drawn again only when its log, its state or a call's state moved. The response on its way
		// grows in place, as the chat's does: drawn anew each time it would restart the spinner's
		// turn and the open popover's entrance, and lose a selection (LIB-TEST-142).
		const drawn = `${events.length}:${running}:${[...(live?.toolStatus.values() ?? [])].join()}`;
		if (drawn !== this.agentDrawn) {
			this.agentDrawn = drawn;
			body.empty();
			this.agentLive = null;
			this.approvalEl = null;
			this.popFills = new Map();
			if (!events.length)
				body.createDiv({
					cls: 'librarian-sessions-empty',
					text: running ? 'Waiting for a slot.' : 'Its conversation was not saved.',
				});
			this.drawRuns(
				{
					el: body,
					running,
					status: (id) => live?.toolStatus.get(id),
					folds: this.agentFolds,
					asker: 'Main agent',
				},
				events,
			);
			if (live?.stream) this.renderStream(live.stream, live);
			if (this.controller.pendingApproval)
				this.renderApproval(this.controller.pendingApproval);
			this.popover.reopen(
				(key) =>
					this.popFills.get(key) ??
					(key === 'thinking:live' ? this.lastThinking() : null),
			);
		} else if (live?.stream) this.renderStream(live.stream, live);
		if (this.followAgentBottom) this.scrollAgentToBottom();
		else body.scrollTop = scroll;
	}

	private scrollAgentToBottom() {
		this.followAgentBottom = true;
		this.agentBodyEl.scrollTop = this.agentBodyEl.scrollHeight;
	}

	// History

	async toggleHistory() {
		if (this.agentCall) this.closeAgent();
		this.historyMode = !this.historyMode;
		this.messagesEl.toggleClass('is-hidden', this.historyMode);
		this.sessionsEl.toggleClass('is-hidden', !this.historyMode);
		if (this.historyMode) await this.renderSessions();
	}

	private async renderSessions() {
		await renderSessionList(this.sessionsEl, this.plugin, (session) =>
			this.openSession(session.id),
		);
	}

	/** Opens a session picked from the history list or from the settings, leaving the history. */
	async openSession(id: string) {
		this.followBottom = true;
		await this.controller.openSession(id);
		if (this.historyMode) await this.toggleHistory();
		this.renderModelSelect();
	}

	/** Used by the "Add active note to prompt" command. */
	includeActiveNoteInPrompt() {
		if (!this.includeActiveNote) this.toggleActiveNote();
	}

	focusInput() {
		this.inputEl.focus();
	}
}
