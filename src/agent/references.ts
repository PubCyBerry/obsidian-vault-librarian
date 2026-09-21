/**
 * `@path` references inside Markdown. A reference is `@` followed by a path, standing at the
 * start of the text or after whitespace or an opening bracket, so e-mail addresses and code do
 * not count. Fenced blocks and inline code are masked before matching.
 */
const REFERENCE = /(^|[\s([])@([^\s`'"()[\]<>]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

export interface ReferenceReader {
	/** Vault path of the note `ref` names, seen from the note at `from`, or null when unknown. */
	resolve(ref: string, from: string): string | null;
	read(path: string): Promise<string>;
}

export interface Expansion {
	text: string;
	/** Vault paths inlined, in the order they were appended (nested ones included). */
	imported: string[];
	/** References that named no note; left in the text untouched. */
	unresolved: string[];
}

/** Replaces code with spaces of the same length so offsets stay valid. */
export function maskCode(text: string): string {
	const blank = (s: string) => s.replace(/[^\n]/g, ' ');
	return text
		.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, blank)
		.replace(/`[^`\n]*`/g, blank);
}

export function findReferences(text: string): string[] {
	const masked = maskCode(text);
	const out: string[] = [];
	for (const m of masked.matchAll(REFERENCE)) {
		const ref = m[2]!.replace(TRAILING_PUNCTUATION, '');
		if (ref && !out.includes(ref)) out.push(ref);
	}
	return out;
}

/**
 * Appends every referenced note below the text as an `<imported>` block, following references
 * inside imported notes up to `maxDepth` levels. A note is inlined once per expansion.
 */
export async function expandReferences(
	text: string,
	from: string,
	reader: ReferenceReader,
	options: { maxDepth?: number; seen?: Set<string> } = {},
): Promise<Expansion> {
	const maxDepth = options.maxDepth ?? 5;
	const seen = options.seen ?? new Set<string>([from]);
	const imported: string[] = [];
	const unresolved: string[] = [];
	const blocks: string[] = [];
	if (maxDepth <= 0) return { text, imported, unresolved };
	for (const ref of findReferences(text)) {
		const path = reader.resolve(ref, from);
		if (!path) {
			unresolved.push(ref);
			continue;
		}
		if (seen.has(path)) continue;
		seen.add(path);
		let content: string;
		try {
			content = await reader.read(path);
		} catch {
			unresolved.push(ref);
			continue;
		}
		const nested = await expandReferences(content, path, reader, {
			maxDepth: maxDepth - 1,
			seen,
		});
		imported.push(path, ...nested.imported);
		unresolved.push(...nested.unresolved);
		blocks.push(`<imported path="${path}">\n${nested.text.trim()}\n</imported>`);
	}
	return {
		text: blocks.length ? `${text.trimEnd()}\n\n${blocks.join('\n\n')}` : text,
		imported,
		unresolved,
	};
}
