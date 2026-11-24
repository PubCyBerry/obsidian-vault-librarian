// The composer above the phone keyboard (LIB-TEST-331), in a vault window with mobile emulation on
// (`obsidian dev:mobile on`), on screen, and narrower or shorter than 600 px, so Obsidian lays it out
// as a phone.
// Load it through the Obsidian CLI, then start it and read window.__keyboard.results:
//
//   __keyboard.start()   opens a chat in the right sidebar drawer and one in a tab, raises a
//                        keyboard as the app does (--keyboard-height on <html>, keyboard-animating
//                        on <body>), and checks where the composer's box ends while the keyboard
//                        rises, once it is up, and after it has closed
//
// The drawer is the case that broke: it is fixed to the screen, so it does not shrink with the
// app container as a tab does. `__keyboard.start({ keyboard: 300 })` sets the height to raise.
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
		return {
			boxBottom: Math.round(r.bottom),
			keyboardTop: window.innerHeight - keyboard,
			gap: Math.round(window.innerHeight - keyboard - r.bottom),
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
			if (!document.body.hasClass('is-phone')) throw new Error('Not laid out as a phone');
			// A window behind another draws no frames, so the composer's transition would not run.
			if (document.hidden) throw new Error('The window is not on screen');
			results.window = `${window.innerWidth}x${window.innerHeight}`;
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
