import type { App, SettingDefinitionRender } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type LibrarianPlugin from '../src/main';
import { LibrarianSettingTab } from '../src/settings/settings-tab';

describe('settings search', () => {
	it('indexes all sections without rendering UI, and renders the matching section on demand', () => {
		const tab = new LibrarianSettingTab({} as App, {} as LibrarianPlugin);
		const definitions = tab.getSettingDefinitions() as SettingDefinitionRender[];
		expect(definitions.map((definition) => definition.name)).toEqual([
			'Providers',
			'Agent',
			'MCP servers',
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
		]) {
			expect(definitions.some((definition) => definition.aliases?.includes(query))).toBe(
				true,
			);
		}
		const renderContext = vi.fn();
		Object.assign(tab, { renderContext });
		const element = { empty: vi.fn(), addClass: vi.fn() };
		const definition = definitions.find((item) => item.name === 'Context')!;
		definition.render({ settingEl: element } as never, {} as never);
		expect(renderContext).toHaveBeenCalledWith(element);
	});
});
