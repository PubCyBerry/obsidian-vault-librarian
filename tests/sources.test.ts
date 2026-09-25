import { describe, expect, it } from 'vitest';
import { decodedPath, SOURCE_PATTERN, trimToPath } from '../src/ui/sources';

const notes = new Set(['Meetings/2026-09-15 Design review.md', 'notes.md', '(Archive)/old.md']);
const exists = (path: string) => notes.has(path);

describe('source links (LIB-TEST-264)', () => {
	it('finds a path with spaces inside the parentheses a citation often sits in', () => {
		expect(trimToPath(' (Meetings/2026-09-15 Design review.md', exists)).toBe(
			'Meetings/2026-09-15 Design review.md',
		);
		expect(trimToPath('as written in “notes.md', exists)).toBe('notes.md');
	});

	it('keeps the longest trailing part that is a note, and a folder that starts with a bracket', () => {
		expect(trimToPath('Decided in Meetings/2026-09-15 Design review.md', exists)).toBe(
			'Meetings/2026-09-15 Design review.md',
		);
		expect(trimToPath('see (Archive)/old.md', exists)).toBe('(Archive)/old.md');
	});

	it('falls back to the last word, without its opening bracket, when no part is a note', () => {
		expect(trimToPath('(missing note.md', exists)).toBe('note.md');
	});

	it('finds a path the model wrote with %20 for a space, and opens it decoded', () => {
		const written = 'Projects/Q4 roadmap/Q4%20roadmap.md';
		const roadmap = new Set(['Projects/Q4 roadmap/Q4 roadmap.md']);
		const found = (p: string) => roadmap.has(p) || roadmap.has(decodedPath(p));
		expect(trimToPath(`see ${written}`, found)).toBe(written);
		expect(decodedPath(written)).toBe('Projects/Q4 roadmap/Q4 roadmap.md');
		expect(decodedPath('100%.md')).toBe('100%.md');
	});

	it('reads a line range written with an en dash, as models often typeset it', () => {
		const [match] = 'Meetings/2026-09-15 Design review.md:11–18'.matchAll(SOURCE_PATTERN);
		expect(match?.slice(1)).toEqual(['Meetings/2026-09-15 Design review.md', '11', '18']);
	});
});
