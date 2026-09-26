// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentController } from '../src/agent/agent-controller';
import type { SessionEntry } from '../src/agent/session-hub';
import type LibrarianPlugin from '../src/main';
import type { SessionMetadata } from '../src/session/session-types';
import { renderSessionList } from '../src/ui/session-list';

/** Just the element helpers of Obsidian the session list calls. */
beforeAll(() => {
	const p = HTMLElement.prototype as unknown as Record<string, unknown>;
	p.empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
	p.addClass = function (this: HTMLElement, ...cls: string[]) {
		this.classList.add(...cls);
	};
	p.setAttr = function (this: HTMLElement, name: string, value: string) {
		this.setAttribute(name, value);
	};
	p.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
		for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
	};
	p.createEl = function (
		this: HTMLElement,
		tag: string,
		o: { cls?: string; text?: string; attr?: Record<string, string> } = {},
	) {
		const el = document.createElement(tag);
		if (o.cls) el.className = o.cls;
		if (o.text) el.textContent = o.text;
		for (const [name, value] of Object.entries(o.attr ?? {})) el.setAttribute(name, value);
		this.appendChild(el);
		return el;
	};
	p.createDiv = function (this: HTMLElement & { createEl: (...a: unknown[]) => HTMLElement }, o) {
		return this.createEl('div', o);
	};
	p.createSpan = function (
		this: HTMLElement & { createEl: (...a: unknown[]) => HTMLElement },
		o,
	) {
		return this.createEl('span', o);
	};
});

const session = (id: string, title: string): SessionMetadata =>
	({ id, title, providerId: 'p', modelId: 'm', updatedAt: 1 }) as SessionMetadata;

describe('the session list (LIB-TEST-286)', () => {
	it('puts the session the chat shows in Active while it runs, marked current, and not in Recent', async () => {
		const el = document.createElement('div');
		const plugin = {
			sessions: { list: async () => [session('a', 'Sent again'), session('b', 'Idle')] },
		} as unknown as LibrarianPlugin;
		const running: SessionEntry = {
			sessionId: 'a',
			title: 'Sent again',
			activity: 'running',
			line: 'Working',
			runtime: {} as AgentController,
		};
		await renderSessionList(el, plugin, () => {}, {
			current: 'a',
			active: [running],
			stop: () => {},
		});
		const rows = (sel: string) =>
			[...el.querySelectorAll(sel)].map((r) => ({
				title: r.querySelector('.librarian-session-title')?.textContent,
				current: r.classList.contains('is-current'),
				stop: !!r.querySelector('.librarian-session-stop'),
			}));
		expect(
			[...el.querySelectorAll('.librarian-sessions-group')].map((g) => g.textContent),
		).toEqual(['Active', 'Recent']);
		expect(rows('.librarian-sessions-active .librarian-session-row')).toEqual([
			{ title: 'Sent again', current: true, stop: true },
		]);
		expect(rows('.librarian-session-row:not(.is-active)')).toEqual([
			{ title: 'Idle', current: false, stop: false },
		]);
	});
});
