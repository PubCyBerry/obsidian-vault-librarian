// Where the composer ends on a phone or a tablet (LIB-TEST-331), in a vault window with mobile
// emulation on (`obsidian dev:mobile on`) and on screen. A window narrower or shorter than 600 px is
// laid out as a phone, a larger one as a tablet.
// Load it through the Obsidian CLI, then start it and read window.__keyboard.results:
//
//   __keyboard.start()   opens a chat in the right sidebar drawer and one in a tab, checks that the
//                        composer's box ends just above what is under it, raises a keyboard as the
//                        app does (--keyboard-height on <html>, keyboard-animating on <body>), and
//                        checks where the box ends while the keyboard rises, once it is up, and
//                        after it has closed
//
// The drawer is the case that broke: it is fixed to the screen, so it does not shrink with the
// app container as a tab does, and it has no navbar over it. `__keyboard.start({ keyboard: 300 })`
// sets the height to raise. tests/composer-layout.test.ts checks the same in a model of this
// layout on every commit; when the two disagree, Obsidian's layout has changed and the model in
// tests/layout/obsidian-mobile.css is out of date.
(() => {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const results = { checks: [], failed: [] };

	function check(name, ok, detail) {
		results.checks.push({ name, ok: !!ok, detail });
		if (!ok) results.failed.push(name);
	}

	function setKeyboard(height, animating) {
		document.body.toggleClass('keyboard-animating', animating);
		document.documentElement.style.setProperty('--keyboard-height', `${height}px`);
	}

	/** Raises or closes the keyboard, with the animating phase before it settles. */
	async function moveKeyboard(height) {
		setKeyboard(height, true);
		await sleep(500);
		const during = measure(height);
		setKeyboard(height, false);
		await sleep(100);
		return { during, after: measure(height) };
	}

	let box;
	function measure(keyboard) {
		const r = box.getBoundingClientRect();
		// What the box ends above: the keyboard, or the view's edge where a navbar under the view
		// holds it higher still.
		const view = box.closest('.view-content').getBoundingClientRect();
		const edge = Math.min(window.innerHeight - keyboard, view.bottom);
		return {
			boxBottom: Math.round(r.bottom),
			keyboardTop: window.innerHeight - keyboard,
			gap: Math.round(edge - r.bottom),
		};
	}

	async function place(where, keyboard) {
		const { workspace } = app;
		const leaf = where === 'drawer' ? workspace.getRightLeaf(false) : workspace.getLeaf('tab');
		await leaf.setViewState({ type: 'librarian-chat', active: true });
		await workspace.revealLeaf(leaf);
		await sleep(600);
		box = leaf.view.contentEl.querySelector('.librarian-composer-box');
		const margin = parseFloat(getComputedStyle(document.body).getPropertyValue('--size-4-3'));
		const closed = measure(0);
		// The navbar where it lies over a phone's tab, the view's own edge everywhere else.
		const navbar = document.querySelector('.mobile-navbar');
		const style = navbar && getComputedStyle(navbar);
		const over = where === 'tab' && style?.display !== 'none' && style?.position === 'fixed';
		const under = over
			? navbar.getBoundingClientRect().top
			: leaf.view.contentEl.getBoundingClientRect().bottom;
		const gap = Math.round(under) - closed.boxBottom;
		// Obsidian's spacing for a docked navbar adds the bottom inset the navbar's height already has.
		const inset = document.body.hasClass('is-floating-nav')
			? 0
			: parseFloat(
					getComputedStyle(document.body).getPropertyValue('--safe-area-inset-bottom'),
				);
		check(
			`${where}: ends just above what is under it while the keyboard is closed`,
			over ? gap >= 0 && gap <= margin + inset : gap === margin,
			{ gap, under: over ? 'navbar' : 'view', boxBottom: closed.boxBottom },
		);
		const up = await moveKeyboard(keyboard);
		// On the keyboard with the composer's own margin, neither behind it nor far above it.
		const onKeyboard = (m) => Math.abs(m.gap - margin) <= 1;
		check(`${where}: rides up while the keyboard rises`, onKeyboard(up.during), up.during);
		check(`${where}: sits on the open keyboard`, onKeyboard(up.after), up.after);
		const down = await moveKeyboard(0);
		check(
			`${where}: back where it was once the keyboard has closed`,
			down.after.boxBottom === closed.boxBottom,
			{ closed, after: down.after },
		);
		leaf.detach();
	}

	async function start({ keyboard = 300 } = {}) {
		results.checks = [];
		results.failed = [];
		results.done = false;
		try {
			if (!document.body.hasClass('is-mobile')) throw new Error('Mobile emulation is off');
			// A window behind another draws no frames, so the composer's transition would not run.
			if (document.hidden) throw new Error('The window is not on screen');
			results.window = `${window.innerWidth}x${window.innerHeight}`;
			results.device = document.body.hasClass('is-phone') ? 'phone' : 'tablet';
			await place('drawer', keyboard);
			await place('tab', keyboard);
		} catch (error) {
			results.failed.push(String(error));
		} finally {
			setKeyboard(0, false);
			results.done = true;
		}
		return results;
	}

	window.__keyboard = { start, results };
})();
