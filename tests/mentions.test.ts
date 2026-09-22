import { describe, expect, it } from 'vitest';
import {
	applyMention,
	folderBlock,
	type MentionTarget,
	mentionLabel,
	mentionQuery,
	rankMentions,
} from '../src/ui/mentions';

const targets: MentionTarget[] = [
	{ path: '10-projects', kind: 'folder' },
	{ path: '10-projects/Obsidian Dashboard', kind: 'folder' },
	{ path: '10-projects/Obsidian Dashboard/Obsidian Dashboard.md', kind: 'file' },
	{ path: '00-inbox/TODO.md', kind: 'file' },
	{ path: 'AGENTS.md', kind: 'file' },
];

describe('@mentions (LIB-TEST-127)', () => {
	it('opens after @ at the start or after whitespace, up to the caret, never inside a word', () => {
		expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
		expect(mentionQuery('see @dash and more', 9)).toEqual({ start: 4, query: 'dash' });
		expect(mentionQuery('see @dash and more', 18)).toBeNull();
		expect(mentionQuery('mail me@example', 15)).toBeNull();
		expect(mentionQuery('(@todo', 6)).toEqual({ start: 1, query: 'todo' });
	});

	it('ranks fuzzy matches on the path and lists a few targets for an empty query', () => {
		expect(rankMentions(targets, 'todo')[0]!.path).toBe('00-inbox/TODO.md');
		expect(rankMentions(targets, 'obsdash')[0]!.path).toBe('10-projects/Obsidian Dashboard');
		expect(rankMentions(targets, '', 2)).toHaveLength(2);
		expect(rankMentions(targets, 'zzz')).toEqual([]);
	});

	it('replaces the typed @query with a label and keeps the rest of the text', () => {
		const text = 'compare @dash with the plan';
		const query = mentionQuery(text, 13)!;
		const next = applyMention(text, query, 13, mentionLabel(targets[1]!));
		expect(next.text).toBe('compare @Obsidian Dashboard/  with the plan');
		expect(next.caret).toBe('compare @Obsidian Dashboard/ '.length);
		expect(mentionLabel(targets[3]!)).toBe('TODO');
		expect(mentionLabel({ path: 'a/board.canvas', kind: 'file' })).toBe('board.canvas');
	});

	it('lists a folder as note paths with a cap', () => {
		const block = folderBlock('a', ['a/x.md', 'a/y.md', 'a/z.md'], 2);
		expect(block).toBe(
			'<attached_folder path="a">\n- a/x.md\n- a/y.md\n(1 more notes not listed)\n</attached_folder>',
		);
	});
});
