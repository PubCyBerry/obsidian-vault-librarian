import { describe, expect, it } from 'vitest';
import {
	folderChain,
	NESTED_AGENTS_MD_BUDGET,
	NestedAgentsMd,
	neutralizeTags,
	touchedBy,
} from '../src/agent/nested-agents-md';

describe('where a tool call reaches (LIB-TEST-180)', () => {
	it('walks from the shallowest folder down, dropping the file name', () => {
		expect(folderChain('a/b/c.md', false)).toEqual(['a', 'a/b']);
		expect(folderChain('a/b', true)).toEqual(['a', 'a/b']);
		expect(folderChain('c.md', false)).toEqual([]);
		expect(folderChain('./a//b/', true)).toEqual(['a', 'a/b']);
	});

	it('reads the vault path of vault tools and leaves the vault root to the system prompt', () => {
		expect(touchedBy('read', { path: 'p/q/n.md' }, null)).toEqual([
			{ place: 'vault', folders: ['p', 'p/q'] },
		]);
		expect(touchedBy('ls', { path: 'p/q' }, null)).toEqual([
			{ place: 'vault', folders: ['p', 'p/q'] },
		]);
		expect(touchedBy('ls', {}, null)).toEqual([]);
		expect(touchedBy('get_active_note', {}, 'x/y.md')).toEqual([
			{ place: 'vault', folders: ['x'] },
		]);
		expect(touchedBy('bash', { command: 'cat p/q/n.md' }, null)).toEqual([]);
		expect(touchedBy('outline__search', { path: 'p' }, null)).toEqual([]);
	});

	it('includes the storage root for storage tools and both ends of a copy', () => {
		expect(touchedBy('webdav_read', { path: 'docs/a.md' }, null)).toEqual([
			{ place: 'storage', folders: ['', 'docs'] },
		]);
		expect(
			touchedBy('webdav_download', { path: 'docs/a.md', vault_path: 'in/box' }, null),
		).toEqual([
			{ place: 'storage', folders: ['', 'docs'] },
			{ place: 'vault', folders: ['in', 'in/box'] },
		]);
		expect(touchedBy('webdav_move', { from: 'a/x.md', to: 'b/x.md' }, null)).toEqual([
			{ place: 'storage', folders: ['', 'a'] },
			{ place: 'storage', folders: ['', 'b'] },
		]);
	});
});

describe('delivering a folder AGENTS.md (LIB-TEST-180)', () => {
	function nested(opts: { storage?: boolean } = {}) {
		const vaultFiles: Record<string, string> = {
			p: 'rules of p',
			'p/q': 'rules of q',
		};
		const storageFiles: Record<string, string> = {
			'': 'storage root rules',
			docs: 'docs rules',
		};
		const reads: string[] = [];
		const n = new NestedAgentsMd({
			vault: async (folder) => {
				reads.push(`vault:${folder}`);
				return vaultFiles[folder] ?? null;
			},
			storage: () =>
				opts.storage
					? async (folder) => {
							reads.push(`storage:${folder}`);
							if (!(folder in storageFiles)) throw new Error('Not found');
							return storageFiles[folder]!;
						}
					: null,
			activePath: () => null,
		});
		return { n, reads, vaultFiles };
	}

	it('delivers the chain shallowest first, each folder once', async () => {
		const { n, reads } = nested();
		const first = await n.blockFor('read', { path: 'p/q/note.md' });
		expect(first).toBe(
			'\n\n<agents_md path="p/AGENTS.md">\nrules of p\n</agents_md>\n\n<agents_md path="p/q/AGENTS.md">\nrules of q\n</agents_md>',
		);
		// Already delivered, and already looked at: no second read of either folder.
		expect(await n.blockFor('ls', { path: 'p/q' })).toBe('');
		expect(reads).toEqual(['vault:p', 'vault:p/q']);
	});

	it('delivers again after a reset', async () => {
		const { n } = nested();
		await n.blockFor('read', { path: 'p/note.md' });
		n.reset();
		expect(await n.blockFor('read', { path: 'p/note.md' })).toContain('rules of p');
	});

	it('reads the storage only while it is on, and treats a missing file as none', async () => {
		const off = nested();
		expect(await off.n.blockFor('webdav_read', { path: 'docs/a.md' })).toBe('');
		const on = nested({ storage: true });
		const block = await on.n.blockFor('webdav_read', { path: 'docs/sub/a.md' });
		expect(block).toContain('<agents_md path="webdav:/AGENTS.md">\nstorage root rules');
		expect(block).toContain('<agents_md path="webdav:/docs/AGENTS.md">\ndocs rules');
		expect(block).not.toContain('docs/sub');
	});

	it('does not deliver the same folder twice to calls running side by side', async () => {
		const { n } = nested();
		const [a, b] = await Promise.all([
			n.blockFor('read', { path: 'p/one.md' }),
			n.blockFor('read', { path: 'p/two.md' }),
		]);
		expect([a, b].filter((x) => x.includes('rules of p'))).toHaveLength(1);
	});

	it('keeps to the budget and neutralises the tag inside a delivered file', async () => {
		const { n, vaultFiles } = nested();
		vaultFiles.p = `a <agents_md path="x">b</agents_md> ${'x'.repeat(NESTED_AGENTS_MD_BUDGET)}`;
		const block = await n.blockFor('read', { path: 'p/q/note.md' });
		expect(block).toContain('[truncated to fit the budget]');
		expect(block.match(/<agents_md path=/g)).toHaveLength(1);
		expect(block).toContain('&lt;agents_md path="x">b&lt;/agents_md>');
		// The deeper file found no room, so it was not marked delivered: the next visit brings it.
		expect(block).not.toContain('rules of q');
		expect(await n.blockFor('read', { path: 'p/q/other.md' })).toContain('rules of q');
	});

	it('neutralises the tag wherever it appears', () => {
		expect(neutralizeTags('<agents_md path="a">x</agents_md> and <agents_mdx>')).toBe(
			'&lt;agents_md path="a">x&lt;/agents_md> and &lt;agents_mdx>',
		);
	});

	it('LIB-TEST-202: reads nothing after Stop, and reads again what Stop cut short', async () => {
		let reads = 0;
		const stop = new AbortController();
		const n = new NestedAgentsMd({
			vault: async () => null,
			storage: () => async () => {
				reads++;
				// The first read is the one running when the user presses Stop.
				if (reads === 1) {
					stop.abort();
					throw new Error('Operation aborted');
				}
				return 'storage rules';
			},
			activePath: () => null,
		});
		expect(await n.blockFor('webdav_ls', { path: '' }, stop.signal)).toBe('');
		expect(await n.blockFor('webdav_ls', { path: '' }, stop.signal)).toBe('');
		expect(reads).toBe(1);
		expect(await n.blockFor('webdav_ls', { path: '' })).toContain('storage rules');
	});
});
