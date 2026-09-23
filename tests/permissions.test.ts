import { describe, expect, it } from 'vitest';
import { ToolPermissionManager } from '../src/permissions/tool-permission-manager';
import { shellPermissionKey } from '../src/shell/commands';
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
	it('LIB-TEST-001: every tool starts as approval_required', () => {
		const { perms } = manager();
		for (const tool of TOOL_NAMES) expect(perms.get(tool)).toBe('approval_required');
		expect(DEFAULT_SETTINGS.toolPermissions.byTool.read).toBe('approval_required');
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
		const { perms } = manager();
		await perms.setTool('grep', 'always_allow');
		for (const tool of TOOL_NAMES) {
			expect(perms.get(tool)).toBe(tool === 'grep' ? 'always_allow' : 'approval_required');
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
		expect(perms.resolve('read', { path: 'AGENTS.md' })).toBe('approval_required');
	});

	it('LIB-TEST-013: changes are persisted through the save callback', async () => {
		const { perms, saves } = manager();
		await perms.setTool('ls', 'blocked');
		await perms.setGroup('write', 'always_allow');
		expect(saves()).toBe(2);
	});
});

describe('shell permission keys (LIB-TEST-175)', () => {
	function shellManager() {
		const m = manager();
		m.perms.attachExtras(
			() => [],
			() => new Set(),
			(tool, args) => shellPermissionKey(tool, args),
		);
		return m;
	}

	it('lets a site follow the curl row until it has one of its own', () => {
		const { perms } = shellManager();
		const call = { url: 'https://api.test/x', method: 'GET' };
		expect(perms.resolve('curl', call)).toBe('approval_required');
		void perms.setTool('curl', 'always_allow');
		expect(perms.resolve('curl', call)).toBe('always_allow');
		void perms.setTool('http:https://api.test', 'blocked');
		expect(perms.resolve('curl', call)).toBe('blocked');
	});

	it('lets the curl row block every site under it', () => {
		const { perms } = shellManager();
		void perms.setTool('http:https://api.test', 'always_allow');
		void perms.setTool('curl', 'blocked');
		expect(perms.resolve('curl', { url: 'https://api.test/x' })).toBe('blocked');
	});

	it('sends an Obsidian verb that only reads to the read-only row', () => {
		const { perms } = shellManager();
		void perms.setGroup('read', 'always_allow');
		expect(perms.resolve('obsidian', { verb: 'search', flags: {} })).toBe('always_allow');
		// A verb that changes something still follows the obsidian row, which asks by default.
		expect(perms.resolve('obsidian', { verb: 'create', flags: {} })).toBe('approval_required');
	});

	it('never lets a verb that cannot be taken back skip approval', () => {
		const { perms } = shellManager();
		void perms.setTool('obsidian', 'always_allow');
		void perms.setTool('obsidian:delete', 'always_allow');
		expect(perms.resolve('obsidian', { verb: 'delete', flags: {} })).toBe('approval_required');
		expect(perms.canAlwaysAllow('obsidian:delete')).toBe(false);
		expect(perms.resolve('obsidian', { verb: 'search', flags: {} })).toBe('always_allow');
	});

	it('gives a named command its own key', () => {
		const { perms } = shellManager();
		void perms.setTool('obsidian', 'always_allow');
		void perms.setTool('command:app:reload', 'blocked');
		expect(perms.resolve('obsidian', { verb: 'command', flags: { id: 'app:reload' } })).toBe(
			'blocked',
		);
		expect(perms.resolve('obsidian', { verb: 'command', flags: { id: 'other:x' } })).toBe(
			'always_allow',
		);
	});
});
