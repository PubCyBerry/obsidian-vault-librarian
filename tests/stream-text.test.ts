// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendStreamDelta, closeFence, StreamingMarkdown } from '../src/ui/stream-text';

function fakeEl() {
	const spans: string[] = [];
	const el = {
		empty: () => spans.splice(0),
		createSpan: (o: { text: string }) => spans.push(o.text),
	} as unknown as HTMLElement;
	return { el, spans };
}

describe('appendStreamDelta', () => {
	it('appends only the new tail as a reveal span', () => {
		const { el, spans } = fakeEl();
		let shown = appendStreamDelta(el, '', 'Hello');
		shown = appendStreamDelta(el, shown, 'Hello world');
		shown = appendStreamDelta(el, shown, 'Hello world');
		expect(spans).toEqual(['Hello', ' world']);
		expect(shown).toBe('Hello world');
	});

	it('rebuilds when the shown text is no longer a prefix', () => {
		const { el, spans } = fakeEl();
		const shown = appendStreamDelta(el, 'Hello world', 'Goodbye');
		expect(spans).toEqual(['Goodbye']);
		expect(shown).toBe('Goodbye');
	});
});

describe('closeFence', () => {
	it('closes a code fence that is still open, with the marks it opened with', () => {
		expect(closeFence('Text\n\n```ts\nconst a')).toBe('Text\n\n```ts\nconst a\n```');
		expect(closeFence('~~~~\nx')).toBe('~~~~\nx\n~~~~');
	});

	it('leaves closed fences, and lines that cannot close the open one, alone', () => {
		expect(closeFence('```\na\n```\nafter')).toBe('```\na\n```\nafter');
		// Another kind of mark, a shorter run and a line with an info string do not close it.
		expect(closeFence('````\n~~~\n```\n```js\n')).toBe('````\n~~~\n```\n```js\n\n````');
	});
});

describe('StreamingMarkdown (LIB-TEST-271)', () => {
	// Obsidian's DOM helpers, as far as the drawing uses them.
	beforeAll(() => {
		const g = globalThis as unknown as Record<string, unknown>;
		g.createDiv = () => document.createElement('div');
		g.createSpan = (o?: { cls?: string }) => {
			const span = document.createElement('span');
			if (o?.cls) span.className = o.cls;
			return span;
		};
		(HTMLElement.prototype as unknown as Record<string, unknown>).setCssProps = function (
			this: HTMLElement,
			props: Record<string, string>,
		) {
			for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Paragraphs and bold, which is all these texts use. */
	const draw = (text: string, into: HTMLElement) => {
		into.innerHTML = text
			.split('\n\n')
			.map((p) => `<p>${p.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`)
			.join('\n');
		return Promise.resolve();
	};
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const pieces = (el: HTMLElement) =>
		Array.from(el.querySelectorAll<HTMLElement>('.librarian-reveal')).map((span) => [
			span.textContent,
			span.style.getPropertyValue('--librarian-reveal-delay'),
		]);

	it('keeps the blocks drawn the same and fades in only the words that are new', async () => {
		const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
		const el = document.createElement('div');
		const markdown = new StreamingMarkdown(el, draw);
		markdown.set('First one.\n\nSecond');
		await settle();
		const first = el.children[0];
		expect(pieces(el)).toEqual([
			['First one.', ''],
			['Second', ''],
		]);
		now.mockReturnValue(1100);
		markdown.set('First one.\n\nSecond **bold** end');
		await settle();
		expect(el.children[0]).toBe(first);
		expect(el.innerHTML.replace(/<[^>]+>/g, '')).toBe('First one.Second bold end');
		// Its bold drawn now, the second block is new; the word that was fading goes on from
		// 100 ms into its fade, and only what arrived now starts one. A lone space shows nothing.
		expect(pieces(el)).toEqual([
			['First one.', ''],
			['Second', '-100ms'],
			['bold', ''],
			[' end', ''],
		]);
	});

	it('draws one text at a time and then the latest of those asked for meanwhile', async () => {
		const drawn: string[] = [];
		let release = () => {};
		const slow = (text: string, into: HTMLElement) => {
			drawn.push(text);
			return new Promise<void>((resolve) => {
				release = () => {
					into.innerHTML = `<p>${text}</p>`;
					resolve();
				};
			});
		};
		const el = document.createElement('div');
		const markdown = new StreamingMarkdown(el, slow);
		markdown.set('a');
		markdown.set('ab');
		markdown.set('abc');
		expect(drawn).toEqual(['a']);
		release();
		await settle();
		expect(drawn).toEqual(['a', 'abc']);
		release();
		await settle();
		expect(el.textContent).toBe('abc');
	});
});
