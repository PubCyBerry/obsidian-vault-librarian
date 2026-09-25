import { setIcon } from 'obsidian';
import type { ToolCardStatus } from '../agent/agent-controller';
import { alwaysAsksFor } from '../permissions/tool-permission-manager';

export const STATUS_LABELS: Record<ToolCardStatus, string> = {
	pending: 'Pending',
	'awaiting-approval': 'Waiting for approval',
	running: 'Running',
	ok: 'Done',
	failed: 'Failed',
	rejected: 'Rejected',
	blocked: 'Tool blocked by settings',
	expired: 'Approval expired',
	skipped: 'Skipped',
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
	skill_search: 'sparkles',
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
		case 'tool_search':
		case 'skill_search': {
			const n = count('matches');
			const noun = name === 'tool_search' ? 'tool' : 'skill';
			return `${short(args.query)}${n !== null ? `, ${n} ${noun}${n === 1 ? '' : 's'}` : ''}`;
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

/**
 * A result as a person reads it, for the popover (LIB-FEAT-252): the lines read returned with
 * their numbers, the lines grep found after their paths, the paths find and ls listed, and any
 * other JSON indented. The model still gets the result as it was.
 */
export function readableResult(name: string, result: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(result);
	} catch {
		return result;
	}
	// A result that arrives as one JSON string, such as a command's output, reads as its text.
	if (typeof parsed === 'string') return parsed;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
		return JSON.stringify(parsed, null, 2);
	const r = parsed as Record<string, unknown>;
	const list = (key: string) =>
		Array.isArray(r[key]) ? (r[key] as Record<string, unknown>[]) : null;
	const moreMatches = r.truncated === true ? '\nMore matches not shown' : '';
	switch (shapeOf(name)) {
		case 'read': {
			const lines = list('lines');
			if (!lines) break;
			const width = str(lines[lines.length - 1]?.line).length;
			const shown = lines.map((l) => `${str(l.line).padStart(width)}  ${str(l.text)}`);
			if (typeof r.nextOffset === 'number') shown.push(`Continues at line ${r.nextOffset}`);
			return shown.join('\n');
		}
		case 'grep': {
			const matches = list('matches');
			if (!matches) break;
			if (!matches.length) return 'No matches';
			return (
				matches
					.map((m) => `${str(m.path)}:${str(m.line)}  ${str(m.text).trim()}`)
					.join('\n') + moreMatches
			);
		}
		case 'find': {
			const matches = list('matches');
			if (!matches) break;
			if (!matches.length) return 'No matches';
			return matches.map((m) => str(m.path)).join('\n') + moreMatches;
		}
		case 'ls': {
			const entries = list('entries');
			if (!entries) break;
			if (!entries.length) return 'Empty folder';
			const shown = entries.map((e) =>
				e.type === 'folder' ? `${str(e.path)}/` : str(e.path),
			);
			const listed = (typeof r.offset === 'number' ? r.offset : 0) + entries.length;
			if (typeof r.total === 'number' && r.total > listed)
				shown.push(`${r.total - listed} more not listed`);
			return shown.join('\n');
		}
	}
	return JSON.stringify(parsed, null, 2);
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

/**
 * What one tool call did, for the body of the popover its timeline chip opens (LIB-FEAT-252): the
 * change, command or arguments, then the result. The popover's header names it and its status.
 */
export function renderToolDetails(body: HTMLElement, data: ToolCardData): void {
	body.addClass('librarian-tool-details');
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
		body.createEl('pre', { text: readableResult(data.name, data.result) });
		if (data.truncated)
			body.createDiv({ cls: 'librarian-tool-note', text: 'The result was truncated.' });
	}
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
	const alwaysAsks = name === 'write' || name === 'edit' ? alwaysAsksFor(path) : null;
	const buttons = card.createDiv({ cls: 'librarian-approval-buttons' });
	const approve = buttons.createEl('button', { cls: 'mod-cta', text: 'Approve' });
	approve.addEventListener('click', handlers.approve);
	const reject = buttons.createEl('button', { text: 'Reject' });
	reject.addEventListener('click', handlers.reject);
	if (alwaysAsks) {
		card.createDiv({ cls: 'librarian-approval-note', text: alwaysAsks });
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
