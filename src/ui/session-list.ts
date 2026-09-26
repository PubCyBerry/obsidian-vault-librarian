import { Modal, setIcon } from 'obsidian';
import type { SessionActivity, SessionEntry } from '../agent/session-hub';
import type LibrarianPlugin from '../main';
import type { SessionMetadata } from '../session/session-types';
import { renderSpinner } from './work-log';

/** How a session in the Active group is said to a screen reader (LIB-FEAT-275). */
export const ACTIVITY_LABELS: Record<SessionActivity, string> = {
	running: 'Running',
	asking: 'Waiting for your approval',
	unread: 'Finished',
	failed: 'Failed',
};

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

/** Asks, then deletes the session and its snapshots; a run in it stops first (LIB-FEAT-275). */
export function confirmDeleteSession(
	plugin: LibrarianPlugin,
	session: SessionMetadata,
	after: () => void | Promise<void>,
): void {
	const running = plugin.hub.find(session.id)?.isRunning ?? false;
	new ConfirmModal(
		plugin.app,
		'Delete this session?',
		(el) =>
			el.createEl('p', {
				text: `"${session.title}" and its snapshots will be deleted.${running ? ' It is running and stops first.' : ''}`,
			}),
		'Delete',
		async () => {
			// A chat showing it is left on an empty session.
			await plugin.hub.remove(session.id);
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
		const shown = plugin.hub.find(session.id)?.session;
		if (shown) shown.title = title;
		// The chats' heads say the new name.
		plugin.hub.refresh();
		await after();
	}).open();
}

export interface SessionListOptions {
	/** The session the chat shows, drawn in the accent color. */
	current?: string | null;
	/** Sessions that run, ask or ended unseen, drawn on top in the Active group (LIB-FEAT-275). */
	active?: SessionEntry[];
	/** Stops a running session from its row. */
	stop?: (entry: SessionEntry) => void;
}

/**
 * The sessions that need a look: a mark of their state, the title, what they do or how they
 * ended, and Stop while they run. A row opens its session without stopping any (LIB-FEAT-275).
 */
export function renderActiveRows(
	el: HTMLElement,
	entries: readonly SessionEntry[],
	open: (id: string) => void | Promise<void>,
	stop?: (entry: SessionEntry) => void,
): void {
	el.empty();
	for (const entry of entries) {
		const row = el.createDiv({ cls: `librarian-session-row is-active is-${entry.activity}` });
		const mark = row.createSpan({ cls: `librarian-session-mark is-${entry.activity}` });
		if (entry.activity === 'running') renderSpinner(mark);
		else if (entry.activity === 'asking') setIcon(mark, 'hand');
		else if (entry.activity === 'failed') setIcon(mark, 'x');
		const main = row.createDiv({
			cls: 'librarian-session-main',
			attr: {
				role: 'button',
				tabindex: '0',
				'aria-label': `${entry.title}: ${ACTIVITY_LABELS[entry.activity]}. ${entry.line}`,
			},
		});
		main.createDiv({ cls: 'librarian-session-title', text: entry.title });
		main.createDiv({ cls: 'librarian-session-activity', text: entry.line });
		main.addEventListener('click', () => void open(entry.sessionId));
		main.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') void open(entry.sessionId);
		});
		if (
			!stop ||
			!entry.runtime ||
			(entry.activity !== 'running' && entry.activity !== 'asking')
		)
			continue;
		const runtime = entry.runtime;
		const button = row.createDiv({ cls: 'librarian-session-actions' }).createEl('button', {
			cls: 'clickable-icon librarian-session-stop',
			attr: { 'aria-label': 'Stop this session' },
		});
		setIcon(button, 'circle-stop');
		button.addEventListener('click', () => stop({ ...entry, runtime }));
	}
}

/**
 * Past conversations, newest first, after the Active group when there is one. A row opens its
 * session; the pencil renames it and the bin deletes it. The chat's session list uses it.
 */
export async function renderSessionList(
	el: HTMLElement,
	plugin: LibrarianPlugin,
	open: (id: string) => void | Promise<void>,
	opts: SessionListOptions = {},
): Promise<void> {
	el.empty();
	const active = opts.active ?? [];
	if (active.length) {
		el.createDiv({ cls: 'librarian-sessions-group', text: 'Active' });
		renderActiveRows(
			el.createDiv({ cls: 'librarian-sessions-active' }),
			active,
			open,
			opts.stop,
		);
		el.createDiv({ cls: 'librarian-sessions-group', text: 'Recent' });
	}
	const inActive = new Set(active.map((e) => e.sessionId));
	// A sub-agent's session opens from the conversation that started it, not from here.
	const sessions = (await plugin.sessions.list()).filter(
		(s) => !s.parentId && !inActive.has(s.id),
	);
	if (!sessions.length) {
		if (!active.length)
			el.createDiv({ cls: 'librarian-sessions-empty', text: 'No sessions yet.' });
		return;
	}
	const redraw = () => renderSessionList(el, plugin, open, opts);
	for (const session of sessions) {
		const row = el.createDiv({ cls: 'librarian-session-row' });
		if (opts.current === session.id) row.addClass('is-current');
		const main = row.createDiv({ cls: 'librarian-session-main' });
		main.setAttr('role', 'button');
		main.setAttr('tabindex', '0');
		main.createDiv({ cls: 'librarian-session-title', text: session.title });
		const meta = main.createDiv({ cls: 'librarian-session-meta' });
		meta.createSpan({ text: `${session.providerId || '?'}/${session.modelId || '?'}` });
		meta.createSpan({ text: new Date(session.updatedAt).toLocaleString() });
		main.addEventListener('click', () => void open(session.id));
		main.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') void open(session.id);
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
