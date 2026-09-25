import { type App, MarkdownView, Notice, TFile } from 'obsidian';

/**
 * `path/to/note.md:12-20` inside rendered text. One lazy run over a single character class keeps
 * matching linear; the run may swallow words before the path, so the path is trimmed to the
 * longest trailing part that resolves to a note.
 */
const SOURCE_PATTERN = /([^\n:`[\]|]+?\.md):(\d+)(?:-(\d+))?/g;

/** A bracket or quote a citation often opens with, as in `(Meetings/Review.md:3)`. */
const OPENERS = /^[("'“‘<{]+/;

/**
 * Longest trailing space-separated part of `candidate` that `exists` accepts, else the last word,
 * without the bracket or quote the citation opened with.
 */
export function trimToPath(candidate: string, exists: (path: string) => boolean): string {
	const words = candidate.trim().split(' ');
	for (let i = 0; i < words.length; i++) {
		const part = words.slice(i).join(' ');
		if (exists(part)) return part;
		// Checked second, so a folder whose name starts with a bracket still resolves.
		const bare = part.replace(OPENERS, '');
		if (bare !== part && exists(bare)) return bare;
	}
	return (words[words.length - 1] ?? candidate.trim()).replace(OPENERS, '');
}

export interface SourceRef {
	path: string;
	start: number;
	end: number;
}

export type SourceOpener = (ref: SourceRef) => void;

/** Wraps every `path.md:start-end` text run in a clickable element. */
export function linkSources(
	root: HTMLElement,
	open: SourceOpener,
	exists: (path: string) => boolean,
): void {
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
	for (const node of nodes) {
		const text = node.data;
		if (!text.includes('.md:')) continue;
		SOURCE_PATTERN.lastIndex = 0;
		const frag = createFragment();
		let last = 0;
		for (let m = SOURCE_PATTERN.exec(text); m; m = SOURCE_PATTERN.exec(text)) {
			const [whole, captured, startText, endText] = m;
			const path = trimToPath(captured!, exists);
			const linkStart = m.index + captured!.lastIndexOf(path);
			frag.append(text.slice(last, linkStart));
			const start = Number(startText);
			const end = endText ? Number(endText) : start;
			const link = createEl('a', {
				cls: 'librarian-source',
				text: text.slice(linkStart, m.index + whole.length),
				attr: { role: 'button', href: '#' },
			});
			link.addEventListener('click', (e) => {
				e.preventDefault();
				open({ path, start, end });
			});
			frag.append(link);
			last = m.index + whole.length;
		}
		frag.append(text.slice(last));
		node.replaceWith(frag);
	}
}

function resolveFile(app: App, path: string): TFile | null {
	const direct = app.vault.getFileByPath(path);
	if (direct) return direct;
	const linked = app.metadataCache.getFirstLinkpathDest(path.replace(/\.md$/, ''), '');
	return linked instanceof TFile ? linked : null;
}

/**
 * Opens the note and puts the cursor on the cited lines. Line numbers drift when a note is
 * edited, so the text the agent read is searched for first and the number is only a fallback.
 */
export async function openSource(
	app: App,
	ref: SourceRef,
	readLine: (path: string, line: number) => string | null,
): Promise<void> {
	const file = resolveFile(app, ref.path);
	if (!file) {
		new Notice(`Note not found: ${ref.path}`);
		return;
	}
	const leaf = app.workspace.getLeaf(false);
	await leaf.openFile(file);
	const view = leaf.view instanceof MarkdownView ? leaf.view : null;
	if (!view) return;
	if (view.getMode() !== 'source') {
		await view.setState({ ...view.getState(), mode: 'source' }, { history: false });
	}
	const editor = view.editor;
	const lineCount = editor.lineCount();
	const snippet = readLine(file.path, ref.start);
	let line = Math.min(Math.max(ref.start - 1, 0), Math.max(lineCount - 1, 0));
	let found = snippet === null ? null : false;
	if (snippet !== null) {
		const wanted = snippet.trim();
		let best = -1;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let i = 0; i < lineCount; i++) {
			if (editor.getLine(i).trim() !== wanted) continue;
			const distance = Math.abs(i - (ref.start - 1));
			if (distance < bestDistance) {
				best = i;
				bestDistance = distance;
			}
		}
		if (best >= 0) {
			line = best;
			found = true;
		}
	}
	if (found === false) {
		new Notice('The cited text was not found in the note. Opened the note instead.');
		return;
	}
	const span = ref.end - ref.start;
	const endLine = Math.min(line + span, Math.max(lineCount - 1, 0));
	const from = { line, ch: 0 };
	const to = { line: endLine, ch: editor.getLine(endLine).length };
	editor.setCursor(from);
	if (span > 0) editor.setSelection(from, to);
	editor.scrollIntoView({ from, to }, true);
}
