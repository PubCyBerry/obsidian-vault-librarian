import type { App } from 'obsidian';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkPath } from '../src/tools/path-policy';
import { createVaultTools } from '../src/tools/registry';
import { mergeSettings } from '../src/types';
import { FakeApp } from './fake-app';

let app: FakeApp;
let tools: ReturnType<typeof createVaultTools>;

function tool(name: string) {
	const t = tools.find((x) => x.name === name);
	if (!t) throw new Error(name);
	return t;
}

async function run(name: string, args: Record<string, unknown>) {
	const result = await tool(name).execute('id', args as never, undefined);
	return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
}

beforeEach(() => {
	app = new FakeApp();
	app.vault.seed('AGENTS.md', 'root rules');
	app.vault.seed('10-projects/alpha/vault-structure.md', 'l1\nl2 Node.js\nl3\nl4\nl5\nl6');
	app.vault.seed(
		'10-projects/alpha/meeting.md',
		'We use Electron on desktop.\nMobile has no Node.',
	);
	app.vault.seed('00-inbox/inbox.md', 'inbox');
	app.frontmatter.set('10-projects/alpha/vault-structure.md', {
		title: 'Vault structure',
		aliases: ['structure guide'],
	});
	tools = createVaultTools({ app: app as unknown as App, settings: () => mergeSettings({}) });
});

describe('path policy (LIB-TEST-040)', () => {
	const opts = { configDir: '.obsidian' };
	it('rejects traversal, absolute paths and config folders; any extension passes', () => {
		expect(() => checkPath('../secret.md', opts)).toThrow(/traversal/);
		expect(() => checkPath('C:/x.md', opts)).toThrow(/Absolute/);
		expect(() => checkPath('/etc/passwd', opts)).toThrow(/Absolute/);
		expect(() => checkPath('.obsidian/app.json', opts)).toThrow(/not allowed/);
		expect(() => checkPath('.trash/x.md', opts)).toThrow(/not allowed/);
		// The rule follows the vault's config folder name, whatever it is.
		expect(() => checkPath('config/app.json', { configDir: 'config' })).toThrow(/not allowed/);
		expect(checkPath('notes//a.txt', opts)).toBe('notes/a.txt');
	});

	it('every tool refuses paths outside the vault without touching files', async () => {
		const before = app.vault.writes;
		for (const [name, args] of [
			['ls', { path: '../' }],
			['find', { query: 'x', path: '../' }],
			['grep', { query: 'x', path: 'C:/vault' }],
			['read', { path: '../a.md' }],
			['read', { path: 'notes/a.txt' }],
			['write', { path: '/abs.md', content: 'x' }],
			['edit', { path: '.obsidian/a.md', old_text: 'a', new_text: 'b' }],
		] as const) {
			await expect(tool(name).execute('id', args as never, undefined)).rejects.toThrow();
		}
		expect(app.vault.writes).toBe(before);
	});
});

describe('read-only tools', () => {
	it('LIB-TEST-041: ls separates folders from notes and pages', async () => {
		const root = await run('ls', {});
		expect(root.entries).toEqual([
			{ type: 'folder', path: '00-inbox' },
			{ type: 'folder', path: '10-projects' },
			{ type: 'file', path: 'AGENTS.md' },
		]);
		const page = await run('ls', { path: '10-projects/alpha', limit: 1 });
		expect(page.entries).toHaveLength(1);
		expect(page.nextOffset).toBe(1);
		expect(page.total).toBe(2);
		const rest = await run('ls', { path: '10-projects/alpha', offset: 1 });
		expect(rest.nextOffset).toBeUndefined();
	});

	it('LIB-TEST-042: find matches name, path, title and alias but not body text', async () => {
		const byName = await run('find', { query: 'vault-struct' });
		expect((byName.matches as { path: string }[])[0]?.path).toBe(
			'10-projects/alpha/vault-structure.md',
		);
		const byPath = await run('find', { query: 'alpha/meet' });
		expect((byPath.matches as { path: string }[]).map((m) => m.path)).toContain(
			'10-projects/alpha/meeting.md',
		);
		const byTitle = await run('find', { query: 'Vault structure' });
		expect((byTitle.matches as { path: string }[])[0]?.title).toBe('Vault structure');
		const byAlias = await run('find', { query: 'structure guide' });
		expect(byAlias.matches as { path: string }[]).toHaveLength(1);
		const byBody = await run('find', { query: 'Electron' });
		expect(byBody.matches).toEqual([]);
	});

	it('LIB-TEST-043: grep finds literal and regex matches with context and a limit', async () => {
		const literal = await run('grep', { query: 'node', context_lines: 1 });
		const matches = literal.matches as {
			path: string;
			line: number;
			text: string;
			before?: string[];
			after?: string[];
		}[];
		expect(matches.map((m) => `${m.path}:${m.line}`)).toEqual([
			'10-projects/alpha/vault-structure.md:2',
			'10-projects/alpha/meeting.md:2',
		]);
		expect(matches[0]?.before).toEqual(['l1']);
		expect(matches[0]?.after).toEqual(['l3']);
		const regex = await run('grep', { query: '^l[3-4]$', mode: 'regex', limit: 1 });
		expect(regex.matches).toHaveLength(1);
		expect(regex.truncated).toBe(true);
		const scoped = await run('grep', { query: 'l1', path: '00-inbox' });
		expect(scoped.matches).toEqual([]);
		await expect(run('grep', { query: '(', mode: 'regex' })).rejects.toThrow(/Invalid regex/);
	});

	it('LIB-TEST-044: read returns a 1-based range and the next offset', async () => {
		const mid = await run('read', {
			path: '10-projects/alpha/vault-structure.md',
			offset: 2,
			limit: 2,
		});
		expect(mid.lines).toEqual([
			{ line: 2, text: 'l2 Node.js' },
			{ line: 3, text: 'l3' },
		]);
		expect(mid.nextOffset).toBe(4);
		expect(mid.totalLines).toBe(6);
		const first = await run('read', { path: '10-projects/alpha/vault-structure.md', limit: 1 });
		expect((first.lines as { line: number }[])[0]?.line).toBe(1);
		const past = await run('read', {
			path: '10-projects/alpha/vault-structure.md',
			offset: 6,
			limit: 10,
		});
		expect(past.lines).toHaveLength(1);
		expect(past.nextOffset).toBeUndefined();
	});

	it('LIB-TEST-045: get_active_note reports the open note or why there is none', async () => {
		expect(await run('get_active_note', {})).toMatchObject({ path: null });
		app.activeFile = app.vault.getFileByPath('00-inbox/inbox.md');
		expect(await run('get_active_note', {})).toEqual({ path: '00-inbox/inbox.md' });
		app.activeFile = app.vault.seedBinary('img.png', new ArrayBuffer(2));
		expect(await run('get_active_note', {})).toEqual({ path: 'img.png' });
	});
});

describe('write tools', () => {
	it('LIB-TEST-046: write creates notes with parents and only overwrites when asked', async () => {
		const created = await run('write', { path: 'new/deep/note.md', content: '# hi' });
		expect(created).toEqual({ path: 'new/deep/note.md', operation: 'created', characters: 4 });
		expect(app.vault.text('new/deep/note.md')).toBe('# hi');
		expect(app.vault.getFolderByPath('new/deep')).not.toBeNull();
		await expect(run('write', { path: 'new/deep/note.md', content: 'x' })).rejects.toThrow(
			/overwrite/,
		);
		expect(app.vault.text('new/deep/note.md')).toBe('# hi');
		const replaced = await run('write', {
			path: 'new/deep/note.md',
			content: 'x',
			overwrite: true,
		});
		expect(replaced.operation).toBe('overwritten');
		expect(app.vault.text('new/deep/note.md')).toBe('x');
	});

	it('LIB-TEST-047: edit replaces a unique match and refuses ambiguous or stale text', async () => {
		const ok = await run('edit', {
			path: '10-projects/alpha/vault-structure.md',
			old_text: 'l3',
			new_text: 'three',
		});
		expect(ok).toEqual({
			path: '10-projects/alpha/vault-structure.md',
			replacements: 1,
			changed: true,
		});
		expect(app.vault.text('10-projects/alpha/vault-structure.md')).toContain('three');
		await expect(
			run('edit', {
				path: '10-projects/alpha/vault-structure.md',
				old_text: 'l',
				new_text: 'L',
			}),
		).rejects.toThrow(/matches/);
		expect(app.vault.text('10-projects/alpha/vault-structure.md')).toContain('l1');
		const all = await run('edit', {
			path: '10-projects/alpha/vault-structure.md',
			old_text: 'l',
			new_text: 'L',
			replace_all: true,
		});
		expect(all.replacements).toBeGreaterThan(1);
		// The note changed after it was read: the old text no longer exists and nothing is written.
		await expect(
			run('edit', {
				path: '10-projects/alpha/vault-structure.md',
				old_text: 'l1',
				new_text: 'z',
			}),
		).rejects.toThrow(/not found/);
	});
});

describe('any file type (LIB-TEST-129)', () => {
	it('lists, finds, greps and reads non-Markdown text files; binaries are listed but not read', async () => {
		app.vault.seed(
			'10-projects/alpha/board.canvas',
			'{"nodes":[{"id":"n1","text":"Node.js"}]}',
		);
		app.vault.seedBinary('10-projects/alpha/pic.png', new ArrayBuffer(4));
		const listed = await run('ls', { path: '10-projects/alpha' });
		expect((listed.entries as { path: string }[]).map((e) => e.path)).toEqual([
			'10-projects/alpha/board.canvas',
			'10-projects/alpha/meeting.md',
			'10-projects/alpha/pic.png',
			'10-projects/alpha/vault-structure.md',
		]);
		const found = await run('find', { query: 'board' });
		expect((found.matches as { path: string }[])[0]?.path).toBe(
			'10-projects/alpha/board.canvas',
		);
		const hits = await run('grep', { query: 'Node.js', path: '10-projects/alpha' });
		expect((hits.matches as { path: string }[]).map((m) => m.path).sort()).toEqual([
			'10-projects/alpha/board.canvas',
			'10-projects/alpha/vault-structure.md',
		]);
		const read = await run('read', { path: '10-projects/alpha/board.canvas' });
		expect((read.lines as { text: string }[])[0]!.text).toContain('"nodes"');
		await expect(run('read', { path: '10-projects/alpha/pic.png' })).rejects.toThrow(
			/Not a text file/,
		);
		await run('write', { path: '10-projects/alpha/notes.txt', content: 'plain' });
		await run('edit', {
			path: '10-projects/alpha/notes.txt',
			old_text: 'plain',
			new_text: 'edited',
		});
		expect(app.vault.text('10-projects/alpha/notes.txt')).toBe('edited');
	});
});
