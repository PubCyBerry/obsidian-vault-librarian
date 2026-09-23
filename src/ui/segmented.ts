/**
 * One option of a segmented control (`.librarian-segmented`): a focusable radio that a click,
 * Enter or Space chooses. A div rather than a button, so the button rules Obsidian applies on
 * tablets (wide padding) and inside phone settings rows (full width) leave it alone.
 */
export function segment(parent: HTMLElement, label: string, choose: () => void): HTMLElement {
	const el = parent.createDiv({
		cls: 'librarian-segment',
		attr: { role: 'radio', tabindex: '0', 'aria-label': label, 'aria-checked': 'false' },
	});
	const pick = () => {
		if (!el.hasClass('is-disabled')) choose();
	};
	el.addEventListener('click', pick);
	el.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		e.preventDefault();
		pick();
	});
	return el;
}

/**
 * Writes `current` into a button that can say any of `labels`. All of them sit in one grid cell
 * and only `current` shows, so the button is as wide as its longest label and a column of such
 * buttons lines up whatever each one says (Sign in beside Reconnect).
 */
export function steadyLabel(el: HTMLElement, labels: readonly string[], current: string): void {
	el.empty();
	el.addClass('librarian-steady-label');
	for (const label of new Set([current, ...labels]))
		el.createSpan({ text: label, cls: label === current ? 'is-current' : 'is-spare' });
}

export function setChecked(el: HTMLElement, checked: boolean): void {
	el.toggleClass('is-active', checked);
	el.setAttr('aria-checked', String(checked));
}
