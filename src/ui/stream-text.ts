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

/** The text nodes under `root`, in the order they read. */
function textNodes(root: Node): Text[] {
	const texts: Text[] = [];
	const collect = (node: Node) => {
		for (const child of Array.from(node.childNodes)) {
			if (child.nodeType === Node.TEXT_NODE) texts.push(child as Text);
			else collect(child);
		}
	};
	collect(root);
	return texts;
}

/** A fading piece `elapsed` ms into its fade. */
function fadingSpan(elapsed: number): HTMLElement {
	const span = createSpan({ cls: 'librarian-reveal' });
	if (elapsed > 0) span.setCssProps({ '--librarian-reveal-delay': `${-Math.round(elapsed)}ms` });
	return span;
}

/** Wraps the text of `root` from offset `from` to `to` in fading pieces, `elapsed` ms into the fade. */
function reveal(root: HTMLElement, from: number, to: number, elapsed: number): void {
	if (from >= to) return;
	const texts = textNodes(root);
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
		const span = fadingSpan(elapsed);
		piece.before(span);
		span.append(piece);
	}
}

interface Piece {
	/** The text node it is in, by its place among the text nodes. */
	node: number;
	from: number;
	to: number;
	at: number;
}

/**
 * Streamed content that is drawn anew each time more of it arrives, such as the arguments of a
 * tool call in its popover (LIB-FEAT-099). Each text node is set against the one in its place in
 * the last drawing: the text it gained fades in, where it was added at the end or inside, as a JSON
 * value grows before its closing brace; a node that is new fades in whole. A piece still fading
 * when the next drawing comes goes on from where it was.
 */
export class RedrawReveal {
	/** What each text node held in the last drawing, before pieces were wrapped. */
	private last: string[] | null = null;
	private fading: Piece[] = [];

	/** The next drawing is a first one: it shows at once. */
	reset(): void {
		this.last = null;
		this.fading = [];
	}

	/** After `root` was drawn anew: what it holds that the last drawing did not fades in. */
	after(root: HTMLElement): void {
		const nodes = textNodes(root);
		const before = this.last;
		this.last = nodes.map((node) => node.data);
		const now = performance.now();
		const still = this.fading.filter((piece) => now - piece.at < REVEAL_MS);
		this.fading = [];
		if (!before) return;
		nodes.forEach((node, i) => {
			const text = node.data;
			const old = before[i];
			let from = 0;
			let to = text.length;
			const ranges: { from: number; to: number; elapsed: number }[] = [];
			if (old !== undefined) {
				// What stayed: the start both share, and the end both share after it.
				while (from < old.length && from < text.length && old[from] === text[from]) from++;
				let end = 0;
				while (
					end < old.length - from &&
					end < text.length - from &&
					old[old.length - 1 - end] === text[text.length - 1 - end]
				)
					end++;
				to = text.length - end;
				// A piece still fading in the text that stayed goes on; one where it changed is new.
				for (const piece of still) {
					const kept = { ...piece, to: Math.min(piece.to, from) };
					if (piece.node !== i || kept.from >= kept.to) continue;
					ranges.push({ from: kept.from, to: kept.to, elapsed: now - piece.at });
					this.fading.push(kept);
				}
			}
			if (to > from) {
				ranges.push({ from, to, elapsed: 0 });
				this.fading.push({ node: i, from, to, at: now });
			}
			// From the last, so each split leaves the offsets before it where they were.
			let limit = text.length;
			for (const range of ranges.sort((a, b) => b.from - a.from)) {
				const stop = Math.min(range.to, limit);
				// Blank text has nothing to show, and a span there would break a table.
				if (range.from >= stop || !text.slice(range.from, stop).trim()) continue;
				if (stop < node.data.length) node.splitText(stop);
				const piece = range.from > 0 ? node.splitText(range.from) : node;
				const span = fadingSpan(range.elapsed);
				piece.before(span);
				span.append(piece);
				limit = range.from;
			}
		});
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
