import { setIcon } from 'obsidian';
import type { ToolCardStatus } from '../agent/agent-controller';
import { isRootAgentsMd } from '../permissions/tool-permission-manager';

export const STATUS_LABELS: Record<ToolCardStatus, string> = {
	pending: 'Pending',
	'awaiting-approval': 'Waiting for approval',
	running: 'Running',
	ok: 'Done',
	failed: 'Failed',
	rejected: 'Rejected',
	blocked: 'Tool blocked by settings',
	expired: 'Approval expired',
};

const TOOL_ICONS: Record<string, string> = {
	ls: 'folder',
	find: 'file-search',
	grep: 'search',
	read: 'book-open',
	get_active_note: 'file-text',
	write: 'file-plus',
	edit: 'pencil',
	tool_search: 'search',
	webdav_ls: 'folder',
	webdav_read: 'book-open',
	webdav_write: 'file-plus',
	webdav_edit: 'pencil',
	webdav_mkdir: 'folder-plus',
	webdav_move: 'folder-input',
	webdav_delete: 'trash-2',
	webdav_download: 'download',
	webdav_upload: 'upload',
	bash: 'square-terminal',
};

export function toolIcon(name: string): string {
	return TOOL_ICONS[name] ?? 'wrench';
}

/** Storage tools whose arguments and results have the shape of a vault tool, shown the same way. */
const SHAPE_OF: Record<string, string> = {
	webdav_ls: 'ls',
	webdav_read: 'read',
	webdav_write: 'write',
	webdav_edit: 'edit',
};

function shapeOf(name: string): string {
	return SHAPE_OF[name] ?? name;
}

/** A write or edit that carries the new text, so the card can show what changes. */
function isChange(shape: string, args: Record<string, unknown>): boolean {
	if (shape === 'edit') return true;
	return shape === 'write' && typeof args.content === 'string';
}

function str(v: unknown): string {
	return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
}

/** Header values that are credentials: shown by their first four characters only. */
const SECRET_HEADER = /authorization|cookie|token|key|secret|password/i;

/** Arguments as the cards show them; request credentials are masked on screen. */
export function shownArgs(name: string, args: Record<string, unknown>): string {
	if (!args.headers || typeof args.headers !== 'object') return JSON.stringify(args, null, 2);
	const headers = Object.fromEntries(
		Object.entries(args.headers as Record<string, unknown>).map(([k, v]) => [
			k,
			SECRET_HEADER.test(k) && typeof v === 'string' && v.length > 4
				? `${v.slice(0, 4)}${'*'.repeat(8)}`
				: v,
		]),
	);
	return JSON.stringify({ ...args, headers }, null, 2);
}

function short(s: unknown, n = 60): string {
	const text = typeof s === 'string' ? s : JSON.stringify(s ?? '');
	return text.length > n ? `${text.slice(0, n)}…` : text;
}

/** One-line summary shown in the collapsed card header. */
export function summarizeCall(
	name: string,
	args: Record<string, unknown>,
	result: string | null,
): string {
	let parsed: Record<string, unknown> | null = null;
	if (result) {
		try {
			parsed = JSON.parse(result) as Record<string, unknown>;
		} catch {
			parsed = null;
		}
	}
	const count = (key: string) =>
		Array.isArray(parsed?.[key]) ? (parsed[key] as unknown[]).length : null;
	switch (shapeOf(name)) {
		case 'ls': {
			const n = parsed && typeof parsed.total === 'number' ? parsed.total : count('entries');
			return `${(args.path as string) || '/'}${n !== null ? `, ${n} entries` : ''}`;
		}
		case 'find': {
			const n = count('matches');
			return `${short(args.query)}${n !== null ? `, ${n} ${n === 1 ? 'match' : 'matches'}` : ''}`;
		}
		case 'grep': {
			const n = count('matches');
			return `${short(args.query)}${n !== null ? `, ${n} ${n === 1 ? 'match' : 'matches'}` : ''}`;
		}
		case 'read': {
			const offset = typeof args.offset === 'number' ? args.offset : 1;
			const lines = count('lines');
			const end = lines !== null ? offset + lines - 1 : null;
			return `${args.path as string}:${offset}${end !== null ? `-${end}` : ''}`;
		}
		case 'tool_search': {
			const n = count('matches');
			return `${short(args.query)}${n !== null ? `, ${n} ${n === 1 ? 'tool' : 'tools'}` : ''}`;
		}
		case 'get_active_note':
			return parsed && typeof parsed.path === 'string'
				? parsed.path
				: parsed
					? 'no active note'
					: '';
		case 'write':
			return `${args.path as string}${parsed?.operation ? ` (${parsed.operation as string})` : ''}`;
		case 'edit': {
			const n =
				parsed && typeof parsed.replacements === 'number' ? parsed.replacements : null;
			return `${args.path as string}${n !== null ? `, ${n} ${n === 1 ? 'replacement' : 'replacements'}` : ''}`;
		}
		case 'webdav_mkdir':
		case 'webdav_delete':
			return str(args.path) || '/';
		case 'webdav_move':
			return `${str(args.from)} to ${str(args.to)}`;
		case 'webdav_download':
		case 'webdav_upload': {
			const [from, to] =
				name === 'webdav_download'
					? [args.path, args.vault_path]
					: [args.vault_path, args.path];
			const n = count('files');
			return `${str(from) || '/'} to ${str(to) || '/'}${n !== null ? `, ${n} ${n === 1 ? 'file' : 'files'}` : ''}`;
		}
		case 'bash':
			return short(
				str(args.command)
					.split('\n')
					.find((l) => l.trim()) ?? '',
			);
		default:
			return short(args);
	}
}

export interface ToolCardData {
	toolCallId: string;
	name: string;
	args: Record<string, unknown>;
	status: ToolCardStatus;
	result: string | null;
	truncated: boolean;
	existingLength?: number;
}

/** Preview of a write, or before/after of an edit. Shared by the tool card and the approval card. */
export function renderChangePreview(
	el: HTMLElement,
	name: string,
	args: Record<string, unknown>,
	existingLength?: number,
) {
	if (name === 'write') {
		const path = str(args.path);
		const content = str(args.content);
		if (existingLength !== undefined || args.overwrite === true) {
			const warn = el.createDiv({ cls: 'librarian-change-warning' });
			setIcon(warn.createSpan(), 'alert-triangle');
			warn.createSpan({
				text: ` Replace entire note${existingLength !== undefined ? ` (${existingLength} to ${content.length} characters)` : ''}`,
			});
		} else {
			el.createDiv({ cls: 'librarian-change-title', text: `Create ${path}` });
		}
		const details = el.createEl('details', { cls: 'librarian-change-body' });
		details.open = content.length < 1500;
		details.createEl('summary', { text: `${content.length} characters` });
		details.createEl('pre', { text: content });
		return;
	}
	if (name === 'edit') {
		el.createDiv({ cls: 'librarian-change-title', text: str(args.path) });
		const diff = el.createDiv({ cls: 'librarian-diff' });
		const before = diff.createDiv({ cls: 'librarian-diff-before' });
		before.createDiv({ cls: 'librarian-diff-label', text: 'Before' });
		before.createEl('pre', { text: str(args.old_text) });
		const after = diff.createDiv({ cls: 'librarian-diff-after' });
		after.createDiv({ cls: 'librarian-diff-label', text: 'After' });
		after.createEl('pre', { text: str(args.new_text) });
		if (args.replace_all === true)
			diff.createDiv({ cls: 'librarian-diff-note', text: 'Replaces every occurrence.' });
	}
}

export function renderToolCard(
	container: HTMLElement,
	data: ToolCardData,
	expanded: Set<string>,
): HTMLElement {
	const card = container.createDiv({ cls: `librarian-tool is-${data.status}` });
	card.dataset.toolCallId = data.toolCallId;
	const header = card.createDiv({ cls: 'librarian-tool-header' });
	setIcon(header.createSpan({ cls: 'librarian-tool-icon' }), toolIcon(data.name));
	header.createSpan({ cls: 'librarian-tool-name', text: data.name });
	header.createSpan({
		cls: 'librarian-tool-summary',
		text: summarizeCall(data.name, data.args, data.result),
	});
	header.createSpan({ cls: 'librarian-tool-status', text: STATUS_LABELS[data.status] });
	const body = card.createDiv({ cls: 'librarian-tool-body' });
	const isOpen = expanded.has(data.toolCallId);
	body.toggleClass('is-hidden', !isOpen);
	header.setAttr('role', 'button');
	header.setAttr('tabindex', '0');
	header.setAttr('aria-expanded', String(isOpen));
	const toggle = () => {
		const open = body.hasClass('is-hidden');
		body.toggleClass('is-hidden', !open);
		header.setAttr('aria-expanded', String(open));
		if (open) expanded.add(data.toolCallId);
		else expanded.delete(data.toolCallId);
	};
	header.addEventListener('click', toggle);
	header.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			toggle();
		}
	});
	const shape = shapeOf(data.name);
	if (isChange(shape, data.args)) {
		renderChangePreview(body, shape, data.args, data.existingLength);
	} else if (data.name === 'bash') {
		body.createDiv({ cls: 'librarian-tool-label', text: 'Command' });
		body.createEl('pre', { text: str(data.args.command) });
	} else {
		body.createDiv({ cls: 'librarian-tool-label', text: 'Arguments' });
		body.createEl('pre', { text: shownArgs(data.name, data.args) });
	}
	if (data.result !== null) {
		body.createDiv({ cls: 'librarian-tool-label', text: 'Result' });
		body.createEl('pre', { text: data.result });
		if (data.truncated)
			body.createDiv({ cls: 'librarian-tool-note', text: 'The result was truncated.' });
	}
	return card;
}

export interface ApprovalCardHandlers {
	approve: () => void;
	reject: () => void;
	always: () => void;
}

export function renderApprovalCard(
	container: HTMLElement,
	name: string,
	args: Record<string, unknown>,
	existingLength: number | undefined,
	handlers: ApprovalCardHandlers,
	canAlways = true,
	alwaysKey = name,
	calledFrom?: string,
): HTMLElement {
	const card = container.createDiv({ cls: 'librarian-approval' });
	const title = card.createDiv({ cls: 'librarian-approval-title' });
	setIcon(title.createSpan(), toolIcon(name));
	title.createSpan({ text: ` Approve ${name}?` });
	if (calledFrom)
		card.createDiv({ cls: 'librarian-approval-note', text: `Called from ${calledFrom}` });
	const body = card.createDiv({ cls: 'librarian-approval-body' });
	const shape = shapeOf(name);
	if (isChange(shape, args)) renderChangePreview(body, shape, args, existingLength);
	else if (name === 'bash') body.createEl('pre', { text: str(args.command) });
	else body.createEl('pre', { text: shownArgs(name, args) });
	if (name === 'bash')
		body.createDiv({
			cls: 'librarian-approval-note',
			text: 'Obsidian commands this runs are not undone by rewind.',
		});
	const path = typeof args.path === 'string' ? args.path : '';
	const protectsAgentsMd = (name === 'write' || name === 'edit') && isRootAgentsMd(path);
	const buttons = card.createDiv({ cls: 'librarian-approval-buttons' });
	const approve = buttons.createEl('button', { cls: 'mod-cta', text: 'Approve' });
	approve.addEventListener('click', handlers.approve);
	const reject = buttons.createEl('button', { text: 'Reject' });
	reject.addEventListener('click', handlers.reject);
	if (protectsAgentsMd) {
		card.createDiv({
			cls: 'librarian-approval-note',
			text: 'Changes to the vault root AGENTS.md always ask first.',
		});
	} else if (!canAlways) {
		card.createDiv({
			cls: 'librarian-approval-note',
			text: 'The server marks this tool destructive, so it always asks first.',
		});
	} else {
		const always = buttons.createEl('button', { text: `Always allow ${alwaysKey}` });
		always.addEventListener('click', handlers.always);
	}
	approve.focus();
	return card;
}
