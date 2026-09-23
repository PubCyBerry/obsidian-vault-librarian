import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');

describe('bundle and manifest (LIB-TEST-076)', () => {
	it('manifest targets mobile and the SecretStorage baseline', () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'),
		) as Record<string, unknown>;
		expect(manifest.isDesktopOnly).toBe(false);
		expect(manifest.minAppVersion).toBe('1.11.5');
		expect(manifest.id).toBe('vault-librarian');
	});

	it('main.js carries no Node or Electron module references', () => {
		const file = path.join(root, 'main.js');
		if (!fs.existsSync(file)) throw new Error('Run npm run build before the tests.');
		const bundle = fs.readFileSync(file, 'utf8');
		const requires = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
		expect(new Set(requires)).toEqual(new Set(['obsidian']));
		expect(bundle).not.toMatch(/require\("node:/);
		expect(bundle).not.toMatch(/from"node:/);
		expect(bundle).not.toMatch(/require\("electron"\)/);
		// The shell's own hardening names child_process in the reason it refuses
		// process.getBuiltinModule, so the word appears inside a sentence. What must not appear is
		// that name as a module specifier, which is how it would actually be loaded.
		expect(bundle).not.toMatch(/["'`]child_process["'`]/);
	});
});
