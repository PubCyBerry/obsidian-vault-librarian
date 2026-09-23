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
		for (const tool of TOOL_GROUPS[0]!.tools) expect(perms.get(tool)).toBe('always_allow');
		for (const tool of ['write', 'edit', 'bash', 'outline__search', 'webdav_read', 'skill:x'])
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

	it('LIB-TEST-013: changes are persisted through the save callback', async () => {
		const { perms, saves } = manager();
		await perms.setTool('ls', 'blocked');
		await perms.setGroup('write', 'always_allow');
		expect(saves()).toBe(2);
	});
});
