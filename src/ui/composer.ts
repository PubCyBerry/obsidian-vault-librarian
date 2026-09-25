import {
	type Component,
	FuzzySuggestModal,
	Menu,
	Modal,
	Notice,
	Platform,
	setIcon,
	TFile,
} from 'obsidian';
import type { AgentController, QueuedMessage } from '../agent/agent-controller';
import { type ContextUsage, cacheHitRatio } from '../context/context-manager';
import type LibrarianPlugin from '../main';
import { selectableThinkingLevels } from '../provider/provider-manager';
import { skillKey } from '../skills/skill-manager';
import { renderBubble } from './conversation-pane';
import {
	applyMention,
	composeUserMessage,
	draftOf,
	type MentionTarget,
	mentionLabel,
	mentionQuery,
	rankMentions,
} from './mentions';
import { segment, setChecked } from './segmented';
import { fillTemplate, matchCommands, parseSlash, type SlashCommand } from './slash-commands';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** One row of the list above the input: a slash command, a skill name or an @mention target. */
interface Suggestion {
	name: string;
	description: string;
	accept: (run: boolean) => void | Promise<void>;
}

function formatTokens(n: number): string {
	return n.toLocaleString('en-US');
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

/** What the composer asks of the view around it. */
export interface ComposerHost {
	/** Owns the DOM listeners the composer registers; the view. */
	component: Component;
	newSession(): Promise<void>;
	toggleHistory(): Promise<void>;
	compactNow(): Promise<void>;
	showNotice(message: string): void;
	/** A message just went to the controller: the chat follows its end and the history closes. */
	onSend(): Promise<void>;
}

/**
 * Everything under the conversation: the input with its slash commands, @mention chips and images,
 * the queue of messages waiting for the run (LIB-FEAT-184), the model button, the context ring and
 * the send button that turns into Stop.
 */
export class Composer {
	/** The composer itself, hidden while no model can be picked. */
	readonly el: HTMLElement;
	/** The block that asks for a model when the composer is hidden. */
	readonly pickModelEl: HTMLElement;
	private readonly app: LibrarianPlugin['app'];
	private readonly controller: AgentController;
	private readonly queueEl: HTMLElement;
	private suggestEl!: HTMLElement;
	private activeNoteEl!: HTMLElement;
	private mentionsEl!: HTMLElement;
	private imagesEl!: HTMLElement;
	private imageNoticeEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private attachButton!: HTMLButtonElement;
	private fileInput!: HTMLInputElement;
	private cameraInput!: HTMLInputElement;
	private modelButton!: HTMLButtonElement;
	private ringEl!: HTMLElement;
	private popoverEl!: HTMLElement;
	private sendButton!: HTMLButtonElement;
	/** The send slot shows Stop: a run is on and the composer is empty. */
	private stopMode = false;
	private includeActiveNote = false;
	private suggestions: Suggestion[] = [];
	private suggestIndex = 0;
	private pendingMentions: MentionTarget[] = [];
	private pendingImages: string[] = [];
	private keyboardLog = 'none yet';
	private animatingSince = 0;

	constructor(
		root: HTMLElement,
		private readonly plugin: LibrarianPlugin,
		private readonly host: ComposerHost,
	) {
		this.app = plugin.app;
		this.controller = plugin.controller;
		// Messages sent while the agent works, waiting above the composer (LIB-FEAT-184).
		this.queueEl = root.createDiv({ cls: 'librarian-queue is-hidden' });
		this.pickModelEl = root.createDiv({ cls: 'librarian-pick-model is-hidden' });
		this.el = root.createDiv({ cls: 'librarian-composer' });
		this.build();
		if (Platform.isMobile) this.rideWithKeyboard();
		this.renderModelSelect();
		this.renderActiveNote();
		this.renderQueue(this.controller.queue);
	}

	private build() {
		this.suggestEl = this.el.createDiv({ cls: 'librarian-slash is-hidden' });
		const box = this.el.createDiv({ cls: 'librarian-composer-box' });
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
	 * Phones and tablets alike: Obsidian keeps the app full height while the keyboard rises on
	 * both, so the composer has to ride up on its own there too (styles.css).
	 */
	private rideWithKeyboard() {
		const component = this.host.component;
		// Obsidian dispatches these on window from the native keyboard. What is recorded here is
		// only for the /layout command, which reports the mobile layout numbers.
		const k = () =>
			getComputedStyle(document.documentElement).getPropertyValue('--keyboard-height');
		component.registerDomEvent(window, 'keyboardWillShow' as keyof WindowEventMap, () => {
			this.keyboardLog = `show K=${k().trim()} at ${new Date().toLocaleTimeString()}`;
		});
		const safe = () =>
			getComputedStyle(document.documentElement)
				.getPropertyValue('--safe-area-inset-bottom')
				.trim();
		component.registerDomEvent(window, 'keyboardWillHide' as keyof WindowEventMap, () => {
			this.keyboardLog += `, hide K=${k().trim()} safe=${safe()}`;
		});
		// The padding measured while the keyboard is closed; the closing animation keeps it
		// (styles.css) so the composer does not drop behind the navbar and jump back.
		const rememberClosed = () => {
			if (parseFloat(k()) > 0 || document.body.hasClass('keyboard-animating')) return;
			this.el.style.setProperty(
				'--librarian-closed-padding',
				getComputedStyle(this.el).paddingBottom,
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
		component.register(() => observer.disconnect());
	}

	// What the view tells the composer

	/** The idle state moved: whether a message can be sent, and whether a model has to be picked first. */
	renderState(state: AgentController['state']): void {
		this.pickModelEl.toggleClass('is-hidden', state !== 'model-unavailable');
		this.el.toggleClass('is-hidden', state === 'model-unavailable');
		this.renderModelSelect();
		this.updateSendEnabled();
	}

	focus(): void {
		this.inputEl.focus();
	}

	setPlaceholder(text: string): void {
		this.inputEl.setAttr('placeholder', text);
	}

	/** Puts text ahead of what is in the input, such as the message a rewind handed back. */
	prependDraft(text: string): void {
		this.inputEl.value = [text, this.inputEl.value.trim()].filter(Boolean).join('\n\n');
		this.updateSendEnabled();
		this.inputEl.focus();
	}

	/** Refreshes the model button in the composer and the pick-a-model block. */
	renderModelSelect(): void {
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
		this.pickModelEl.empty();
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

	/** Messages waiting for the run, each with Send now on its left (LIB-FEAT-184, LIB-FEAT-185). */
	renderQueue(queue: readonly QueuedMessage[]): void {
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
			renderBubble(this.app, row, item.text, item.images);
		}
		this.queueEl.scrollTop = this.queueEl.scrollHeight;
	}

	/** Messages the run did not send go back into the composer, ahead of what is there already. */
	restoreUnsent(messages: QueuedMessage[]): void {
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

	// Context usage

	renderUsage(usage: ContextUsage | null): void {
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

	private showPopover(show: boolean) {
		this.popoverEl.toggleClass('is-hidden', !show);
	}

	// Attachments

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

	/** The active note as the composer shows it; called again when another note opens. */
	renderActiveNote(): void {
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

	toggleActiveNote(): void {
		const file = this.app.workspace.getActiveFile();
		if (!this.includeActiveNote && file?.extension !== 'md') {
			new Notice('Open a Markdown note first.');
			return;
		}
		this.includeActiveNote = !this.includeActiveNote;
		this.renderActiveNote();
		void this.controller.recalculateUsage();
	}

	/** Used by the "Add active note to prompt" command. */
	includeActiveNoteInPrompt(): void {
		if (!this.includeActiveNote) this.toggleActiveNote();
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

	updateSendEnabled(): void {
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

	// Sending

	async submit(): Promise<void> {
		const typed = this.inputEl.value.trim();
		if (!typed && this.pendingImages.length === 0) return;
		const slash = parseSlash(typed);
		if (slash && this.pendingImages.length === 0) {
			const command = this.slashCommands().find((c) => c.name === slash.name);
			if (!command) {
				this.host.showNotice(`Unknown command: /${slash.name}`);
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

	/** Sends a message: the attached note, the mention chips, then any `@path` notes the text refers to. */
	private async sendText(typed: string, from = '') {
		const active = this.app.workspace.getActiveFile();
		const text = await composeUserMessage(this.app, typed, {
			activeNote: this.includeActiveNote && active?.extension === 'md' ? active : null,
			mentions: this.pendingMentions,
			from,
		});
		this.includeActiveNote = false;
		this.renderActiveNote();
		this.pendingMentions = [];
		this.renderMentions();
		const images = [...this.pendingImages];
		this.pendingImages = [];
		this.inputEl.value = '';
		this.closeSuggestions();
		// Started before the redraw so the button morphs from Send to Stop instead of leaving.
		const sending = this.controller.send(text, images);
		this.renderImages();
		await this.host.onSend();
		await sending;
	}

	// Slash commands and suggestions

	/** Built-in actions plus one command per note in the commands folder. */
	private slashCommands(): SlashCommand[] {
		const builtIn: SlashCommand[] = [
			{ name: 'new', description: 'Start a new session', run: () => this.host.newSession() },
			{
				name: 'settings',
				description: 'Open the Librarian settings',
				run: () => this.plugin.openSettings(),
			},
			{
				name: 'history',
				description: 'Open session history',
				run: () => this.host.toggleHistory(),
			},
			{
				name: 'compact',
				description: 'Compact the context now',
				run: () => this.host.compactNow(),
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
						return this.host.showNotice('No model matches. Try /model <name>.');
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
						return this.host.showNotice(
							`Thinking levels: ${levels.join(', ') || 'off'}`,
						);
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
						return this.host.showNotice(
							skills.map((s) => `${s.name}: ${s.description}`).join('\n') ||
								'No skills found.',
						);
					const skill = this.plugin.skills.get(name);
					if (!skill) return this.host.showNotice(`Unknown skill: ${name}`);
					if (this.plugin.permissions.get(skillKey(skill.name)) === 'blocked')
						return this.host.showNotice(
							`Skill "${skill.name}" is blocked in Settings.`,
						);
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
						`view-bottom-spacing ${css(this.el, '--view-bottom-spacing')}, composer padding-bottom ${css(this.el, 'padding-bottom')}`,
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
					this.host.showNotice(
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
}
