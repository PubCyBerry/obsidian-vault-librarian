/** How far the open keyboard reaches over a view whose bottom edge is at `viewBottom`. */
export function keyboardOverlap(
	viewBottom: number,
	viewportHeight: number,
	keyboardHeight: number,
): number {
	if (!(keyboardHeight > 0)) return 0;
	return Math.max(0, Math.round(viewBottom - (viewportHeight - keyboardHeight)));
}

/**
 * Keeps on the composer the two values its bottom padding in styles.css is built from, and
 * returns what stops it (tests/composer-layout.test.ts lays the result out in a browser).
 *
 * `--librarian-keyboard-overlap` is the height the keyboard covers of the view. Measured rather
 * than assumed: Obsidian shrinks the app container by `--keyboard-height`, so a chat in a tab ends
 * on the keyboard by itself, but a sidebar drawer is fixed to the screen and stays full height
 * behind the keyboard, and so does every view while `keyboard-animating` is on.
 *
 * `--librarian-closed-padding` is the padding measured while the keyboard is closed, again with
 * every measurement since a turned screen changes it; the closing animation keeps it so the
 * composer does not drop behind the navbar and jump back.
 */
export function liftAboveKeyboard(view: HTMLElement, composer: HTMLElement): () => void {
	const doc = view.ownerDocument;
	const keyboardHeight = () =>
		parseFloat(getComputedStyle(doc.documentElement).getPropertyValue('--keyboard-height'));
	const animating = () => doc.body.classList.contains('keyboard-animating');
	const rememberClosed = () => {
		if (keyboardHeight() > 0 || animating()) return;
		composer.style.setProperty(
			'--librarian-closed-padding',
			getComputedStyle(composer).paddingBottom,
		);
	};
	const measure = () => {
		const overlap = keyboardOverlap(
			view.getBoundingClientRect().bottom,
			window.innerHeight,
			keyboardHeight(),
		);
		composer.style.setProperty('--librarian-keyboard-overlap', `${overlap}px`);
		window.requestAnimationFrame(rememberClosed);
	};
	// The native keyboard sets --keyboard-height on <html> and keyboard-animating on <body>; the
	// view resizes when the app container shrinks at the end of the animation.
	const mutations = new MutationObserver(measure);
	mutations.observe(doc.documentElement, { attributes: true, attributeFilter: ['style'] });
	mutations.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
	const resizes = new ResizeObserver(measure);
	resizes.observe(view);
	measure();
	return () => {
		mutations.disconnect();
		resizes.disconnect();
	};
}
