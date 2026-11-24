import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	checkPath,
	isAgentsPath,
	isBinaryPath,
	isHiddenPath,
	isReadOnlyPath,
	isSkillsPath,
} from '../src/tools/path-policy';

fc.configureGlobal({ numRuns: Number(process.env.FC_NUM_RUNS) || 100 });

const opts = { configDir: '.obsidian' };

describe('checkPath', () => {
	it('refuses a path that starts outside the vault, and only where it starts', () => {
		for (const path of ['~/notes.md', '\\\\server\\share', 'c:\\x.md', ' /etc/passwd'])
			expect(() => checkPath(path, opts)).toThrow(/Absolute/);
		// fast-check found these passing: the "." part in front is dropped after the check.
		for (const path of ['./C:/x.md', './~/notes.md', '.\\c:\\x.md'])
			expect(() => checkPath(path, opts)).toThrow(/Absolute/);
		// The same characters inside a name are a name.
		expect(checkPath('notes/a~b.md', opts)).toBe('notes/a~b.md');
		expect(checkPath('notes/C:/x.md', opts)).toBe('notes/C:/x.md');
	});

	it('refuses a parent folder however it is written', () => {
		for (const path of ['notes/../x.md', 'notes\\..\\x.md', 'notes/..'])
			expect(() => checkPath(path, opts)).toThrow(/traversal/);
		// Two dots inside a name are not the parent folder.
		expect(checkPath('notes/a..b.md', opts)).toBe('notes/a..b.md');
	});

	it('drops spaces around the path and the `.` parts in it', () => {
		expect(checkPath('  ./notes/./a.md ', opts)).toBe('notes/a.md');
	});

	it('refuses a part of spaces alone, which fast-check found passing as " "', () => {
		for (const path of ['./ /.', 'notes/ /a.md', 'notes/\t'.concat('/a.md')])
			expect(() => checkPath(path, opts)).toThrow(/blank/);
		// A space inside a name is part of the name.
		expect(checkPath('my notes/ a.md', opts)).toBe('my notes/ a.md');
	});

	it('takes the vault root only where it is allowed', () => {
		for (const root of ['', '.', './', '  ']) {
			expect(() => checkPath(root, opts)).toThrow('path must not be empty');
			expect(checkPath(root, { ...opts, allowRoot: true })).toBe('');
		}
		expect(checkPath('notes', { ...opts, allowRoot: true })).toBe('notes');
	});

	it('refuses what is not a string', () => {
		expect(() => checkPath(42 as unknown as string, opts)).toThrow('path must be a string');
	});

	const part = fc.oneof(
		fc.constantFrom('.', '..', '', ' ', 'notes', '.obsidian', 'a.md', '~', 'C:'),
		fc.string({ maxLength: 6 }),
	);
	const raw = fc
		.tuple(fc.array(part, { maxLength: 6 }), fc.constantFrom('/', '\\'))
		.map(([parts, sep]) => parts.join(sep));

	it('gives a path inside the vault, or refuses: never a parent, an empty part or a root', () => {
		fc.assert(
			fc.property(raw, fc.boolean(), (path, allowRoot) => {
				let out: string;
				try {
					out = checkPath(path, { ...opts, allowRoot });
				} catch {
					return;
				}
				if (out === '') {
					expect(allowRoot).toBe(true);
					return;
				}
				for (const segment of out.split('/'))
					expect(['', '.', '..']).not.toContain(segment);
				expect(out).not.toMatch(/^[\\/~]|^[a-zA-Z]:\/|\\/);
				// A path that passed is one the tools take again.
				expect(() => checkPath(out, opts)).not.toThrow();
			}),
		);
	});

	it('refuses every path with a parent part in it', () => {
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom('notes', 'a.md', '.', '.agents'), { maxLength: 4 }),
				fc.nat(4),
				fc.constantFrom('/', '\\'),
				(parts, at, sep) => {
					const withParent = [...parts.slice(0, at), '..', ...parts.slice(at)];
					expect(() => checkPath(withParent.join(sep), opts)).toThrow(/traversal/);
				},
			),
		);
	});
});

describe('hidden and writable places', () => {
	it('takes the config folder by name whatever its case, also after a leading slash', () => {
		expect(isHiddenPath('Config/app.json', 'config')).toBe(true);
		expect(isHiddenPath('/config/app.json', 'config')).toBe(true);
		expect(isHiddenPath('notes/config/app.json', 'config')).toBe(false);
		expect(isHiddenPath('', 'config')).toBe(false);
	});

	it('keeps everything under the config folder read-only', () => {
		const name = fc.stringMatching(/^[a-z]{1,6}$/);
		fc.assert(
			fc.property(fc.array(name, { minLength: 1, maxLength: 4 }), (rest) => {
				expect(isReadOnlyPath(`.obsidian/${rest.join('/')}`, '.obsidian')).toBe(true);
				expect(isReadOnlyPath(`config/${rest.join('/')}`, 'config')).toBe(true);
				expect(isReadOnlyPath(`notes/${rest.join('/')}`, '.obsidian')).toBe(false);
			}),
		);
	});

	it('knows the sub-agent definitions, and `.agents` on the way to them', () => {
		for (const path of ['.agents', '.agents/agents', '.agents/agents/reviewer.md'])
			expect(isAgentsPath(path)).toBe(true);
		for (const path of ['.agents/agentsx', '.agents/other', 'notes/.agents/agents', 'agents'])
			expect(isAgentsPath(path)).toBe(false);
	});

	it('takes no path without an `.agents` folder for a skills path', () => {
		for (const path of ['skills', 'skills/x/SKILL.md', 'notes/skills', ''])
			expect(isSkillsPath(path)).toBe(false);
	});
});

describe('isBinaryPath', () => {
	it('goes by the extension, whatever its case, and needs a dot before it', () => {
		expect(isBinaryPath('assets/photo.PNG')).toBe(true);
		expect(isBinaryPath('notes/a.md')).toBe(false);
		expect(isBinaryPath('png')).toBe(false);
		expect(isBinaryPath('archive.tar.gz')).toBe(true);
	});
});
