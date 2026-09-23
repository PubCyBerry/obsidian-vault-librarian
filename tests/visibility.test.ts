import { afterEach, describe, expect, it } from 'vitest';
import { abortable, noteVisibility, wasHiddenSince, whenVisible } from '../src/visibility';
import { Platform } from './obsidian-stub';

const g = globalThis as unknown as { document?: { visibilityState: string } };
const set = (state: string) => {
	g.document = { visibilityState: state };
	Platform.isMobile = true;
	noteVisibility();
};

afterEach(() => {
	delete g.document;
	Platform.isMobile = false;
	noteVisibility();
});

describe('visibility (LIB-TEST-148)', () => {
	it('LIB-TEST-215: a covered desktop window is not away', async () => {
		const before = Date.now();
		g.document = { visibilityState: 'hidden' };
		noteVisibility();
		expect(wasHiddenSince(before)).toBe(false);
		await expect(whenVisible()).resolves.toBeUndefined();
	});

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

	it('LIB-TEST-202: Stop ends a wait for the app and a request that never answers', async () => {
		set('hidden');
		const stop = new AbortController();
		const waiting = whenVisible(stop.signal);
		const request = abortable(new Promise(() => {}), stop.signal);
		stop.abort();
		await expect(waiting).rejects.toThrow('Operation aborted');
		await expect(request).rejects.toThrow('Operation aborted');
		// Already stopped: nothing waits at all. Without a signal the work passes through.
		await expect(whenVisible(stop.signal)).rejects.toThrow('Operation aborted');
		await expect(abortable(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
		await expect(abortable(Promise.reject(new Error('refused')))).rejects.toThrow('refused');
	});
});
