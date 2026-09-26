import type { App } from 'obsidian';
import { beforeEach, describe, expect, it } from 'vitest';
import { PromptManager } from '../src/agent/prompt';
import { alwaysAsksFor, ToolPermissionManager } from '../src/permissions/tool-permission-manager';
import {
	catalogOf,
	createSkillSearchTool,
	parseSkillMd,
	SKILLS_AUTHORING,
	type Skill,
	SkillManager,
	skillGroups,
	skillKey,
	skillNameProblem,
	skillsSection,
	skillText,
	withDescription,
} from '../src/skills/skill-manager';
import { isReadOnlyPath, isSkillsPath } from '../src/tools/path-policy';
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
			systemPrompt: 'built-in',
			vaultAgentsMd: null,
			skillCatalog: skillsSection(skills.skills, []),
		});
		expect(prompt).toContain('# Skills');
		expect(prompt).toContain('call read with the path of its SKILL.md');
		expect(prompt).toContain(catalog);
		expect(prompt).not.toContain('skill_search');
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

	it('LIB-TEST-190: names deferred skills in the prompt and finds them with skill_search', async () => {
		const [pdf, meeting] = skills.skills as [Skill, Skill];
		const deferredOnly = skillsSection([], [pdf, meeting]);
		expect(deferredOnly).toContain('known by name only: pdf-processing, meeting-notes.');
		expect(deferredOnly).toContain('skill_search');
		expect(deferredOnly).not.toContain('<available_skills>');
		expect(deferredOnly).not.toContain(meeting.description);
		const mixed = skillsSection([pdf], [meeting]);
		expect(mixed).toContain('<name>pdf-processing</name>');
		expect(mixed).toContain('known by name only: meeting-notes.');
		// With no skill to use, the section still says how to make one (LIB-TEST-284).
		expect(skillsSection([], [])).toBe(SKILLS_AUTHORING);
		expect(mixed.endsWith(SKILLS_AUTHORING)).toBe(true);

		const search = createSkillSearchTool(skills.skills);
		expect(search.description).toContain('- .agents/skills: 1 skill');
		expect(search.description).toContain('- 10-projects/alpha/.agents/skills: 1 skill');
		const run = async (query: string) =>
			JSON.parse(
				(await search.execute('id', { query } as never, undefined)).content[0]!.text,
			) as {
				matches: { name: string; location: string }[];
				note?: string;
				hint?: string;
			};
		const found = await run('summarize meeting notes');
		expect(found.matches[0]).toMatchObject({
			name: 'meeting-notes',
			location: '10-projects/alpha/.agents/skills/meeting-notes/SKILL.md',
		});
		expect(found.note).toContain('Read the SKILL.md');
		expect((await run('extract pdf text')).matches[0]!.name).toBe('pdf-processing');
		expect((await run('회의록 요약')).hint).toContain('English');
		const none = await run('weather');
		expect(none.matches).toEqual([]);
		expect(none.hint).toBeUndefined();
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

describe('skill files made and changed (LIB-TEST-284)', () => {
	it('opens the skills folders where the scan looks to writing, and asks for every change', () => {
		for (const path of [
			'.agents/skills/x/SKILL.md',
			'.agents/skills',
			'.agents',
			'a/b/c/.agents/skills/x/references/r.md',
			'a/.agents',
		])
			expect([path, isSkillsPath(path), isReadOnlyPath(path, '.obsidian')]).toEqual([
				path,
				true,
				false,
			]);
		for (const path of [
			'a/b/c/d/.agents/skills/x/SKILL.md',
			'.obsidian/.agents/skills/x/SKILL.md',
			'.agents/other/x.md',
			'a/.agents/other',
		])
			expect([path, isSkillsPath(path), isReadOnlyPath(path, '.obsidian')]).toEqual([
				path,
				false,
				true,
			]);
		expect(alwaysAsksFor('./.agents/skills/x/SKILL.md')).toBe(
			'Changes to skills always ask first.',
		);
		expect(alwaysAsksFor('a/.agents/skills/x/scripts/run.sh')).toBe(
			'Changes to skills always ask first.',
		);
		expect(alwaysAsksFor('.agents/agents/x.md')).toBe(
			'Changes to sub-agent definitions always ask first.',
		);
		expect(alwaysAsksFor('notes/SKILL.md')).toBeNull();
		const settings = mergeSettings({});
		settings.toolPermissions.byTool.write = 'always_allow';
		const perms = new ToolPermissionManager(
			() => settings,
			async () => undefined,
		);
		expect(perms.resolve('write', { path: '.agents/skills/x/SKILL.md' })).toBe(
			'approval_required',
		);
		expect(perms.resolve('write', { path: 'notes/x.md' })).toBe('always_allow');
	});

	it('checks a new name by the Agent Skills rules', () => {
		expect(skillNameProblem('tidy-notes')).toBeNull();
		expect(skillNameProblem('')).toBe('Name is required.');
		for (const bad of ['Tidy', 'tidy--notes', '-tidy', 'tidy notes', 'tidy_notes'])
			expect(skillNameProblem(bad)).toBe('Use lowercase letters, digits and single hyphens.');
		expect(skillNameProblem('a'.repeat(65))).toBe('Name is longer than 64 characters.');
	});

	it('creates a skill in the root folder that reads back the same, and refuses a taken name', async () => {
		const description = 'Tidies notes: headings, lists and "quotes". Use when asked to tidy.';
		await skills.create('tidy-notes', description, '  # Tidy\n\nDo it.\n\n');
		const made = app.vault.text('.agents/skills/tidy-notes/SKILL.md')!;
		expect(made).toBe(skillText('tidy-notes', description, '# Tidy\n\nDo it.'));
		expect(made).toBe(
			`---\nname: tidy-notes\ndescription: ${JSON.stringify(description)}\n---\n\n# Tidy\n\nDo it.\n`,
		);
		expect(skills.get('tidy-notes')).toMatchObject({ description, warnings: [] });
		await expect(skills.create('tidy-notes', 'again', '')).rejects.toThrow('already exists');
		// A name used by a skill in a folder is taken too.
		await expect(skills.create('meeting-notes', 'again', '')).rejects.toThrow('already exists');
		expect(skillText('bare', 'Bare.', '   ')).toBe(
			'---\nname: bare\ndescription: "Bare."\n---\n',
		);
	});

	it('updates the description and the instructions and keeps every other line of the frontmatter', async () => {
		const location = '.agents/skills/pdf-processing/SKILL.md';
		const original = app.vault.text(location)!;
		const pdf = skills.get('pdf-processing')!;
		await skills.update(pdf, 'Reads PDFs: text and tables.', 'New steps.', original);
		expect(app.vault.text(location)).toBe(
			'---\nname: pdf-processing\ndescription: "Reads PDFs: text and tables."\nmetadata:\n  version: "1.0"\n---\n\nNew steps.\n',
		);
		expect(skills.get('pdf-processing')!.description).toBe('Reads PDFs: text and tables.');
		// Unchanged description: the frontmatter stays byte for byte, comments included.
		const commented = '---\n# keep me\nname: pdf-processing\ndescription: Same.\n---\nOld.\n';
		app.vault.seed(location, commented);
		await skills.scan();
		await skills.update(skills.get('pdf-processing')!, 'Same.', 'Body.', commented);
		expect(app.vault.text(location)).toBe(
			'---\n# keep me\nname: pdf-processing\ndescription: Same.\n---\n\nBody.\n',
		);
		// A file changed since the editor read it is left alone.
		await expect(
			skills.update(skills.get('pdf-processing')!, 'Other.', 'x', commented),
		).rejects.toThrow('changed while it was open');
		// Windows line ends stay Windows line ends.
		const crlf =
			'---\r\nname: pdf-processing\r\ndescription: Old.\r\nlicense: MIT\r\n---\r\nA\r\n';
		app.vault.seed(location, crlf);
		await skills.scan();
		await skills.update(skills.get('pdf-processing')!, 'New.', 'B', crlf);
		expect(app.vault.text(location)).toBe(
			'---\r\nname: pdf-processing\r\ndescription: "New."\r\nlicense: MIT\r\n---\r\n\r\nB\r\n',
		);
	});

	it('replaces a folded description with the lines it runs on', () => {
		const yaml =
			'name: x\ndescription: >-\n  line one\n\n  line two\nlicense: MIT\nmetadata:\n  a: b';
		expect(withDescription(yaml, 'One line.')).toBe(
			'name: x\ndescription: "One line."\nlicense: MIT\nmetadata:\n  a: b',
		);
		expect(withDescription('name: x', 'Added.')).toBe('name: x\ndescription: "Added."');
	});

	it('moves a deleted skill folder, references too, to the trash', async () => {
		await skills.remove(skills.get('pdf-processing')!);
		expect(app.vault.text('.agents/skills/pdf-processing/SKILL.md')).toBeUndefined();
		expect(
			app.vault.text('.agents/skills/pdf-processing/references/REFERENCE.md'),
		).toBeUndefined();
		expect(await app.vault.adapter.exists('.agents/skills/pdf-processing')).toBe(false);
		// The copy in a folder that it shadowed now counts.
		expect(skills.get('pdf-processing')!.location).toBe(
			'10-projects/alpha/.agents/skills/pdf-processing/SKILL.md',
		);
	});

	it('describes what a written file in a skills folder makes, or why nothing', async () => {
		app.vault.seed(
			'.agents/skills/good/SKILL.md',
			'---\nname: Good\ndescription: Fine.\n---\n',
		);
		app.vault.seed('.agents/skills/nodesc/SKILL.md', '---\nname: nodesc\n---\n');
		await skills.scan();
		expect(skills.describe('.agents/skills/good/SKILL.md')).toEqual({
			skill: {
				name: 'Good',
				warnings: [
					'Name "Good" is not lowercase letters, digits and single hyphens',
					'Name "Good" differs from the folder name',
				],
			},
		});
		expect(skills.describe('.agents/skills/pdf-processing/SKILL.md')).toEqual({
			skill: { name: 'pdf-processing' },
		});
		expect(skills.describe('.agents/skills/nodesc/SKILL.md')).toEqual({
			skillProblem: 'Missing description',
		});
		expect(skills.describe('10-projects/alpha/.agents/skills/pdf-processing/SKILL.md')).toEqual(
			{
				skillProblem: 'Shadowed by .agents/skills/pdf-processing/SKILL.md',
			},
		);
		expect(skills.describe('10-projects/alpha/.agents/skills/loose.md')).toEqual({
			skillProblem:
				'A skill is a folder: write 10-projects/alpha/.agents/skills/<name>/SKILL.md',
		});
		expect(skills.describe('.agents/skills/pdf-processing/references/REFERENCE.md')).toBeNull();
		expect(skills.describe('notes/SKILL.md')).toBeNull();
	});
});
