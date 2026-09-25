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

/** How long a piece fades in: the `.librarian-reveal` animation in styles.css. */
const REVEAL_MS = 280;

/**
 * The text with a code fence it leaves open closed, so code that is still arriving is drawn as
 * code instead of as text until its fence comes.
 */
export function closeFence(text: string): string {
	let open: string | null = null;
	for (const line of text.split('\n')) {
		const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (!fence) continue;
		const marks = fence[1]!;
		if (open === null) open = marks;
		else if (marks[0] === open[0] && marks.length >= open.length && !fence[2]!.trim())
			open = null;
	}
	return open === null ? text : `${text}\n${open}`;
}

/** Wraps the text of `root` from offset `from` to `to` in fading pieces, `elapsed` ms into the fade. */
function reveal(root: HTMLElement, from: number, to: number, elapsed: number): void {
	if (from >= to) return;
	const texts: Text[] = [];
	const collect = (node: Node) => {
		for (const child of Array.from(node.childNodes)) {
			if (child.nodeType === Node.TEXT_NODE) texts.push(child as Text);
			else collect(child);
		}
	};
	collect(root);
	let offset = 0;
	for (const node of texts) {
		const nodeStart = offset;
		offset += node.data.length;
		const start = Math.max(from, nodeStart);
		const end = Math.min(to, offset);
		// Blank text between blocks has nothing to show, and a span there would break a table.
		if (start >= end || !node.data.trim()) continue;
		let piece = node;
		if (start > nodeStart) piece = piece.splitText(start - nodeStart);
		if (end < offset) piece.splitText(end - start);
		const span = createSpan({ cls: 'librarian-reveal' });
		if (elapsed > 0)
			span.setCssProps({ '--librarian-reveal-delay': `${-Math.round(elapsed)}ms` });
		piece.before(span);
		span.append(piece);
	}
}

/**
 * Markdown that streams in (LIB-FEAT-099): drawn whole each time more of it arrives. Top-level
 * blocks that come out as they did the last time stay on the page and the rest are swapped in, so
 * only text that was not on the page before fades in. A piece still fading when its block is
 * swapped goes on fading from where it was instead of starting over or stopping short.
 */
export class StreamingMarkdown {
	/** Each top-level block as last drawn, before it went on the page and pieces were wrapped. */
	private blocks: string[] = [];
	/** Pieces still fading in: where they are in the text and when they began. */
	private fading: { from: number; to: number; at: number }[] = [];
	private latest = '';
	private next: string | null = null;
	private busy = false;

	constructor(
		private readonly el: HTMLElement,
		/** Draws Markdown into a detached element. */
		private readonly draw: (text: string, into: HTMLElement) => Promise<void>,
		/** Runs each swap, as a message chip does to grow around it. */
		private readonly around: (swap: () => void) => void = (swap) => swap(),
	) {}

	/** The whole text so far. Drawings do not overlap: one asked for meanwhile waits its turn. */
	set(text: string): void {
		if (text === this.latest) return;
		this.latest = text;
		this.next = text;
		if (!this.busy) void this.drain();
	}

	private async drain(): Promise<void> {
		this.busy = true;
		while (this.next !== null) {
			const text = this.next;
			this.next = null;
			const fresh = createDiv();
			try {
				await this.draw(closeFence(text), fresh);
			} catch {
				// The page keeps the last drawing; the next text is drawn whole again.
				continue;
			}
			this.around(() => this.swap(fresh));
		}
		this.busy = false;
	}

	private swap(fresh: HTMLElement): void {
		const next = Array.from(fresh.children);
		const html = next.map((block) => block.outerHTML);
		const old = Array.from(this.el.children);
		let same = 0;
		while (same < old.length && same < html.length && this.blocks[same] === html[same]) same++;
		const before = this.el.textContent ?? '';
		const start = old
			.slice(0, same)
			.reduce((n, block) => n + (block.textContent ?? '').length, 0);
		for (const block of old.slice(same)) block.remove();
		this.el.append(...next.slice(same));
		this.blocks = html;
		const after = this.el.textContent ?? '';
		let kept = 0;
		while (kept < before.length && kept < after.length && before[kept] === after[kept]) kept++;
		const now = performance.now();
		this.fading = this.fading.filter((piece) => now - piece.at < REVEAL_MS);
		for (const piece of this.fading)
			reveal(this.el, Math.max(piece.from, start), Math.min(piece.to, kept), now - piece.at);
		if (after.length > kept) {
			reveal(this.el, kept, after.length, 0);
			this.fading.push({ from: kept, to: after.length, at: now });
		}
	}
}
