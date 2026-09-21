/**
 * Appends the part of `full` that `el` does not show yet, wrapped so CSS can animate its entry.
 * Streamed text only grows, so the shown text is normally a prefix; when it is not (the model
 * restarted the message), the element is rebuilt. Returns the text now shown.
 */
export function appendStreamDelta(el: HTMLElement, shown: string, full: string): string {
	if (!full.startsWith(shown)) {
		el.empty();
		shown = '';
	}
	const delta = full.slice(shown.length);
	if (delta) el.createSpan({ cls: 'librarian-reveal', text: delta });
	return full;
}
