import { type App, prepareFuzzySearch, type TFile } from 'obsidian';
import { vaultReferenceReader } from '../agent/prompt';
import { expandReferences } from '../agent/references';
import { isBinaryPath } from '../tools/path-policy';

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

/** Blocks the composer appends below the typed text; the bubble shows each as a chip instead. */
export const ATTACHED_BLOCK =
	/\n*<(attached_note|attached_file|attached_folder|skill_content) (?:path|name)="([^"]+)"(?: \/>|>[\s\S]*?<\/\1>)/g;

/**
 * A message the composer built, turned back into what the composer held: the typed text, the
 * note and folder chips, and `/skill <name>` for a skill message. The `<imported>` blocks of
 * `@path` references drop off; sending again brings them back.
 */
export function draftOf(message: string): { text: string; mentions: MentionTarget[] } {
	const mentions: MentionTarget[] = [];
	let skill = '';
	// Blocks first: an attached note may itself contain an <imported> tag.
	const typed = message.replace(ATTACHED_BLOCK, (_m, tag: string, id: string) => {
		if (tag === 'skill_content') skill = id;
		else mentions.push({ path: id, kind: tag === 'attached_folder' ? 'folder' : 'file' });
		return '';
	});
	const cut = typed.indexOf('\n\n<imported path="');
	let text = (cut < 0 ? typed : typed.slice(0, cut)).trim();
	if (skill)
		text = text === `Use the ${skill} skill.` ? `/skill ${skill}` : `/skill ${skill} ${text}`;
	return { text, mentions };
}

/** A mentioned folder contributes its note list, not the notes themselves. */
export function folderBlock(path: string, notes: readonly string[], limit = 200): string {
	const shown = notes.slice(0, limit).map((p) => `- ${p}`);
	if (notes.length > limit) shown.push(`(${notes.length - limit} more notes not listed)`);
	return `<attached_folder path="${path}">\n${shown.join('\n')}\n</attached_folder>`;
}

/**
 * The message as the model gets it: the typed text, the attached note, the mention chips, then any
 * `@path` notes the text refers to. A note attached once is not inlined a second time by the `@path`
 * expansion, nor is `from`, the note a command or a skill came from.
 */
export async function composeUserMessage(
	app: App,
	typed: string,
	parts: { activeNote: TFile | null; mentions: readonly MentionTarget[]; from?: string },
): Promise<string> {
	const from = parts.from ?? '';
	let text = typed;
	const seen = new Set<string>([from]);
	const attach = async (file: TFile) => {
		if (seen.has(file.path)) return;
		if (isBinaryPath(file.path)) {
			// Nothing to inline; the path tells the model the file exists.
			text = `${text}\n\n<attached_file path="${file.path}" />`;
		} else {
			const content = await app.vault.cachedRead(file);
			text = `${text}\n\n<attached_note path="${file.path}">\n${content}\n</attached_note>`;
		}
		seen.add(file.path);
	};
	if (parts.activeNote) await attach(parts.activeNote);
	for (const mention of parts.mentions) {
		if (mention.kind === 'file') {
			const file = app.vault.getFileByPath(mention.path);
			if (file) await attach(file);
		} else {
			const notes = app.vault
				.getFiles()
				.filter((f) => f.path.startsWith(`${mention.path}/`))
				.map((f) => f.path)
				.sort();
			text = `${text}\n\n${folderBlock(mention.path, notes)}`;
		}
	}
	return (await expandReferences(text, from, vaultReferenceReader(app), { seen })).text;
}
