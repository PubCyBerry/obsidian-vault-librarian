import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'commitlint.config.mjs',
		'vitest.config.mts',
		'tests',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			// Example addresses and IDs shown as placeholders are not sentences.
			'obsidianmd/ui/sentence-case': [
				'warn',
				{
					enforceCamelCaseLower: true,
					ignoreRegex: ['^https?://', '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$'],
				},
			],
		},
	},
);
