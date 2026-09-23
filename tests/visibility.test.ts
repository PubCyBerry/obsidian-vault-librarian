import { afterEach, describe, expect, it } from 'vitest';
import { noteVisibility, wasHiddenSince, whenVisible } from '../src/visibility';

const g = globalThis as unknown as { document?: { visibilityState: string } };
const set = (state: string) => {
	g.document = { visibilityState: state };
	noteVisibility();
};

afterEach(() => {
	delete g.document;
	noteVisibility();
});

describe('visibility (LIB-TEST-148)', () => {
	it('remembers a trip to the background that started after the request', async () => {
		set('visible');
		const before = Date.now();
		expect(wasHiddenSince(before)).toBe(false);
		set('hidden');
		expect(wasHiddenSince(before)).toBe(true);
		let back = false;
		const waiting = whenVisible().then(() => {
			back = true;
		});
		await Promise.resolve();
		expect(back).toBe(false);
		set('visible');
		await waiting;
		expect(back).toBe(true);
		// Still counted for the request that was running, but not for one started afterwards.
		expect(wasHiddenSince(before)).toBe(true);
		expect(wasHiddenSince(Date.now() + 1)).toBe(false);
	});
});
