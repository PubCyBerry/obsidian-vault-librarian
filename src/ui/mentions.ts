import { prepareFuzzySearch } from 'obsidian';

export interface MentionTarget {
	path: string;
	kind: 'file' | 'folder';
}

export interface MentionQuery {
	/** Offset of the `@` in the text. */
	start: number;
	query: string;
}

/** `@` at the start of the text or after whitespace or an opening bracket, up to the caret. */
const TRIGGER = /(^|[\s([])@([^\s@]*)$/;

export function mentionQuery(text: string, caret: number): MentionQuery | null {
	const m = TRIGGER.exec(text.slice(0, caret));
	if (!m) return null;
	return { start: caret - m[2]!.length - 1, query: m[2]! };
}

/** The short handle left in the text; the chip keeps the full path. Only `.md` drops its extension. */
export function mentionLabel(target: MentionTarget): string {
	const name = target.path.slice(target.path.lastIndexOf('/') + 1);
	return target.kind === 'folder' ? `${name}/` : name.replace(/\.md$/i, '');
}

export function applyMention(
	text: string,
	query: MentionQuery,
	caret: number,
	label: string,
): { text: string; caret: number } {
	const inserted = `@${label} `;
	return {
		text: text.slice(0, query.start) + inserted + text.slice(caret),
		caret: query.start + inserted.length,
	};
}

/** Fuzzy matches on the path, best first; an empty query lists the first few targets. */
export function rankMentions(
	targets: readonly MentionTarget[],
	query: string,
	limit = 8,
): MentionTarget[] {
	if (!query) return targets.slice(0, limit);
	const search = prepareFuzzySearch(query);
	return targets
		.map((t) => ({ t, r: search(t.path) }))
		.filter((x) => x.r !== null)
		.sort((a, b) => b.r!.score - a.r!.score || a.t.path.length - b.t.path.length)
		.slice(0, limit)
		.map((x) => x.t);
}

/** A mentioned folder contributes its note list, not the notes themselves. */
export function folderBlock(path: string, notes: readonly string[], limit = 200): string {
	const shown = notes.slice(0, limit).map((p) => `- ${p}`);
	if (notes.length > limit) shown.push(`(${notes.length - limit} more notes not listed)`);
	return `<attached_folder path="${path}">\n${shown.join('\n')}\n</attached_folder>`;
}
