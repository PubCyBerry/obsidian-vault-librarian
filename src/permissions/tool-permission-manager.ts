import type { LibrarianSettings, ToolName, ToolPermission } from '../types';
import { TOOL_NAMES } from '../types';

export interface ToolGroup {
	id: 'read' | 'write';
	label: string;
	tools: readonly ToolName[];
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
	{
		id: 'read',
		label: 'Read-only tools',
		tools: ['ls', 'find', 'grep', 'read', 'get_active_note'],
	},
	{ id: 'write', label: 'Write tools', tools: ['write', 'edit'] },
];

export type ToolGroupDisplayPermission = ToolPermission | 'mixed';

export const PERMISSION_LABELS: Record<ToolPermission, string> = {
	always_allow: 'Always allow',
	approval_required: 'Ask first',
	blocked: 'Blocked',
};

export function isRootAgentsMd(path: string): boolean {
	return path.replace(/^\/+/, '').toLowerCase() === 'agents.md';
}

export class ToolPermissionManager {
	constructor(
		private readonly settings: () => LibrarianSettings,
		private readonly save: () => Promise<void>,
	) {}

	get(tool: ToolName): ToolPermission {
		return this.settings().toolPermissions.byTool[tool] ?? 'approval_required';
	}

	/**
	 * Permission for one concrete call. Writing the vault root AGENTS.md always asks, because that
	 * file steers every later turn.
	 */
	resolve(tool: ToolName, args: unknown): ToolPermission {
		const stored = this.get(tool);
		if (stored === 'blocked') return 'blocked';
		if (tool === 'write' || tool === 'edit') {
			const path = (args as { path?: unknown } | null)?.path;
			if (typeof path === 'string' && isRootAgentsMd(path)) return 'approval_required';
		}
		return stored;
	}

	async setTool(tool: ToolName, permission: ToolPermission): Promise<void> {
		this.settings().toolPermissions.byTool[tool] = permission;
		await this.save();
	}

	async setGroup(groupId: string, permission: ToolPermission): Promise<void> {
		const group = TOOL_GROUPS.find((g) => g.id === groupId);
		if (!group) throw new Error(`Unknown tool group: ${groupId}`);
		for (const tool of group.tools) this.settings().toolPermissions.byTool[tool] = permission;
		await this.save();
	}

	getGroupDisplay(groupId: string): ToolGroupDisplayPermission {
		const group = TOOL_GROUPS.find((g) => g.id === groupId);
		if (!group) throw new Error(`Unknown tool group: ${groupId}`);
		const values = new Set(group.tools.map((t) => this.get(t)));
		return values.size === 1 ? [...values][0]! : 'mixed';
	}

	/** Tools the model may see. Blocked tools are left out of the schema list entirely. */
	getExposedTools<T extends { name: string }>(allTools: T[]): T[] {
		return allTools.filter((t) => this.get(t.name as ToolName) !== 'blocked');
	}

	/** Second line of defence for stale calls: throws for a blocked tool. */
	assertExecutable(tool: ToolName): void {
		if (this.get(tool) === 'blocked') throw new Error('Tool blocked by settings');
	}

	isKnownTool(name: string): name is ToolName {
		return (TOOL_NAMES as readonly string[]).includes(name);
	}
}
