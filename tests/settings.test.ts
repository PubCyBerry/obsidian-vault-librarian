import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_AGENTS } from '../src/agent/agent-definitions';
import { DEFAULT_SYSTEM_PROMPT, systemPromptOf } from '../src/agent/prompt';
import type LibrarianPlugin from '../src/main';
import { SHELL_GROUP, ToolPermissionManager } from '../src/permissions/tool-permission-manager';
import { LibrarianSettingTab } from '../src/settings/settings-tab';
import { type Skill, skillGroups } from '../src/skills/skill-manager';
import { mergeSettings, newProvider, type ProviderConfig } from '../src/types';

interface Row {
	name: string;
	desc?: unknown;
	aliases?: string[];
}
interface Section {
	type: 'group' | 'list';
	heading?: string;
	items?: Row[];
	addItem?: { name: string };
	emptyState?: unknown;
}
interface Page {
	type: 'page';
	name: string;
	desc?: string;
	displayValue?: string;
	status?: string | null;
	items: Section[];
}

const skill = (name: string): Skill => ({
	name,
	description: `Does ${name} things.`,
	location: `.agents/skills/${name}/SKILL.md`,
	dir: `.agents/skills/${name}`,
	warnings: [],
});

/** A plugin with just what the settings tab reads while it builds its pages. */
function tab(
	skills: Skill[] = [skill('obsidian-markdown'), skill('note-summary')],
	providers: ProviderConfig[] = [],
) {
	const settings = mergeSettings({ providers });
	const permissions = new ToolPermissionManager(
		() => settings,
		async () => {},
	);
	permissions.attachExtras(
		() => [SHELL_GROUP, ...skillGroups(skills)],
		() => new Set(),
	);
	const plugin = {
		settings,
		permissions,
		skills: { skills, diagnostics: [] },
		agentDefs: { agents: [...BUILT_IN_AGENTS], diagnostics: [] },
		mcp: { state: () => ({ status: 'disconnected', tools: [] }) },
		providers: { listSelectable: () => [] },
		secrets: { get: () => null },
		registry: {
			entries: () =>
				[
					['ls', 'List folder'],
					['write', 'Write note'],
					['bash', 'Shell'],
				].map(([name, label]) => ({ tool: { name, label } })),
		},
		sessions: { sessionsDir: '.obsidian/plugins/vault-librarian/sessions' },
		hub: { shownIds: () => new Set<string>() },
		toolExecutionOf: () => 'parallel',
		toolDeferredOf: () => true,
	} as unknown as LibrarianPlugin;
	const app = { vault: { getFileByPath: () => null } } as unknown as App;
	const settingTab = new LibrarianSettingTab(app, plugin);
	return settingTab.getSettingDefinitions() as unknown as Page[];
}

const page = (pages: Page[], name: string) => pages.find((p) => p.name === name)!;
const rows = (p: Page) => p.items.flatMap((s) => s.items ?? []);

describe('settings pages', () => {
	it('LIB-TEST-207: ten pages in order, each with a one-line description', () => {
		const pages = tab();
		expect(pages.map((p) => p.name)).toEqual([
			'Providers',
			'Agent',
			'MCP servers',
			'WebDAV storage',
			// Keys and sign-ins for other devices (LIB-FEAT-233).
			'Device sync',
			'Skills',
			// Agent definitions and their permissions (LIB-FEAT-268).
			'Sub-agents',
			'Tool permissions',
			'Context',
			'Sessions',
		]);
		expect(pages.every((p) => p.type === 'page' && (p.desc ?? '').length > 0)).toBe(true);
	});

	it('LIB-TEST-207: settings search finds rows by name, description and alias', () => {
		const all = tab(undefined, [newProvider('Local server')]).flatMap(rows);
		const text = (r: Row) =>
			[r.name, typeof r.desc === 'string' ? r.desc : '', ...(r.aliases ?? [])].join('\n');
		for (const query of [
			'API key',
			'Default model',
			'Use AGENTS.md',
			'Custom system prompt',
			'write',
			'Compact at',
			'NAS',
			'Rewind',
			'obsidian-markdown',
			// A settings backup to carry to another device (LIB-TEST-242).
			'Export settings',
			'Restore',
		])
			expect(all.some((r) => text(r).includes(query))).toBe(true);
	});

	it('LIB-TEST-207: skills are set on the Skills page, not under Tool permissions', () => {
		const pages = tab();
		const skills = page(pages, 'Skills');
		expect(rows(skills).map((r) => r.name)).toEqual([
			'All skills',
			'Listing',
			'obsidian-markdown',
			'note-summary',
		]);
		const permissions = page(pages, 'Tool permissions');
		expect(permissions.items.map((s) => s.heading)).toEqual([
			undefined,
			'Read-only tools',
			'Write tools',
			'Commands',
		]);
		expect(rows(permissions).some((r) => r.name.startsWith('skill:'))).toBe(false);
		expect(skills.displayValue).toBe('2 skills');
	});

	it('LIB-TEST-207: a tool row is named by its card label and carries its ID', () => {
		const permissions = page(tab(), 'Tool permissions');
		const write = permissions.items.find((s) => s.heading === 'Write tools')!;
		expect(write.items!.map((r) => [r.name, r.desc])).toEqual([
			['Set all', 'They change notes in the vault. A new install asks first.'],
			['Write note', 'write'],
			// A tool with no label known yet keeps its ID as its name.
			['edit', ''],
		]);
	});

	it('LIB-TEST-266: the Agent page puts the Custom system prompt above AGENTS.md', () => {
		const agent = page(tab(), 'Agent');
		expect(agent.items.map((s) => s.heading)).toEqual(['Agent loop', 'Instructions', 'Chat']);
		const instructions = agent.items.find((s) => s.heading === 'Instructions')!;
		expect(instructions.items!.map((r) => r.name)).toEqual([
			'Custom system prompt',
			'Use AGENTS.md',
		]);
	});

	it('LIB-TEST-270: the Sub-agents page holds the limit, every agent and its permission', () => {
		const agents = page(tab(), 'Sub-agents');
		expect(rows(agents).map((r) => r.name)).toEqual([
			'Max sub-agents',
			'All agents',
			'general-purpose',
			'explore',
		]);
		expect(agents.displayValue).toBe('2 agents');
		// Its permissions are set here, not under Tool permissions.
		const permissions = page(tab(), 'Tool permissions');
		expect(permissions.items.map((s) => s.heading)).not.toContain('Sub-agents');
	});

	it('LIB-TEST-266: a pre-2.15.0 custom prompt becomes the default with it added, and the default is not stored', () => {
		const old = mergeSettings({ customSystemPrompt: '  Be brief.  ' });
		expect(old.systemPrompt).toBe(`${DEFAULT_SYSTEM_PROMPT}\n\nBe brief.`);
		expect('customSystemPrompt' in old).toBe(false);
		expect(mergeSettings({ customSystemPrompt: '' }).systemPrompt).toBeUndefined();
		expect(mergeSettings({}).systemPrompt).toBeUndefined();
		// A prompt the user cleared stays cleared.
		expect(mergeSettings({ systemPrompt: '', customSystemPrompt: 'x' }).systemPrompt).toBe('');
		expect(systemPromptOf(mergeSettings({}))).toBe(DEFAULT_SYSTEM_PROMPT);
		expect(mergeSettings({}).maxSubagents).toBe(3);
	});

	it('LIB-TEST-207: lists offer their add action and an empty state', () => {
		const pages = tab([]);
		const providers = page(pages, 'Providers');
		const list = providers.items.find((s) => s.type === 'list')!;
		expect(list.addItem?.name).toBe('Add provider');
		expect(list.items).toEqual([]);
		expect(String(list.emptyState)).toContain('OpenAI-compatible');
		expect(page(pages, 'MCP servers').items[0]!.addItem?.name).toBe('Add server');
		// Without skills the Skills page is the empty list and its Rescan button.
		const skills = page(pages, 'Skills');
		expect(skills.items).toHaveLength(1);
		expect(String(skills.items[0]!.emptyState)).toContain('.agents/skills');
	});
});
