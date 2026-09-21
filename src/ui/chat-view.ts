import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
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
	ToolCardStatus,
} from '../agent/agent-controller';
import type { ContextUsage } from '../context/context-manager';
import type LibrarianPlugin from '../main';
import { selectableThinkingLevels } from '../provider/provider-manager';
import { NO_STREAMING_NOTICE } from '../provider/transport';
import type { IndexedEvent, SessionEvent, SessionSummary } from '../session/session-types';
import type { ThinkingLevel } from '../types';
import {
	renderApprovalCard,
	renderToolCard,
	STATUS_LABELS,
	type ToolCardData,
	toolIcon,
} from './cards';
import { linkSources, openSource } from './sources';
import { appendStreamDelta } from './stream-text';

export const VIEW_TYPE_LIBRARIAN = 'librarian-chat';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

function formatTokens(n: number): string {
	return n.toLocaleString('en-US');
}

function compactTokens(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

class ConfirmModal extends Modal {
	constructor(
		app: LibrarianPlugin['app'],
		private readonly title: string,
		private readonly body: (el: HTMLElement) => void,
		private readonly confirmText: string,
		private readonly onConfirm: () => void | Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.title);
		this.body(this.contentEl);
		const row = this.contentEl.createDiv({ cls: 'librarian-modal-buttons' });
		const ok = row.createEl('button', { cls: 'mod-warning', text: this.confirmText });
		ok.addEventListener(
			'click',
			() =>
				void (async () => {
					this.close();
					await this.onConfirm();
				})(),
		);
		const cancel = row.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

class TextPromptModal extends Modal {
	constructor(
		app: LibrarianPlugin['app'],
		private readonly title: string,
		private readonly initial: string,
		private readonly onSubmit: (value: string) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.title);
		const input = this.contentEl.createEl('input', {
			type: 'text',
			cls: 'librarian-modal-input',
		});
		input.value = this.initial;
		const submit = async () => {
			const value = input.value.trim();
			this.close();
			if (value) await this.onSubmit(value);
		};
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') void submit();
		});
		const row = this.contentEl.createDiv({ cls: 'librarian-modal-buttons' });
		const ok = row.createEl('button', { cls: 'mod-cta', text: 'Save' });
		ok.addEventListener('click', () => void submit());
		input.focus();
		input.select();
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
	private readonly expanded = new Set<string>();

	private headerEl!: HTMLElement;
	private modelSelect!: HTMLSelectElement;
	private thinkingSelect!: HTMLSelectElement;
	private bannerEl!: HTMLElement;
	private noticeEl!: HTMLElement;
	private messagesEl!: HTMLElement;
	private sessionsEl!: HTMLElement;
	/** Auto-scroll follows new content only while the user is reading at the bottom. */
	private followBottom = true;
	private streamEl: HTMLElement | null = null;
	private streamParts: {
		thinking: HTMLElement;
		text: HTMLElement;
		tools: HTMLElement;
		shownThinking: string;
		shownText: string;
	} | null = null;
	private approvalEl: HTMLElement | null = null;
	private composerEl!: HTMLElement;
	private activeNoteEl!: HTMLElement;
	private imagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private imageButton!: HTMLButtonElement;
	private imageNoticeEl!: HTMLElement;
	private ringEl!: HTMLElement;
	private popoverEl!: HTMLElement;
	private pickModelEl!: HTMLElement;
	private activityEl!: HTMLElement;
	private fileInput!: HTMLInputElement;

	private historyMode = false;
	private includeActiveNote = false;
	private pendingImages: string[] = [];
	private popoverPinned = false;
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
		this.buildHeader(root);
		this.bannerEl = root.createDiv({ cls: 'librarian-key-banner is-hidden' });
		this.noticeEl = root.createDiv({ cls: 'librarian-notice is-hidden' });
		this.messagesEl = root.createDiv({ cls: 'librarian-messages' });
		this.messagesEl.addEventListener('scroll', () => {
			const el = this.messagesEl;
			this.followBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
		});
		this.sessionsEl = root.createDiv({ cls: 'librarian-sessions is-hidden' });
		this.buildComposer(root);
		this.unsubscribe = this.controller.subscribe((e) => this.onControllerEvent(e));
		this.registerDomEvent(document, 'click', (e) => {
			if (
				this.popoverPinned &&
				!this.popoverEl.contains(e.target as Node) &&
				e.target !== this.ringEl
			) {
				this.popoverPinned = false;
				this.popoverEl.addClass('is-hidden');
			}
		});
		this.registerEvent(this.app.workspace.on('file-open', () => this.renderActiveNote()));
		this.renderModelSelect();
		this.renderActiveNote();
		if (this.controller.session) this.renderEvents(this.controller.events);
		await this.controller.refreshReadiness();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.streamTimer !== null) window.clearTimeout(this.streamTimer);
	}

	// Header

	private buildHeader(root: HTMLElement) {
		this.headerEl = root.createDiv({ cls: 'librarian-header' });
		this.modelSelect = this.headerEl.createEl('select', {
			cls: 'dropdown librarian-model-select',
		});
		this.modelSelect.setAttr('aria-label', 'Model');
		this.modelSelect.addEventListener('change', () => {
			const [providerId, modelId] = this.modelSelect.value.split('\u0000');
			if (providerId && modelId)
				void this.controller
					.setModel(providerId, modelId)
					.then(() => this.renderModelSelect());
		});
		this.thinkingSelect = this.headerEl.createEl('select', {
			cls: 'dropdown librarian-thinking-select',
		});
		this.thinkingSelect.setAttr('aria-label', 'Thinking level');
		this.thinkingSelect.addEventListener('change', () => {
			void this.controller.setThinkingLevel(this.thinkingSelect.value as ThinkingLevel);
		});
		const actions = this.headerEl.createDiv({ cls: 'librarian-header-actions' });
		const newButton = actions.createEl('button', {
			cls: 'clickable-icon',
			attr: { 'aria-label': 'New session' },
		});
		setIcon(newButton, 'plus');
		newButton.addEventListener('click', () => void this.newSession());
		const historyButton = actions.createEl('button', {
			cls: 'clickable-icon',
			attr: { 'aria-label': 'Session history' },
		});
		setIcon(historyButton, 'history');
		historyButton.addEventListener('click', () => void this.toggleHistory());
	}

	renderModelSelect() {
		const options = this.plugin.providers.listSelectable();
		this.modelSelect.empty();
		const current = this.controller.selection;
		if (!current) {
			this.modelSelect.createEl('option', {
				value: '',
				text: options.length ? 'Pick a model' : 'No model configured',
			});
		}
		for (const { provider, model } of options) {
			const option = this.modelSelect.createEl('option', {
				value: `${provider.id}\u0000${model.id}`,
				text: `${provider.name} / ${model.name}`,
			});
			if (current && current.provider.id === provider.id && current.model.id === model.id)
				option.selected = true;
		}
		this.thinkingSelect.empty();
		const levels = current ? selectableThinkingLevels(current.model) : ['off' as ThinkingLevel];
		for (const level of levels) {
			const option = this.thinkingSelect.createEl('option', {
				value: level,
				text: `Thinking: ${level}`,
			});
			if (level === this.controller.thinkingLevel) option.selected = true;
		}
		this.thinkingSelect.toggleClass('is-hidden', levels.length <= 1);
		this.pickModelEl?.empty();
		if (this.pickModelEl) {
			this.pickModelEl.createSpan({ text: 'Pick a model to continue' });
			const select = this.pickModelEl.createEl('select', { cls: 'dropdown' });
			select.createEl('option', { value: '', text: 'Choose…' });
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
		this.activityEl = this.composerEl.createDiv({ cls: 'librarian-activity is-hidden' });
		this.activeNoteEl = this.composerEl.createDiv({ cls: 'librarian-active-note is-hidden' });
		this.imagesEl = this.composerEl.createDiv({ cls: 'librarian-images is-hidden' });
		this.imageNoticeEl = this.composerEl.createDiv({ cls: 'librarian-image-notice is-hidden' });
		this.inputEl = this.composerEl.createEl('textarea', {
			cls: 'librarian-input',
			attr: { placeholder: 'Ask a question...', rows: '3', 'aria-label': 'Message' },
		});
		this.inputEl.addEventListener('input', () => this.updateSendEnabled());
		this.inputEl.addEventListener('keydown', (e) => {
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
		const row = this.composerEl.createDiv({ cls: 'librarian-composer-row' });
		const addNote = row.createEl('button', {
			cls: 'librarian-composer-button',
			text: 'Add note',
		});
		addNote.setAttr('aria-label', 'Add active note to prompt');
		addNote.addEventListener('click', () => this.toggleActiveNote());
		this.imageButton = row.createEl('button', {
			cls: 'librarian-composer-button clickable-icon',
			attr: { 'aria-label': 'Attach image' },
		});
		setIcon(this.imageButton, 'image');
		this.imageButton.addEventListener('click', (e) => this.showImageMenu(e));
		this.fileInput = row.createEl('input', {
			type: 'file',
			cls: 'is-hidden',
			attr: { accept: 'image/*', multiple: 'true' },
		});
		this.fileInput.addEventListener('change', () => {
			for (const file of Array.from(this.fileInput.files ?? [])) void this.addImageFile(file);
			this.fileInput.value = '';
		});
		const spacer = row.createDiv({ cls: 'librarian-composer-spacer' });
		void spacer;
		this.ringEl = row.createEl('button', {
			cls: 'librarian-context-indicator',
			attr: { 'aria-label': 'Context usage', 'aria-haspopup': 'true' },
		});
		this.popoverEl = row.createDiv({ cls: 'librarian-context-popover is-hidden' });
		this.ringEl.addEventListener(
			'mouseenter',
			() => !Platform.isMobile && this.showPopover(true),
		);
		this.ringEl.addEventListener(
			'mouseleave',
			() => !Platform.isMobile && !this.popoverPinned && this.showPopover(false),
		);
		this.ringEl.addEventListener('focus', () => this.showPopover(true));
		this.ringEl.addEventListener('blur', () => !this.popoverPinned && this.showPopover(false));
		this.ringEl.addEventListener('click', (e) => {
			e.stopPropagation();
			this.popoverPinned = !this.popoverPinned;
			this.showPopover(this.popoverPinned);
		});
		this.sendButton = row.createEl('button', { cls: 'mod-cta librarian-send', text: 'Send' });
		this.sendButton.addEventListener('click', () => {
			if (this.controller.isRunning) this.controller.stop();
			else void this.submit();
		});
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

	private showImageMenu(e: MouseEvent) {
		if (!this.modelAcceptsImages()) {
			this.imageNoticeEl.setText(
				'This model does not accept images. Pick a model with image input.',
			);
			this.imageNoticeEl.removeClass('is-hidden');
			return;
		}
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('Choose a file')
				.setIcon('upload')
				.onClick(() => this.fileInput.click()),
		);
		menu.addItem((item) =>
			item
				.setTitle('Pick from vault')
				.setIcon('folder')
				.onClick(() =>
					new VaultImageModal(this.app, (f) => this.addImagePath(f.path)).open(),
				),
		);
		menu.showAtMouseEvent(e);
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
		const canSend =
			!running &&
			state !== 'no-key' &&
			state !== 'model-unavailable' &&
			state !== 'awaiting-approval' &&
			!blockedByImages &&
			(this.inputEl.value.trim().length > 0 || this.pendingImages.length > 0);
		this.sendButton.setText(running ? 'Stop' : 'Send');
		this.sendButton.toggleClass('mod-warning', running);
		this.sendButton.toggleClass('mod-cta', !running);
		this.sendButton.disabled = !running && !canSend;
		this.inputEl.disabled =
			state === 'no-key' || state === 'model-unavailable' || state === 'awaiting-approval';
		this.imageButton.disabled = !this.modelAcceptsImages();
		this.imageButton.toggleClass('is-disabled', !this.modelAcceptsImages());
	}

	async submit() {
		let text = this.inputEl.value.trim();
		if (!text && this.pendingImages.length === 0) return;
		this.followBottom = true;
		if (this.includeActiveNote) {
			const file = this.app.workspace.getActiveFile();
			if (file && file.extension === 'md') {
				const content = await this.app.vault.cachedRead(file);
				text = `${text}\n\n<attached_note path="${file.path}">\n${content}\n</attached_note>`;
			}
			this.includeActiveNote = false;
			this.renderActiveNote();
		}
		const images = [...this.pendingImages];
		this.pendingImages = [];
		this.inputEl.value = '';
		this.renderImages();
		this.hideNotice();
		if (this.historyMode) await this.toggleHistory();
		await this.controller.send(text, images);
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
				this.expanded.clear();
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
		}
	}

	private renderState(state: AgentController['state']) {
		this.bannerEl.toggleClass('is-hidden', state !== 'no-key');
		if (state === 'no-key') this.renderKeyBanner();
		this.pickModelEl.toggleClass('is-hidden', state !== 'model-unavailable');
		this.composerEl.toggleClass('is-hidden', state === 'model-unavailable');
		const provider = this.controller.selection?.provider;
		const nonStreaming = provider
			? this.plugin.transport.effectiveMode(provider) === 'requestUrl'
			: false;
		const activity =
			state === 'compacting'
				? 'Compacting context...'
				: state === 'requesting'
					? nonStreaming
						? NO_STREAMING_NOTICE
						: 'Waiting for the model...'
					: state === 'tool-running'
						? 'Running tools...'
						: state === 'awaiting-approval'
							? 'Waiting for your approval'
							: '';
		this.activityEl.toggleClass('is-hidden', !activity);
		this.activityEl.empty();
		if (activity) {
			this.activityEl.createSpan({ cls: 'librarian-spinner' });
			this.activityEl.createSpan({ text: ` ${activity}` });
		}
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

	private renderEvents(events: IndexedEvent[]) {
		const atBottom = this.followBottom;
		this.messagesEl.empty();
		this.streamEl = null;
		this.streamParts = null;
		this.approvalEl = null;
		const results = new Map<string, Extract<SessionEvent, { type: 'tool_result' }>>();
		for (const { event } of events)
			if (event.type === 'tool_result') results.set(event.toolCallId, event);
		for (const { index, event } of events) {
			switch (event.type) {
				case 'user':
					this.renderUser(index, event);
					break;
				case 'assistant':
					this.renderAssistant(event, results);
					break;
				case 'compaction':
					this.messagesEl.createDiv({
						cls: 'librarian-compaction',
						text: `Context compacted: ${compactTokens(event.tokensBefore)} -> ${compactTokens(event.tokensAfter)}`,
					});
					break;
				case 'error':
					this.renderStoredError(event.message);
					break;
				default:
					break;
			}
		}
		if (this.pendingStream) this.renderStream(this.pendingStream);
		if (this.controller.pendingApproval) this.renderApproval(this.controller.pendingApproval);
		if (atBottom) this.scrollToBottom(true);
	}

	private renderStoredError(message: string) {
		const block = this.messagesEl.createDiv({ cls: 'librarian-error is-stored' });
		block.createDiv({ text: message });
	}

	private renderUser(index: number, event: Extract<SessionEvent, { type: 'user' }>) {
		const wrap = this.messagesEl.createDiv({ cls: 'librarian-msg librarian-msg-user' });
		const bubble = wrap.createDiv({ cls: 'librarian-bubble' });
		const attached = event.content.match(/<attached_note path="([^"]+)">/);
		const shown = attached
			? event.content.replace(/\n*<attached_note[\s\S]*<\/attached_note>/, '')
			: event.content;
		bubble.createDiv({ cls: 'librarian-user-text', text: shown });
		if (attached) {
			const chip = bubble.createDiv({ cls: 'librarian-attached' });
			setIcon(chip.createSpan(), 'file-text');
			chip.createSpan({ text: ` ${attached[1]}` });
		}
		if (event.images?.length) {
			const row = bubble.createDiv({ cls: 'librarian-msg-images' });
			for (const path of event.images) {
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
		const rewind = wrap.createEl('button', {
			cls: 'clickable-icon librarian-rewind',
			attr: { 'aria-label': 'Rewind to here' },
		});
		setIcon(rewind, 'undo-2');
		rewind.addEventListener('click', () => this.confirmRewind(index));
	}

	private renderAssistant(
		event: Extract<SessionEvent, { type: 'assistant' }>,
		results: Map<string, Extract<SessionEvent, { type: 'tool_result' }>>,
	) {
		const wrap = this.messagesEl.createDiv({ cls: 'librarian-msg librarian-msg-assistant' });
		if (event.thinking) {
			const details = wrap.createEl('details', { cls: 'librarian-thinking' });
			details.createEl('summary', { text: 'Thinking' });
			details.createEl('pre', { text: event.thinking });
		}
		if (event.content) {
			const body = wrap.createDiv({ cls: 'librarian-markdown' });
			void MarkdownRenderer.render(this.app, event.content, body, '', this).then(() => {
				linkSources(
					body,
					(ref) =>
						void openSource(this.app, ref, (p, l) =>
							this.controller.findReadLine(p, l),
						),
					(path) => this.app.vault.getFileByPath(path) !== null,
				);
			});
		}
		for (const call of event.toolCalls) {
			const result = results.get(call.id);
			const status =
				this.controller.toolStatusOf(call.id) ??
				(result ? (result.ok ? 'ok' : 'failed') : 'pending');
			const data: ToolCardData = {
				toolCallId: call.id,
				name: call.name,
				args: call.args,
				status,
				result: result?.content ?? null,
				truncated: result?.truncated ?? false,
			};
			renderToolCard(wrap, data, this.expanded);
		}
	}

	private queueStream(message: AssistantMessage | null) {
		this.pendingStream = message;
		if (message === null) {
			if (this.streamTimer !== null) {
				window.clearTimeout(this.streamTimer);
				this.streamTimer = null;
			}
			this.streamEl?.remove();
			this.streamEl = null;
			this.streamParts = null;
			return;
		}
		if (this.streamTimer !== null) return;
		this.streamTimer = window.setTimeout(() => {
			this.streamTimer = null;
			if (this.pendingStream) this.renderStream(this.pendingStream);
		}, 120);
	}

	private renderStream(message: AssistantMessage) {
		if (!this.streamEl || !this.streamParts) {
			const el = this.messagesEl.createDiv({
				cls: 'librarian-msg librarian-msg-assistant is-streaming',
			});
			this.streamEl = el;
			const details = el.createEl('details', { cls: 'librarian-thinking is-hidden' });
			details.open = true;
			details.createEl('summary', { text: 'Thinking' });
			this.streamParts = {
				thinking: details.createEl('pre'),
				text: el.createDiv({ cls: 'librarian-markdown librarian-stream-text is-hidden' }),
				tools: el.createDiv(),
				shownThinking: '',
				shownText: '',
			};
		}
		// Already shown text stays in place; only the new tail is appended so it can animate in.
		const parts = this.streamParts;
		const thinking = message.content
			.filter((c) => c.type === 'thinking')
			.map((c) => (c as { thinking: string }).thinking)
			.join('');
		parts.thinking.parentElement?.toggleClass('is-hidden', !thinking);
		parts.shownThinking = appendStreamDelta(parts.thinking, parts.shownThinking, thinking);
		const text = message.content
			.filter((c) => c.type === 'text')
			.map((c) => (c as { text: string }).text)
			.join('');
		parts.text.toggleClass('is-hidden', !text);
		parts.shownText = appendStreamDelta(parts.text, parts.shownText, text);
		parts.tools.empty();
		for (const block of message.content) {
			if (block.type !== 'toolCall') continue;
			const status: ToolCardStatus = this.controller.toolStatusOf(block.id) ?? 'pending';
			const card = parts.tools.createDiv({ cls: `librarian-tool is-${status}` });
			const header = card.createDiv({ cls: 'librarian-tool-header' });
			setIcon(header.createSpan({ cls: 'librarian-tool-icon' }), toolIcon(block.name));
			header.createSpan({ cls: 'librarian-tool-name', text: block.name || '…' });
			header.createSpan({
				cls: 'librarian-tool-summary',
				text: JSON.stringify(block.arguments).slice(0, 80),
			});
			header.createSpan({ cls: 'librarian-tool-status', text: STATUS_LABELS[status] });
		}
		this.scrollToBottom();
	}

	private updateToolStatus(toolCallId: string, status: ToolCardStatus) {
		const card = this.messagesEl.querySelector<HTMLElement>(
			`.librarian-tool[data-tool-call-id="${toolCallId}"]`,
		);
		if (!card) return;
		card.className = `librarian-tool is-${status}`;
		const label = card.querySelector('.librarian-tool-status');
		if (label) label.textContent = STATUS_LABELS[status];
	}

	private renderApproval(request: ApprovalRequest | null) {
		this.approvalEl?.remove();
		this.approvalEl = null;
		if (!request) return;
		this.approvalEl = renderApprovalCard(
			this.messagesEl,
			request.name,
			request.args,
			request.existingLength,
			{
				approve: () => request.resolve('approve'),
				reject: () => request.resolve('reject'),
				always: () => request.resolve('always'),
			},
		);
		this.scrollToBottom();
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
		this.popoverEl.createDiv({
			cls: 'librarian-popover-detail',
			text: `Reserved output: ${formatTokens(usage.reservedOutputTokens)}`,
		});
		this.popoverEl.createDiv({
			cls: 'librarian-popover-detail',
			text: `Usable input: ${formatTokens(usage.availableInputTokens)}`,
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
				this.inputEl.value = result.userText;
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

	// History

	async toggleHistory() {
		this.historyMode = !this.historyMode;
		this.messagesEl.toggleClass('is-hidden', this.historyMode);
		this.sessionsEl.toggleClass('is-hidden', !this.historyMode);
		if (this.historyMode) await this.renderSessions();
	}

	private async renderSessions() {
		this.sessionsEl.empty();
		const sessions = await this.plugin.sessions.list();
		if (!sessions.length) {
			this.sessionsEl.createDiv({
				cls: 'librarian-sessions-empty',
				text: 'No sessions yet.',
			});
			return;
		}
		for (const session of sessions) this.renderSessionRow(session);
	}

	private renderSessionRow(session: SessionSummary) {
		const row = this.sessionsEl.createDiv({ cls: 'librarian-session-row' });
		if (this.controller.session?.id === session.id) row.addClass('is-current');
		const main = row.createDiv({ cls: 'librarian-session-main' });
		main.setAttr('role', 'button');
		main.setAttr('tabindex', '0');
		main.createDiv({ cls: 'librarian-session-title', text: session.title });
		const meta = main.createDiv({ cls: 'librarian-session-meta' });
		meta.createSpan({ text: `${session.providerId || '?'}/${session.modelId || '?'}` });
		meta.createSpan({ text: new Date(session.updatedAt).toLocaleString() });
		const open = async () => {
			this.followBottom = true;
			await this.controller.openSession(session.id);
			await this.toggleHistory();
			this.renderModelSelect();
		};
		main.addEventListener('click', () => void open());
		main.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') void open();
		});
		const actions = row.createDiv({ cls: 'librarian-session-actions' });
		const rename = actions.createEl('button', {
			cls: 'clickable-icon',
			attr: { 'aria-label': 'Rename' },
		});
		setIcon(rename, 'pencil');
		rename.addEventListener('click', () => {
			new TextPromptModal(this.app, 'Rename session', session.title, async (title) => {
				await this.plugin.sessions.rename(session.id, title);
				if (this.controller.session?.id === session.id)
					this.controller.session.title = title;
				await this.renderSessions();
			}).open();
		});
		const del = actions.createEl('button', {
			cls: 'clickable-icon',
			attr: { 'aria-label': 'Delete' },
		});
		setIcon(del, 'trash-2');
		del.addEventListener('click', () => {
			new ConfirmModal(
				this.app,
				'Delete this session?',
				(el) =>
					el.createEl('p', {
						text: `"${session.title}" and its snapshots will be deleted.`,
					}),
				'Delete',
				async () => {
					if (this.controller.session?.id === session.id)
						await this.controller.closeSession();
					await this.plugin.sessions.delete(session.id);
					await this.renderSessions();
				},
			).open();
		});
	}

	/** Used by the "Add active note to prompt" command. */
	includeActiveNoteInPrompt() {
		if (!this.includeActiveNote) this.toggleActiveNote();
	}

	focusInput() {
		this.inputEl.focus();
	}
}
