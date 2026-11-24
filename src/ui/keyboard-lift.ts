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
 * Keeps `--librarian-keyboard-overlap` on the composer at the height the keyboard covers of the
 * view, which styles.css adds to the composer's bottom padding. Measured rather than assumed:
 * Obsidian shrinks the app container by `--keyboard-height`, so a chat in a tab ends on the
 * keyboard by itself, but a sidebar drawer is fixed to the screen and stays full height behind
 * the keyboard, and so does every view while `keyboard-animating` is on. Returns what stops it.
 */
export function liftAboveKeyboard(view: HTMLElement, composer: HTMLElement): () => void {
	const doc = view.ownerDocument;
	const measure = () => {
		const keyboard = parseFloat(
			getComputedStyle(doc.documentElement).getPropertyValue('--keyboard-height'),
		);
		const overlap = keyboardOverlap(
			view.getBoundingClientRect().bottom,
			window.innerHeight,
			keyboard,
		);
		composer.style.setProperty('--librarian-keyboard-overlap', `${overlap}px`);
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
