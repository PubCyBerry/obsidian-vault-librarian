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

export function setChecked(el: HTMLElement, checked: boolean): void {
	el.toggleClass('is-active', checked);
	el.setAttr('aria-checked', String(checked));
}
