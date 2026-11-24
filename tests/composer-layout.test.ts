import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserPath, dumpDom } from './layout/browser';

// Where the composer ends, laid out by a real browser (LIB-TEST-332): the plugin's styles.css and
// keyboard-lift.ts inside a model of Obsidian's mobile layout (tests/layout). A jsdom test cannot
// see any of this, and every earlier fix of the composer's padding broke another case of it.

type Step = {
	boxTop: number;
	boxBottom: number;
	viewTop: number;
	viewBottom: number;
	navbarTop: number | null;
	keyboardTop: number;
	/** The composer moved there in a transition, as the keyboard does, not in a jump. */
	animated?: boolean;
};
type Steps = Record<'closed' | 'rising' | 'open' | 'closing' | 'closedAgain', Step>;

const PHONE = { device: 'phone', width: 360, height: 780, keyboard: 300 };
const TABLET = { device: 'tablet', width: 820, height: 1100, keyboard: 400 };
const ANDROID = { os: 'android', androidInset: 16 };
const IOS = { os: 'ios' };
// The composer's own margin, --size-4-3.
const MARGIN = 12;

/**
 * `under` is what the box must stay clear of while the keyboard is closed, and `gap` how far above
 * it the box ends: the floating navbar in a phone's tab, the view's own edge everywhere else.
 */
const CASES = [
	{ name: 'iPhone, tab', ...PHONE, ...IOS, place: 'tab', under: 'navbar', gap: 2 },
	{ name: 'iPhone, sidebar', ...PHONE, ...IOS, place: 'drawer', under: 'view', gap: MARGIN },
	{ name: 'Android phone, tab', ...PHONE, ...ANDROID, place: 'tab', under: 'navbar', gap: 2 },
	{
		name: 'Android phone, sidebar',
		...PHONE,
		...ANDROID,
		place: 'drawer',
		under: 'view',
		gap: MARGIN,
	},
	{ name: 'iPad, tab', ...TABLET, ...IOS, place: 'tab', under: 'view', gap: MARGIN },
	{ name: 'iPad, sidebar', ...TABLET, ...IOS, place: 'drawer', under: 'view', gap: MARGIN },
	{
		name: 'Android tablet, tab',
		...TABLET,
		...ANDROID,
		place: 'tab',
		under: 'view',
		gap: MARGIN,
	},
	{
		name: 'Android tablet, sidebar',
		...TABLET,
		...ANDROID,
		place: 'drawer',
		under: 'view',
		gap: MARGIN,
	},
] as const;

function page(): string {
	const read = (path: string) => readFileSync(path, 'utf8');
	const lift = buildSync({
		entryPoints: ['src/ui/keyboard-lift.ts'],
		bundle: true,
		format: 'iife',
		globalName: 'KeyboardLift',
		write: false,
	}).outputFiles[0]?.text;
	const frame = `<!doctype html><html><head>
<style>${read('tests/layout/obsidian-mobile.css')}</style>
<style>${read('styles.css')}</style>
</head><body><script>${lift}</script><script>${read('tests/layout/frame.js')}</script></body></html>`;
	// No "<" may reach the page inside a script, where "</script>" would end it.
	const literal = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
	return `<!doctype html><html><body><script>
(async () => {
	const results = [];
	for (const c of ${literal(CASES)}) {
		const frame = document.createElement('iframe');
		frame.style.cssText = 'display:block;border:0;width:' + c.width + 'px;height:' + c.height + 'px';
		frame.srcdoc = ${literal(frame)};
		await new Promise((resolve) => {
			frame.onload = resolve;
			document.body.appendChild(frame);
		});
		results.push(await frame.contentWindow.runCase(c));
		frame.remove();
	}
	return results;
})()
	.catch((error) => ({ error: String(error && error.stack || error) }))
	.then((results) => {
		const out = document.createElement('pre');
		out.id = 'layout-results';
		out.textContent = encodeURIComponent(JSON.stringify(results));
		document.body.replaceChildren(out);
	});
</script></body></html>`;
}

// Without a browser the tests are skipped on a developer's machine, and fail in CI.
describe.skipIf(!browserPath && !process.env.CI)('where the composer ends (LIB-TEST-332)', () => {
	const steps = new Map<string, Steps>();
	const of = (name: string) => {
		const found = steps.get(name);
		if (!found) throw new Error(`No layout for "${name}"`);
		return found;
	};

	beforeAll(async () => {
		const dom = await dumpDom(page());
		const encoded = /<pre id="layout-results">([^<]*)<\/pre>/.exec(dom)?.[1];
		if (!encoded) throw new Error(`The page left no results:\n${dom.slice(0, 2000)}`);
		const results = JSON.parse(decodeURIComponent(encoded)) as
			| { name: string; steps: Steps }[]
			| { error: string };
		if (!Array.isArray(results)) throw new Error(results.error);
		for (const result of results) steps.set(result.name, result.steps);
	}, 90000);

	it('models a view where Obsidian 1.15.1 puts it', () => {
		// Read from the app in mobile emulation, which has an iPhone's insets.
		const ends = (name: string) => {
			const { viewTop, viewBottom, navbarTop } = of(name).closed;
			return { viewTop, viewBottom, navbarTop };
		};
		expect(ends('iPhone, tab')).toEqual({ viewTop: 111, viewBottom: 780, navbarTop: 696 });
		expect(ends('iPhone, sidebar')).toMatchObject({ viewTop: 59, viewBottom: 659 });
		expect(ends('iPad, tab')).toEqual({ viewTop: 151, viewBottom: 1100, navbarTop: null });
		expect(ends('iPad, sidebar')).toMatchObject({ viewTop: 143, viewBottom: 994 });
	});

	describe.each(CASES)('$name', ({ name, under, gap }) => {
		it('ends just above what is under it while the keyboard is closed', () => {
			const { boxBottom, viewBottom, navbarTop } = of(name).closed;
			const edge = under === 'navbar' ? navbarTop : viewBottom;
			expect((edge ?? Number.NaN) - boxBottom).toBe(gap);
		});

		it('rides up with the keyboard', () => {
			const { boxBottom, keyboardTop, animated } = of(name).rising;
			expect(keyboardTop - boxBottom).toBe(MARGIN);
			expect(animated).toBe(true);
		});

		it('sits on the open keyboard', () => {
			const { boxBottom, keyboardTop } = of(name).open;
			expect(keyboardTop - boxBottom).toBe(MARGIN);
		});

		it('stays inside the view while the keyboard is up', () => {
			const { boxTop, viewTop } = of(name).open;
			expect(boxTop).toBeGreaterThan(viewTop);
		});

		it('goes back down with the keyboard, and stays there', () => {
			const { closed, closing, closedAgain } = of(name);
			expect(closing.boxBottom).toBe(closed.boxBottom);
			expect(closedAgain.boxBottom).toBe(closed.boxBottom);
		});
	});
});
