import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { pendingMutationPaths, withFileMutationQueue } from '../src/tools/mutation-queue';
import { createVaultTools } from '../src/tools/registry';
import { mergeSettings } from '../src/types';
import { FakeApp } from './fake-app';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('file mutation queue (LIB-TEST-134)', () => {
	it('runs calls on the same path one after another and calls on other paths alongside', async () => {
		const log: string[] = [];
		const job = (name: string, path: string, ticks: number) =>
			withFileMutationQueue(path, async () => {
				log.push(`${name} start`);
				for (let i = 0; i < ticks; i++) await tick();
				log.push(`${name} end`);
			});
		await Promise.all([
			job('a1', 'Notes/A.md', 3),
			job('a2', 'notes/a.md', 1),
			job('b', 'B.md', 1),
		]);
		expect(log).toEqual(['a1 start', 'b start', 'b end', 'a1 end', 'a2 start', 'a2 end']);
		expect(pendingMutationPaths()).toBe(0);
	});

	it('releases the path when the job throws', async () => {
		await expect(
			withFileMutationQueue('x.md', async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		let ran = false;
		await withFileMutationQueue('x.md', async () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});

	it('keeps the snapshot hooks inside the section for parallel writes to one note', async () => {
		const app = new FakeApp();
		app.vault.seed('n.md', 'v0');
		const seen: string[] = [];
		const tools = createVaultTools({
			app: app as unknown as App,
			settings: () => mergeSettings({}),
			mutation: {
				before: async (id) => {
					seen.push(`${id} before ${app.vault.text('n.md')}`);
					await tick();
				},
				after: async (id) => {
					seen.push(`${id} after ${app.vault.text('n.md')}`);
				},
			},
		});
		const write = tools.find((t) => t.name === 'write')!;
		await Promise.all([
			write.execute(
				'w1',
				{ path: 'n.md', content: 'v1', overwrite: true } as never,
				undefined,
			),
			write.execute(
				'w2',
				{ path: 'n.md', content: 'v2', overwrite: true } as never,
				undefined,
			),
		]);
		expect(seen).toEqual(['w1 before v0', 'w1 after v1', 'w2 before v1', 'w2 after v2']);
		expect(app.vault.text('n.md')).toBe('v2');
	});
});

describe('tool execution settings (LIB-TEST-134)', () => {
	it('defaults to parallel and carries the old per-provider flag over', () => {
		expect(mergeSettings({}).toolExecution).toBe('parallel');
		expect(mergeSettings({}).toolExecutionByTool).toEqual({});
		const legacy = mergeSettings({
			providers: [{ id: 'p', requestDefaults: { parallelReadTools: false } }],
		});
		expect(legacy.toolExecution).toBe('sequential');
		expect(mergeSettings({ toolExecution: 'sequential' }).toolExecution).toBe('sequential');
	});
});
