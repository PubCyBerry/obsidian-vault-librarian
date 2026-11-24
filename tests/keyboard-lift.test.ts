// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyboardOverlap, liftAboveKeyboard } from '../src/ui/keyboard-lift';

describe('the composer above the phone keyboard (LIB-TEST-331)', () => {
	const SCREEN = 780;
	const KEYBOARD = 300;
	let view: HTMLElement;
	let composer: HTMLElement;
	let viewBottom: number;
	let resized: () => void;
	let stop: () => void;

	const overlap = () => composer.style.getPropertyValue('--librarian-keyboard-overlap');
	// Observers report after the change that woke them.
	const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
	const keyboard = (height: number) =>
		document.documentElement.style.setProperty('--keyboard-height', `${height}px`);

	beforeEach(() => {
		Object.defineProperty(window, 'innerHeight', { value: SCREEN, configurable: true });
		// jsdom lays nothing out and has no ResizeObserver: the view ends where the test says.
		globalThis.ResizeObserver = class {
			constructor(callback: () => void) {
				resized = callback;
			}
			observe() {}
			disconnect() {
				resized = () => {};
			}
		} as unknown as typeof ResizeObserver;
		view = document.body.appendChild(document.createElement('div'));
		composer = view.appendChild(document.createElement('div'));
		viewBottom = SCREEN;
		view.getBoundingClientRect = () => ({ bottom: viewBottom }) as DOMRect;
		keyboard(0);
		stop = liftAboveKeyboard(view, composer);
	});

	afterEach(() => {
		stop();
		view.remove();
		document.body.className = '';
	});

	it('measures how far the keyboard reaches over the view', () => {
		expect(keyboardOverlap(780, 780, 300)).toBe(300);
		// A drawer ends above the screen's edge: its tab picker and file name come under the view.
		expect(keyboardOverlap(650, 780, 300)).toBe(170);
		// A view that shrank with the app container ends on the keyboard, or above it.
		expect(keyboardOverlap(480, 780, 300)).toBe(0);
		expect(keyboardOverlap(400, 780, 300)).toBe(0);
		expect(keyboardOverlap(780, 780, 0)).toBe(0);
		expect(keyboardOverlap(780, 780, Number.NaN)).toBe(0);
	});

	it('lifts nothing while the keyboard is closed', () => {
		expect(overlap()).toBe('0px');
	});

	it('lifts the composer of a sidebar drawer, which stays full height behind the keyboard', async () => {
		viewBottom = 650;
		keyboard(KEYBOARD);
		await settled();
		expect(overlap()).toBe('170px');
		// Nothing about the drawer changes when the animation ends, so neither does the lift.
		document.body.classList.add('keyboard-animating');
		await settled();
		document.body.classList.remove('keyboard-animating');
		await settled();
		expect(overlap()).toBe('170px');
		keyboard(0);
		await settled();
		expect(overlap()).toBe('0px');
	});

	it('lifts a tab only while the app container has yet to shrink', async () => {
		document.body.classList.add('keyboard-animating');
		keyboard(KEYBOARD);
		await settled();
		expect(overlap()).toBe('300px');
		// The animation ends: the container shrinks by the keyboard and the class goes.
		viewBottom = SCREEN - KEYBOARD;
		document.body.classList.remove('keyboard-animating');
		await settled();
		expect(overlap()).toBe('0px');
	});

	it('measures again when the view resizes', () => {
		keyboard(KEYBOARD);
		viewBottom = 700;
		resized();
		expect(overlap()).toBe('220px');
	});

	it('remembers the padding of the closed keyboard, and only that', async () => {
		const closed = () => composer.style.getPropertyValue('--librarian-closed-padding');
		const frame = () => new Promise((resolve) => window.requestAnimationFrame(resolve));
		composer.style.paddingBottom = '86px';
		await frame();
		expect(closed()).toBe('86px');
		// Up, or on its way: the padding is the keyboard's.
		composer.style.paddingBottom = '312px';
		document.body.classList.add('keyboard-animating');
		keyboard(KEYBOARD);
		await settled();
		await frame();
		document.body.classList.remove('keyboard-animating');
		await settled();
		await frame();
		keyboard(0);
		document.body.classList.add('keyboard-animating');
		await settled();
		await frame();
		expect(closed()).toBe('86px');
		// Closed again, on a screen that has turned meanwhile.
		composer.style.paddingBottom = '73px';
		document.body.classList.remove('keyboard-animating');
		await settled();
		await frame();
		expect(closed()).toBe('73px');
	});

	it('stops measuring once stopped', async () => {
		stop();
		keyboard(KEYBOARD);
		resized();
		await settled();
		expect(overlap()).toBe('0px');
	});

	// Each fix so far added a padding rule for one more case, and the next case fell through it.
	it('keeps the measured lift in every bottom padding of the composer', () => {
		const css = readFileSync('styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
		const paddings = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
			.filter(([, selectors]) =>
				(selectors ?? '').split(',').some((s) => s.trim().endsWith('.librarian-composer')),
			)
			.map(([, , body]) => /padding-bottom:([^;]+);/.exec(body ?? '')?.[1] ?? '')
			.filter(Boolean);
		expect(paddings.length).toBeGreaterThanOrEqual(3);
		for (const padding of paddings) expect(padding).toContain('--librarian-composer-bottom');
		expect(css).toMatch(
			/--librarian-composer-bottom:\s*calc\(var\(--librarian-keyboard-overlap, 0px\) \+/,
		);
	});
});
