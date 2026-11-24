// Runs inside one frame of the layout test (tests/composer-layout.test.ts), which is the screen of
// one device. Builds the part of Obsidian's mobile DOM a chat view hangs in (obsidian-mobile.css
// lays it out), puts the composer in it as the chat view does, moves a keyboard the way the app
// does and reports where things end at each step. `KeyboardLift` is src/ui/keyboard-lift.ts.

function div(className, parent) {
	const el = document.createElement('div');
	el.className = className;
	parent?.appendChild(el);
	return el;
}

function build(c) {
	// Floating navigation and automatic full screen are settings of Obsidian's, both on at first.
	document.body.className = `is-mobile is-${c.device}${c.docked ? '' : ' is-floating-nav'}${c.windowed ? '' : ' auto-full-screen'}`;
	const app = div('app-container', document.body);
	const workspace = div('workspace', div('horizontal-main-container', app));
	const tabs = div('workspace-tabs', div('workspace-split mod-root', workspace));
	div('workspace-tab-header-container', tabs);
	const tabContainer = div('workspace-tab-container', tabs);
	const drawerInner = div(
		'workspace-drawer-inner',
		div('workspace-drawer mod-secondary', workspace),
	);
	const active = div(
		'workspace-drawer-active-tab-container',
		div('workspace-drawer-tab-container', drawerInner),
	);
	div('workspace-drawer-tab-select', div('workspace-drawer-tab-options', active));
	const drawerContent = div('workspace-drawer-active-tab-content', active);
	div('workspace-drawer-header', drawerInner);
	const navbar = div('mobile-navbar', app);

	const leaf = div('workspace-leaf', c.place === 'drawer' ? drawerContent : tabContainer);
	const content = div('workspace-leaf-content', leaf);
	content.dataset.type = 'librarian-chat';
	div('view-header', content);
	// What LibrarianView.onOpen and Composer.build make, as far as the layout goes.
	const view = div('view-content librarian is-mobile', content);
	div('librarian-session-head', view);
	div('librarian-messages', view);
	const composer = div('librarian-composer', view);
	const box = div('librarian-composer-box', composer);
	const input = box.appendChild(document.createElement('textarea'));
	input.className = 'librarian-input';
	input.rows = 2;
	div('librarian-composer-row', box);
	return { view, composer, box, navbar };
}

// A headless browser draws a frame of an inner frame only now and then, so a callback waiting for
// one may never run. Here a frame is a timer, which the browser's virtual clock does run.
window.requestAnimationFrame = (callback) => setTimeout(callback, 16);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

window.runCase = async (c) => {
	const root = document.documentElement.style;
	// Android reports the open keyboard as the bottom safe-area inset; iOS keeps its inset.
	const inset = (keyboard) => {
		if (c.os === 'android')
			root.setProperty('--safe-area-inset-bottom', `${keyboard || c.androidInset}px`);
	};
	inset(0);
	const { view, composer, box, navbar } = build(c);
	KeyboardLift.liftAboveKeyboard(view, composer);

	let keyboard = 0;
	const measure = () => {
		const bottom = (el) => Math.round(el.getBoundingClientRect().bottom);
		const top = (el) => Math.round(el.getBoundingClientRect().top);
		return {
			boxTop: top(box),
			boxBottom: bottom(box),
			viewTop: top(view),
			viewBottom: bottom(view),
			navbarTop: getComputedStyle(navbar).display === 'none' ? null : top(navbar),
			keyboardTop: window.innerHeight - keyboard,
		};
	};
	// Lets the observers and the frame they wait for run, and takes the composer's transition to
	// its end, which is where the box is when the keyboard has finished moving. Says whether
	// there was a transition: without one the composer jumps while the keyboard slides.
	const settle = async () => {
		let animated = false;
		for (let i = 0; i < 2; i++) {
			await wait(0);
			for (const animation of composer.getAnimations()) {
				animated = true;
				animation.finish();
			}
			await wait(32);
		}
		return animated;
	};
	const move = async (height, animating) => {
		keyboard = height;
		document.body.classList.toggle('keyboard-animating', animating);
		root.setProperty('--keyboard-height', `${height}px`);
		inset(height);
		const animated = await settle();
		return { ...measure(), animated };
	};

	await settle();
	const steps = { closed: measure() };
	steps.rising = await move(c.keyboard, true);
	steps.open = await move(c.keyboard, false);
	steps.closing = await move(0, true);
	steps.closedAgain = await move(0, false);
	return { name: c.name, steps };
};
