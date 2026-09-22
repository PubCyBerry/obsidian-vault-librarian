import type { App } from 'obsidian';
import { beforeEach, describe, expect, it } from 'vitest';
import { PromptManager } from '../src/agent/prompt';
import { ToolPermissionManager } from '../src/permissions/tool-permission-manager';
import {
	catalogOf,
	parseSkillMd,
	SkillManager,
	skillGroups,
	skillKey,
} from '../src/skills/skill-manager';
import { createVaultTools } from '../src/tools/registry';
import { mergeSettings } from '../src/types';
import { FakeApp } from './fake-app';

const PDF = `---
name: pdf-processing
description: Extract text from PDFs. Use when the user mentions PDFs.
metadata:
  version: "1.0"
---

# PDF processing

Read references/REFERENCE.md first.
`;

let app: FakeApp;
let skills: SkillManager;

beforeEach(async () => {
	app = new FakeApp();
	app.vault.seed('AGENTS.md', 'root rules');
	app.vault.seed('.agents/skills/pdf-processing/SKILL.md', PDF);
	app.vault.seed('.agents/skills/pdf-processing/references/REFERENCE.md', 'deep reference');
	app.vault.seed('.agents/skills/broken/SKILL.md', '---\nname: broken\n---\nno description');
	app.vault.seed(
		'10-projects/alpha/.agents/skills/pdf-processing/SKILL.md',
		'---\nname: pdf-processing\ndescription: shadowed copy\n---\n',
	);
	app.vault.seed(
		'10-projects/alpha/.agents/skills/meeting-notes/SKILL.md',
		'---\ndescription: Summarize meetings. Use when: notes of a meeting are pasted\n---\nBody',
	);
	app.vault.seed('10-projects/alpha/plan.md', 'plan');
	skills = new SkillManager(app as unknown as App);
	await skills.scan();
});

describe('skills (LIB-TEST-123)', () => {
	it('parses frontmatter leniently: name falls back to the folder, missing description skips', () => {
		expect(parseSkillMd(PDF, '.agents/skills/pdf-processing').skill).toMatchObject({
			name: 'pdf-processing',
			location: '.agents/skills/pdf-processing/SKILL.md',
			warnings: [],
		});
		const mismatch = parseSkillMd('---\nname: Other\ndescription: x\n---\n', 'a/b/other');
		expect(mismatch.skill?.name).toBe('Other');
		expect(mismatch.skill?.warnings.length).toBe(2);
		expect(parseSkillMd('---\nname: x\n---\n', 'x').error).toBe('Missing description');
		expect(parseSkillMd('no frontmatter', 'x').error).toBe('No frontmatter');
	});

	it('finds .agents/skills at the root and inside folders; the root wins a name clash', () => {
		expect(skills.skills.map((s) => s.name)).toEqual(['pdf-processing', 'meeting-notes']);
		expect(skills.get('meeting-notes')?.description).toBe(
			'Summarize meetings. Use when: notes of a meeting are pasted',
		);
		expect(skills.diagnostics.map((d) => d.message)).toEqual([
			'Missing description',
			'Shadowed by .agents/skills/pdf-processing/SKILL.md',
		]);
		expect(skills.skillFor('.agents/skills/pdf-processing/references/REFERENCE.md')?.name).toBe(
			'pdf-processing',
		);
		expect(skills.skillFor('10-projects/alpha/plan.md')).toBeNull();
	});

	it('puts name, description and location in the catalog and the prompt', () => {
		const catalog = catalogOf(skills.skills);
		expect(catalog).toContain('<name>pdf-processing</name>');
		expect(catalog).toContain(
			'<location>10-projects/alpha/.agents/skills/meeting-notes/SKILL.md</location>',
		);
		expect(catalogOf([])).toBe('');
		const prompt = new PromptManager(app as unknown as App).buildSystemPrompt({
			builtIn: 'built-in',
			vaultAgentsMd: null,
			customSystemPrompt: '',
			skillCatalog: catalog,
		});
		expect(prompt).toContain('# Skills');
		expect(prompt).toContain('call read with the SKILL.md path');
		expect(skillGroups(skills.skills)[0]?.tools).toEqual([
			'skill:pdf-processing',
			'skill:meeting-notes',
		]);
		expect(skillGroups([])).toEqual([]);
	});

	it('judges a read inside a skill folder by the skill permission, not by read', async () => {
		const settings = mergeSettings({});
		const perms = new ToolPermissionManager(
			() => settings,
			async () => undefined,
		);
		perms.attachExtras(
			() => skillGroups(skills.skills),
			() => new Set(),
			(tool, args) => {
				const path = (args as { path?: string }).path;
				const skill = tool === 'read' && path ? skills.skillFor(path) : null;
				return skill ? skillKey(skill.name) : null;
			},
		);
		const inSkill = { path: '.agents/skills/pdf-processing/SKILL.md' };
		await perms.setTool('read', 'always_allow');
		expect(perms.resolve('read', inSkill)).toBe('approval_required');
		expect(perms.resolve('read', { path: '10-projects/alpha/plan.md' })).toBe('always_allow');
		expect(perms.permissionKey('read', inSkill)).toBe('skill:pdf-processing');
		await perms.setTool('skill:pdf-processing', 'blocked');
		expect(perms.resolve('read', inSkill)).toBe('blocked');
		await perms.setTool('read', 'approval_required');
		await perms.setTool('skill:pdf-processing', 'always_allow');
		expect(perms.resolve('read', inSkill)).toBe('always_allow');
	});

	it('lets read open skill files the index does not list and names the resources', async () => {
		const tools = createVaultTools({
			app: app as unknown as App,
			settings: () => mergeSettings({}),
			hidden: skills.hiddenReader(),
		});
		const read = tools.find((t) => t.name === 'read')!;
		const run = async (path: string) =>
			JSON.parse(
				(await read.execute('id', { path } as never, undefined)).content[0]!.text,
			) as Record<string, unknown>;
		const result = await run('.agents/skills/pdf-processing/SKILL.md');
		expect((result.lines as { text: string }[])[1]!.text).toBe('name: pdf-processing');
		expect(result.skillDir).toBe('.agents/skills/pdf-processing');
		expect(result.resources).toEqual(['references/REFERENCE.md']);
		const ref = await run('.agents/skills/pdf-processing/references/REFERENCE.md');
		expect((ref.lines as { text: string }[])[0]!.text).toBe('deep reference');
		expect(ref.skillDir).toBeUndefined();
		await expect(run('.agents/other/x.md')).rejects.toThrow('File not found');
	});

	it('wraps the body for /skill with the directory and the resource list', async () => {
		const text = await skills.activation(skills.get('pdf-processing')!);
		expect(text.startsWith('<skill_content name="pdf-processing">\n# PDF processing')).toBe(
			true,
		);
		expect(text).toContain('Skill directory: .agents/skills/pdf-processing');
		expect(text).toContain('<file>references/REFERENCE.md</file>');
		expect(text.endsWith('</skill_content>')).toBe(true);
	});
});
