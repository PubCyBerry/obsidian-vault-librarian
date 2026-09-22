import type { LibrarianSettings, ToolPermission } from '../types';

export interface ToolGroup {
	id: string;
	label: string;
	tools: readonly string[];
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

/** Lucide icon and the tooltip line shown under the label in the settings control. */
export const PERMISSION_ICONS: Record<ToolPermission, string> = {
	always_allow: 'circle-check',
	approval_required: 'hand',
	blocked: 'ban',
};

export const PERMISSION_DESCRIPTIONS: Record<ToolPermission, string> = {
	always_allow: 'Runs without asking.',
	approval_required: 'Asks you before every call.',
	blocked: 'Hidden from the model.',
};

export function isRootAgentsMd(path: string): boolean {
	return path.replace(/^\/+/, '').toLowerCase() === 'agents.md';
}

export class ToolPermissionManager {
	/** Groups beyond the built-in vault tools (one per MCP server) and tools that never get Always allow. */
	private extraGroups: () => ToolGroup[] = () => [];
	private alwaysAsk: () => ReadonlySet<string> = () => new Set();

	constructor(
		private readonly settings: () => LibrarianSettings,
		private readonly save: () => Promise<void>,
	) {}

	attachExtras(groups: () => ToolGroup[], alwaysAsk: () => ReadonlySet<string>): void {
		this.extraGroups = groups;
		this.alwaysAsk = alwaysAsk;
	}

	groups(): ToolGroup[] {
		return [...TOOL_GROUPS, ...this.extraGroups()];
	}

	get(tool: string): ToolPermission {
		return this.settings().toolPermissions.byTool[tool] ?? 'approval_required';
	}

	/** False for tools a server marks destructive: they can be allowed once or blocked, never always. */
	canAlwaysAllow(tool: string): boolean {
		return !this.alwaysAsk().has(tool);
	}

	/**
	 * Permission for one concrete call. Writing the vault root AGENTS.md always asks, because that
	 * file steers every later turn.
	 */
	resolve(tool: string, args: unknown): ToolPermission {
		const stored = this.get(tool);
		if (stored === 'blocked') return 'blocked';
		if (!this.canAlwaysAllow(tool)) return 'approval_required';
		if (tool === 'write' || tool === 'edit') {
			const path = (args as { path?: unknown } | null)?.path;
			if (typeof path === 'string' && isRootAgentsMd(path)) return 'approval_required';
		}
		return stored;
	}

	async setTool(tool: string, permission: ToolPermission): Promise<void> {
		this.settings().toolPermissions.byTool[tool] = permission;
		await this.save();
	}

	async setGroup(groupId: string, permission: ToolPermission): Promise<void> {
		const group = this.groups().find((g) => g.id === groupId);
		if (!group) throw new Error(`Unknown tool group: ${groupId}`);
		for (const tool of group.tools) this.settings().toolPermissions.byTool[tool] = permission;
		await this.save();
	}

	getGroupDisplay(groupId: string): ToolGroupDisplayPermission {
		const group = this.groups().find((g) => g.id === groupId);
		if (!group) throw new Error(`Unknown tool group: ${groupId}`);
		if (group.tools.length === 0) return 'approval_required';
		const values = new Set(group.tools.map((t) => this.get(t)));
		return values.size === 1 ? [...values][0]! : 'mixed';
	}

	/** Tools the model may see. Blocked tools are left out of the schema list entirely. */
	getExposedTools<T extends { name: string }>(allTools: T[]): T[] {
		return allTools.filter((t) => this.get(t.name) !== 'blocked');
	}

	/** Second line of defence for stale calls: throws for a blocked tool. */
	assertExecutable(tool: string): void {
		if (this.get(tool) === 'blocked') throw new Error('Tool blocked by settings');
	}
}
