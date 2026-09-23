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
import { vaultReferenceReader } from '../agent/prompt';
import { expandReferences } from '../agent/references';
import type { ContextUsage } from '../context/context-manager';
import type LibrarianPlugin from '../main';
import { selectableThinkingLevels } from '../provider/provider-manager';
import { NO_STREAMING_NOTICE } from '../provider/transport';
import type {
	IndexedEvent,
	SessionEvent,
	SessionMetadata,
	SessionSummary,
} from '../session/session-types';
import { skillKey } from '../skills/skill-manager';
import { isBinaryPath } from '../tools/path-policy';
import {
	renderApprovalCard,
	renderToolCard,
	STATUS_LABELS,
	type ToolCardData,
	toolIcon,
} from './cards';
import {
	applyMention,
	folderBlock,
	type MentionTarget,
	mentionLabel,
	mentionQuery,
	rankMentions,
} from './mentions';
import { fillTemplate, matchCommands, parseSlash, type SlashCommand } from './slash-commands';
import { linkSources, openSource } from './sources';
import { appendStreamDelta } from './stream-text';

export const VIEW_TYPE_LIBRARIAN = 'librarian-chat';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** Blocks the composer appends below the typed text; the bubble shows each as a chip instead. */
const ATTACHED_BLOCK =
	/\n*<(attached_note|attached_file|attached_folder|skill_content) (?:path|name)="([^"]+)"(?: \/>|>[\s\S]*?<\/\1>)/g;
const CHIP_ICONS: Record<string, string> = {
	attached_note: 'file-text',
	attached_file: 'file',
	attached_folder: 'folder',
	skill_content: 'sparkles',
};

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
				const b = seg.createEl('button', { text: level, attr: { role: 'radio' } });
				b.toggleClass('is-active', level === this.controller.thinkingLevel);
				b.setAttr('aria-checked', String(level === this.controller.thinkingLevel));
				b.addEventListener(
					'click',
					() =>
						void this.controller.setThinkingLevel(level).then(() => {
							this.onChange();
							this.render();
						}),
				);
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
	private readonly expanded = new Set<string>();

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
	private imageNoticeEl!: HTMLElement;
	private ringEl!: HTMLElement;
	private popoverEl!: HTMLElement;
	private pickModelEl!: HTMLElement;
	private activityEl!: HTMLElement;
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
		this.messagesEl.addEventListener('scroll', () => {
			const el = this.messagesEl;
			this.followBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
		});
		this.sessionsEl = root.createDiv({ cls: 'librarian-sessions is-hidden' });
		this.buildComposer(root);
		this.unsubscribe = this.controller.subscribe((e) => this.onControllerEvent(e));
		this.unsubscribeMcp = this.plugin.mcp.subscribe(() => this.renderMcpBanner());
		this.renderMcpBanner();
		this.registerEvent(this.app.workspace.on('file-open', () => this.renderActiveNote()));
		if (Platform.isPhone) {
			// Obsidian dispatches these on window from the native keyboard. What is recorded here
			// is only for the /layout command, which reports the phone layout numbers.
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
			requestAnimationFrame(rememberClosed);
			const observer = new MutationObserver(() => {
				const on = document.body.hasClass('keyboard-animating');
				if (on && !this.animatingSince) this.animatingSince = Date.now();
				if (!on && this.animatingSince) {
					this.keyboardLog += `, animating ${Date.now() - this.animatingSince} ms, safe after=${safe()}`;
					this.animatingSince = 0;
					requestAnimationFrame(rememberClosed);
				}
			});
			observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
			this.register(() => observer.disconnect());
		}
		this.renderModelSelect();
		this.renderActiveNote();
		if (this.controller.session) this.renderEvents(this.controller.events);
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

	/** Asks, then deletes the session and its snapshots; closes it first when it is the open one. */
	private confirmDelete(session: SessionMetadata) {
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
				if (this.historyMode) await this.renderSessions();
			},
		).open();
	}

	private async compactNow() {
		if (!this.controller.session) return this.showNotice('Open a session first.');
		const done = await this.controller.compactNow();
		this.showNotice(done ? 'Context compacted.' : 'Nothing to compact yet.');
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
		// Appears only when there is something to send; becomes Stop while the agent runs.
		this.sendButton = row.createEl('button', {
			cls: 'librarian-send is-hidden',
			attr: { 'aria-label': 'Send' },
		});
		setIcon(this.sendButton, 'arrow-up');
		this.sendButton.addEventListener('click', () => {
			if (this.controller.isRunning) this.controller.stop();
			else void this.submit();
		});
	}

	/** The "+" menu: images from the camera, the device or the vault, and the active note. */
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
		const canSend =
			!running &&
			state !== 'no-key' &&
			state !== 'model-unavailable' &&
			state !== 'awaiting-approval' &&
			!blockedByImages &&
			(this.inputEl.value.trim().length > 0 || this.pendingImages.length > 0);
		const show = running || canSend;
		this.sendButton.toggleClass('is-hidden', !show);
		this.sendButton.toggleClass('is-running', running);
		this.sendButton.empty();
		setIcon(this.sendButton, running ? 'square' : 'arrow-up');
		this.sendButton.setAttr('aria-label', running ? 'Stop' : 'Send');
		this.inputEl.disabled =
			state === 'no-key' || state === 'model-unavailable' || state === 'awaiting-approval';
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
				name: 'history',
				description: 'Open session history',
				run: () => this.toggleHistory(),
			},
			{
				name: 'compact',
				description: 'Compact the context now',
				run: async () => {
					if (!this.controller.session) return this.showNotice('Open a session first.');
					const done = await this.controller.compactNow();
					this.showNotice(done ? 'Context compacted.' : 'Nothing to compact yet.');
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
		this.renderModelSelect();
		this.composerEl.toggleClass('is-hidden', state === 'model-unavailable');
		const provider = this.controller.selection?.provider;
		const nonStreaming = provider
			? this.plugin.transport.effectiveMode(provider) === 'requestUrl'
			: false;
		const activity =
			state === 'compacting'
				? 'Compacting context'
				: state === 'requesting'
					? nonStreaming
						? NO_STREAMING_NOTICE
						: 'Waiting for the model'
					: state === 'tool-running'
						? 'Running tools'
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

	/** One line per enabled MCP server that is waiting for a sign-in or an API key. */
	private renderMcpBanner() {
		const waiting = this.plugin.mcp.needingSignIn();
		this.mcpBannerEl.toggleClass('is-hidden', waiting.length === 0);
		this.mcpBannerEl.empty();
		for (const server of waiting) {
			const row = this.mcpBannerEl.createDiv({ cls: 'librarian-key-banner-row' });
			row.createSpan({ text: `Sign in to "${server.name}" to use its tools.` });
			const button = row.createEl('button', {
				cls: 'mod-cta',
				text: server.auth === 'apiKey' ? 'Open settings' : 'Sign in',
			});
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
						text: `Context compacted: ${compactTokens(event.tokensBefore)} to ${compactTokens(event.tokensAfter)}`,
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
		const chips: { tag: string; id: string }[] = [];
		const shown = event.content.replace(ATTACHED_BLOCK, (_m, tag: string, id: string) => {
			chips.push({ tag, id });
			return '';
		});
		bubble.createDiv({ cls: 'librarian-user-text', text: shown });
		for (const { tag, id } of chips) {
			const chip = bubble.createDiv({ cls: 'librarian-attached' });
			setIcon(chip.createSpan(), CHIP_ICONS[tag] ?? 'file-text');
			chip.createSpan({ text: ` ${id}` });
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
			const body = wrap.createDiv({ cls: 'librarian-markdown markdown-rendered' });
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
			request.canAlways,
			request.permissionKey,
			request.calledFrom,
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
			text: `Cache hit: ${usage.cacheHitRatio === null ? 'not reported' : `${(usage.cacheHitRatio * 100).toFixed(1)}%`}`,
		});
		this.popoverEl.createDiv({
			cls: 'librarian-popover-detail',
			text:
				usage.usedTokens > 0
					? 'As reported by the server for the last response.'
					: 'Updates when the server reports the first response.',
		});
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
		del.addEventListener('click', () => this.confirmDelete(session));
	}

	/** Used by the "Add active note to prompt" command. */
	includeActiveNoteInPrompt() {
		if (!this.includeActiveNote) this.toggleActiveNote();
	}

	focusInput() {
		this.inputEl.focus();
	}
}
