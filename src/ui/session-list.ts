import { Modal, setIcon } from 'obsidian';
import type LibrarianPlugin from '../main';
import type { SessionMetadata } from '../session/session-types';

/**
 * Obsidian's own button row for a modal, with Cancel in it. The caller adds the main button
 * after it: it sits rightmost on desktop and topmost on a phone, where the row stacks.
 */
export function modalButtons(el: HTMLElement, cancel: () => void): HTMLElement {
	const row = el.createDiv({ cls: 'modal-button-container' });
	row.createEl('button', { cls: 'mod-cancel', text: 'Cancel' }).addEventListener('click', cancel);
	return row;
}

export class ConfirmModal extends Modal {
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
		const row = modalButtons(this.contentEl, () => this.close());
		const ok = row.createEl('button', { cls: 'mod-warning', text: this.confirmText });
		ok.addEventListener(
			'click',
			() =>
				void (async () => {
					this.close();
					await this.onConfirm();
				})(),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class TextPromptModal extends Modal {
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
		const row = modalButtons(this.contentEl, () => this.close());
		const ok = row.createEl('button', { cls: 'mod-cta', text: 'Save' });
		ok.addEventListener('click', () => void submit());
		input.focus();
		input.select();
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Asks, then deletes the session and its snapshots; closes it first when it is the open one. */
export function confirmDeleteSession(
	plugin: LibrarianPlugin,
	session: SessionMetadata,
	after: () => void | Promise<void>,
): void {
	new ConfirmModal(
		plugin.app,
		'Delete this session?',
		(el) => el.createEl('p', { text: `"${session.title}" and its snapshots will be deleted.` }),
		'Delete',
		async () => {
			if (plugin.controller.session?.id === session.id)
				await plugin.controller.closeSession();
			await plugin.sessions.delete(session.id);
			await after();
		},
	).open();
}

export function renameSession(
	plugin: LibrarianPlugin,
	session: SessionMetadata,
	after: () => void | Promise<void>,
): void {
	new TextPromptModal(plugin.app, 'Rename session', session.title, async (title) => {
		await plugin.sessions.rename(session.id, title);
		if (plugin.controller.session?.id === session.id) plugin.controller.session.title = title;
		await after();
	}).open();
}

/**
 * Past conversations, newest first. A row opens its session; the pencil renames it and the bin
 * deletes it. Used by the chat's history view and by the Sessions page in the settings.
 */
export async function renderSessionList(
	el: HTMLElement,
	plugin: LibrarianPlugin,
	open: (session: SessionMetadata) => void | Promise<void>,
): Promise<void> {
	el.empty();
	const sessions = await plugin.sessions.list();
	if (!sessions.length) {
		el.createDiv({ cls: 'librarian-sessions-empty', text: 'No sessions yet.' });
		return;
	}
	const redraw = () => renderSessionList(el, plugin, open);
	for (const session of sessions) {
		const row = el.createDiv({ cls: 'librarian-session-row' });
		if (plugin.controller.session?.id === session.id) row.addClass('is-current');
		const main = row.createDiv({ cls: 'librarian-session-main' });
		main.setAttr('role', 'button');
		main.setAttr('tabindex', '0');
		main.createDiv({ cls: 'librarian-session-title', text: session.title });
		const meta = main.createDiv({ cls: 'librarian-session-meta' });
		meta.createSpan({ text: `${session.providerId || '?'}/${session.modelId || '?'}` });
		meta.createSpan({ text: new Date(session.updatedAt).toLocaleString() });
		main.addEventListener('click', () => void open(session));
		main.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') void open(session);
		});
		const actions = row.createDiv({ cls: 'librarian-session-actions' });
		const rename = actions.createEl('button', {
			cls: 'clickable-icon',
			attr: { 'aria-label': 'Rename' },
		});
		setIcon(rename, 'pencil');
		rename.addEventListener('click', () => renameSession(plugin, session, redraw));
		const del = actions.createEl('button', {
			cls: 'clickable-icon',
			attr: { 'aria-label': 'Delete' },
		});
		setIcon(del, 'trash-2');
		del.addEventListener('click', () => confirmDeleteSession(plugin, session, redraw));
	}
}
