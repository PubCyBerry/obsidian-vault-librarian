import { describe, expect, it } from 'vitest';
import {
	applyMention,
	composeUserMessage,
	draftOf,
	folderBlock,
	type MentionTarget,
	mentionLabel,
	mentionQuery,
	rankMentions,
} from '../src/ui/mentions';
import { FakeApp } from './fake-app';

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

describe('a queued message handed back to the composer (LIB-TEST-186)', () => {
	it('keeps the typed text and turns the attached blocks back into chips', () => {
		const message = [
			'compare @plan with the folder',
			'',
			'<attached_note path="10-projects/plan.md">',
			'# Plan <imported path="x">quoted inside the note</imported>',
			'</attached_note>',
			'',
			'<attached_folder path="10-projects">',
			'- 10-projects/plan.md',
			'</attached_folder>',
			'',
			'<attached_file path="assets/a.pdf" />',
			'',
			'<imported path="notes/ref.md">',
			'ref body',
			'</imported>',
		].join('\n');
		expect(draftOf(message)).toEqual({
			text: 'compare @plan with the folder',
			mentions: [
				{ path: '10-projects/plan.md', kind: 'file' },
				{ path: '10-projects', kind: 'folder' },
				{ path: 'assets/a.pdf', kind: 'file' },
			],
		});
	});

	it('gives a skill message back as the command that made it', () => {
		const block = '<skill_content name="obsidian-markdown">\nbody\n</skill_content>';
		expect(draftOf(`make a table\n\n${block}`).text).toBe(
			'/skill obsidian-markdown make a table',
		);
		expect(draftOf(`Use the obsidian-markdown skill.\n\n${block}`).text).toBe(
			'/skill obsidian-markdown',
		);
	});

	it('composes the message from the active note, the chips and the @path notes, each once', async () => {
		const app = new FakeApp();
		const active = app.vault.seed('notes/active.md', 'active body');
		app.vault.seed('10-projects/plan.md', 'plan body, see @notes/ref');
		app.vault.seed('10-projects/sub/b.md', 'b');
		app.vault.seed('notes/ref.md', 'ref body');
		app.vault.seedBinary('assets/a.pdf', new ArrayBuffer(4));
		const text = await composeUserMessage(app as never, 'compare @plan with @notes/active', {
			activeNote: active,
			mentions: [
				{ path: '10-projects/plan.md', kind: 'file' },
				{ path: 'notes/active.md', kind: 'file' },
				{ path: 'assets/a.pdf', kind: 'file' },
				{ path: '10-projects', kind: 'folder' },
			],
		});
		expect(text).toBe(
			[
				'compare @plan with @notes/active',
				'',
				'<attached_note path="notes/active.md">\nactive body\n</attached_note>',
				'',
				'<attached_note path="10-projects/plan.md">\nplan body, see @notes/ref\n</attached_note>',
				'',
				'<attached_file path="assets/a.pdf" />',
				'',
				'<attached_folder path="10-projects">\n- 10-projects/plan.md\n- 10-projects/sub/b.md\n</attached_folder>',
				'',
				'<imported path="notes/ref.md">\nref body\n</imported>',
			].join('\n'),
		);
	});
});
