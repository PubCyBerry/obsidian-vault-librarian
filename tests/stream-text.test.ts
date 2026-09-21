import { describe, expect, it } from 'vitest';
import { appendStreamDelta } from '../src/ui/stream-text';

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
