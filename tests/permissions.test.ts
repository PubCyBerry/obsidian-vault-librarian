import { describe, expect, it } from 'vitest';
import { TOOL_GROUPS, ToolPermissionManager } from '../src/permissions/tool-permission-manager';
import { DEFAULT_SETTINGS, mergeSettings, TOOL_NAMES } from '../src/types';

function manager() {
	const settings = mergeSettings({});
	let saves = 0;
	const perms = new ToolPermissionManager(
		() => settings,
		async () => {
			saves++;
		},
	);
	return { perms, settings, saves: () => saves };
}

describe('tool permissions', () => {
	it('LIB-TEST-001/199: a new install reads without asking and asks before anything else', () => {
		const { perms } = manager();
		for (const tool of [...TOOL_GROUPS[0]!.tools, 'webdav_ls', 'webdav_read'])
			expect(perms.get(tool)).toBe('always_allow');
		// MCP tools that only read get Always allow from the MCP manager (LIB-TEST-212); without
		// it an unknown name asks.
		for (const tool of ['write', 'edit', 'bash', 'outline__search', 'webdav_write', 'skill:x'])
			expect(perms.get(tool)).toBe('approval_required');
		expect(DEFAULT_SETTINGS.toolPermissions.byTool.read).toBe('always_allow');
	});

	it('LIB-TEST-002: a group change is a bulk edit and a differing child shows Mixed', async () => {
		const { perms, settings } = manager();
		await perms.setGroup('read', 'always_allow');
		for (const tool of ['ls', 'find', 'grep', 'read', 'get_active_note'] as const) {
			expect(perms.get(tool)).toBe('always_allow');
		}
		await perms.setTool('read', 'approval_required');
		expect(perms.getGroupDisplay('read')).toBe('mixed');
		expect(Object.values(settings.toolPermissions.byTool)).not.toContain('mixed');
	});

	it('LIB-TEST-003: one tool can change alone', async () => {
		const { perms, settings } = manager();
		const before = { ...settings.toolPermissions.byTool };
		await perms.setTool('grep', 'blocked');
		for (const tool of TOOL_NAMES) {
			expect(perms.get(tool)).toBe(tool === 'grep' ? 'blocked' : before[tool]);
		}
	});

	it('LIB-TEST-004: blocked tools leave the exposed list', async () => {
		const { perms } = manager();
		await perms.setTool('edit', 'blocked');
		const exposed = perms.getExposedTools(TOOL_NAMES.map((name) => ({ name })));
		expect(exposed.map((t) => t.name)).toEqual([
			'ls',
			'find',
			'grep',
			'read',
			'get_active_note',
			'write',
			'tool_search',
			'skill_search',
		]);
	});

	it('LIB-TEST-005: the executor refuses a blocked tool again', async () => {
		const { perms } = manager();
		await perms.setTool('edit', 'blocked');
		expect(() => perms.assertExecutable('edit')).toThrow('Tool blocked by settings');
		expect(perms.resolve('edit', { path: 'a.md' })).toBe('blocked');
	});

	it('LIB-FEAT-011: writing the root AGENTS.md always asks even when always allowed', async () => {
		const { perms } = manager();
		await perms.setGroup('write', 'always_allow');
		expect(perms.resolve('write', { path: 'notes/a.md' })).toBe('always_allow');
		expect(perms.resolve('write', { path: 'AGENTS.md' })).toBe('approval_required');
		expect(perms.resolve('edit', { path: 'agents.md' })).toBe('approval_required');
		// The same normalization as checkPath: spelling tricks do not skip the approval.
		expect(perms.resolve('write', { path: ' ./AGENTS.md ' })).toBe('approval_required');
		expect(perms.resolve('write', { path: '/AGENTS.md' })).toBe('approval_required');
		// Only changes are forced to ask; reading the file follows the read row.
		expect(perms.resolve('read', { path: 'AGENTS.md' })).toBe('always_allow');
	});

	it('a blocked row wins on either side of a narrower key', async () => {
		const { perms } = manager();
		perms.attachExtras(
			() => [],
			() => new Set(),
			(tool) => (tool === 'read' ? 'skill:x' : null),
		);
		await perms.setTool('skill:x', 'always_allow');
		expect(perms.resolve('read', {})).toBe('always_allow');
		await perms.setTool('read', 'blocked');
		expect(perms.resolve('read', {})).toBe('blocked');
		await perms.setTool('read', 'always_allow');
		await perms.setTool('skill:x', 'blocked');
		expect(perms.resolve('read', {})).toBe('blocked');
	});

	it('a tool that may never be always allowed asks, as the tool or as the narrower key', async () => {
		for (const destructive of ['read', 'skill:x']) {
			const { perms } = manager();
			perms.attachExtras(
				() => [],
				() => new Set([destructive]),
				(tool) => (tool === 'read' ? 'skill:x' : null),
			);
			await perms.setTool('read', 'always_allow');
			await perms.setTool('skill:x', 'always_allow');
			expect(perms.resolve('read', {})).toBe('approval_required');
		}
	});

	it('a blocked tool that may never be always allowed stays blocked', async () => {
		const { perms } = manager();
		perms.attachExtras(
			() => [],
			() => new Set(['mcp__drop']),
		);
		await perms.setTool('mcp__drop', 'blocked');
		expect(perms.resolve('mcp__drop', {})).toBe('blocked');
	});

	it('a write without a usable path follows its row', async () => {
		const { perms } = manager();
		await perms.setGroup('write', 'always_allow');
		// Only the AGENTS.md at the vault root is forced to ask.
		expect(perms.resolve('write', { path: 'notes/AGENTS.md' })).toBe('always_allow');
		expect(perms.resolve('write', null)).toBe('always_allow');
		expect(perms.resolve('write', { path: 42 })).toBe('always_allow');
	});

	it('a group is found by its id, and one with no tools asks', async () => {
		const { perms } = manager();
		perms.attachExtras(
			() => [{ id: 'empty', label: 'Empty', tools: [] }],
			() => new Set(),
		);
		await perms.setGroup('write', 'blocked');
		expect(perms.get('read')).toBe('always_allow');
		expect(perms.getGroupDisplay('write')).toBe('blocked');
		expect(perms.getGroupDisplay('read')).toBe('always_allow');
		expect(perms.getGroupDisplay('empty')).toBe('approval_required');
		expect(() => perms.getGroupDisplay('nope')).toThrow('Unknown tool group: nope');
		await expect(perms.setGroup('nope', 'blocked')).rejects.toThrow('Unknown tool group: nope');
	});

	it('LIB-TEST-013: changes are persisted through the save callback', async () => {
		const { perms, saves } = manager();
		await perms.setTool('ls', 'blocked');
		await perms.setGroup('write', 'always_allow');
		expect(saves()).toBe(2);
	});
});
