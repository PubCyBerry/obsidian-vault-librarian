import { describe, expect, it } from 'vitest';
import { expandReferences, findReferences, type ReferenceReader } from '../src/agent/references';
import { fillTemplate, matchCommands, parseSlash } from '../src/ui/slash-commands';

describe('@path references (LIB-TEST-114)', () => {
	it('finds references outside code and ignores e-mail addresses', () => {
		const text = [
			'Read @01-docs/standards/writing-style.md first.',
			'Mail me at someone@example.com.',
			'Inline `@not/this` and a block:',
			'```',
			'@nor/this.md',
			'```',
			'Also (@rules) and @rules again.',
		].join('\n');
		expect(findReferences(text)).toEqual(['01-docs/standards/writing-style.md', 'rules']);
	});

	it('inlines referenced notes recursively, once each, with a depth limit', async () => {
		const notes: Record<string, string> = {
			'AGENTS.md': 'Top. See @a and @missing.',
			'a.md': 'A body. See @b and @AGENTS.',
			'b.md': 'B body. See @a.',
		};
		const reader: ReferenceReader = {
			resolve: (ref) => {
				const path = ref.endsWith('.md') ? ref : `${ref}.md`;
				return path in notes ? path : null;
			},
			read: async (path) => notes[path]!,
		};
		const result = await expandReferences(notes['AGENTS.md']!, 'AGENTS.md', reader);
		expect(result.imported).toEqual(['a.md', 'b.md']);
		expect(result.unresolved).toEqual(['missing']);
		expect(result.text).toContain('<imported path="a.md">');
		expect(result.text).toContain('<imported path="b.md">');
		expect(result.text.match(/<imported path="a.md">/g)).toHaveLength(1);
		const shallow = await expandReferences(notes['AGENTS.md']!, 'AGENTS.md', reader, {
			maxDepth: 1,
		});
		expect(shallow.imported).toEqual(['a.md']);
	});
});

describe('slash commands (LIB-TEST-111)', () => {
	it('parses a command with arguments and matches prefixes', () => {
		expect(parseSlash('/model qwen')).toEqual({ name: 'model', args: 'qwen' });
		expect(parseSlash('/New')).toEqual({ name: 'new', args: '' });
		expect(parseSlash('hello /new')).toBeNull();
		const commands = [
			{ name: 'new', description: '', run: () => undefined },
			{ name: 'note', description: '', run: () => undefined },
			{ name: 'model', description: '', run: () => undefined },
		];
		expect(matchCommands(commands, '/n').map((c) => c.name)).toEqual(['new', 'note']);
		expect(matchCommands(commands, '/').map((c) => c.name)).toEqual(['new', 'note', 'model']);
		expect(matchCommands(commands, '/new x')).toEqual([]);
		expect(fillTemplate('Summarize $ARGUMENTS briefly', 'this')).toBe('Summarize this briefly');
		expect(fillTemplate('Summarize', 'this')).toBe('Summarize\n\nthis');
	});
});
