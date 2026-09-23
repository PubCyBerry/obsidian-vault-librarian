import type { App, SettingDefinitionRender } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type LibrarianPlugin from '../src/main';
import { LibrarianSettingTab } from '../src/settings/settings-tab';

describe('settings search', () => {
	it('indexes all sections without rendering UI, and renders the matching section on demand', () => {
		const tab = new LibrarianSettingTab({} as App, {} as LibrarianPlugin);
		const pages = tab.getSettingDefinitions() as {
			name: string;
			desc?: string;
			items: SettingDefinitionRender[];
		}[];
		const definitions = pages.map((page) => page.items[0]!);
		expect(pages.map((page) => page.name)).toEqual([
			'Providers',
			'Agent',
			'MCP servers',
			'WebDAV storage',
			'Skills',
			'Tool permissions',
			'Context',
			'Sessions',
		]);
		for (const query of [
			'API key',
			'Default model',
			'AGENTS.md',
			'write',
			'Compact at',
			'Rewind',
			'NAS',
		]) {
			expect(definitions.some((definition) => definition.aliases?.includes(query))).toBe(
				true,
			);
		}
		const renderContext = vi.fn();
		Object.assign(tab, { renderContext });
		const element = { empty: vi.fn(), addClass: vi.fn() };
		// Every page carries a one-line description on its navigable entry.
		expect(pages.every((page) => (page.desc ?? '').length > 0)).toBe(true);
		const definition = definitions.find((item) => item.name === 'Context')!;
		definition.render({ settingEl: element } as never, {} as never);
		expect(renderContext).toHaveBeenCalledWith(element);
	});
});
