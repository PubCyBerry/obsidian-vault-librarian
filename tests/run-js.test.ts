import { describe, expect, it } from 'vitest';
import { createRunJsTool, type NestedCall } from '../src/script/run-js';

type Host = (
	args: Record<string, unknown>,
	onWaiting: (waiting: boolean) => void,
) => Promise<NestedCall>;

function runJs(hosts: Record<string, Host>) {
	const calls: { id: string; name: string; args: unknown }[] = [];
	const tool = createRunJsTool({
		toolNames: () => [...Object.keys(hosts), 'run_js', 'tool_search'],
		callTool: async (id, name, args, _signal, onWaiting) => {
			calls.push({ id, name, args });
			return hosts[name]!(args as Record<string, unknown>, onWaiting);
		},
	});
	const run = async (code: string, opts: { timeout?: number; signal?: AbortSignal } = {}) => {
		try {
			const r = await tool.execute(
				'call-1',
				{ code, ...(opts.timeout ? { timeout: opts.timeout } : {}) } as never,
				opts.signal,
			);
			return { ok: true, text: (r.content[0] as { text: string }).text };
		} catch (error) {
			return { ok: false, text: (error as Error).message };
		}
	};
	return { calls, run };
}

const okText = (value: unknown): NestedCall => ({ text: JSON.stringify(value), status: 'ok' });

describe('run_js sandbox (LIB-TEST-169)', () => {
	it('has no network, app, module loader or window, only tools and console', async () => {
		const { run } = runJs({});
		const r = await run(
			'return [typeof fetch, typeof XMLHttpRequest, typeof app, typeof require, typeof window, typeof tools, typeof console].join()',
		);
		expect(r).toEqual({
			ok: true,
			text: 'Returned: "undefined,undefined,undefined,undefined,undefined,object,object"',
		});
	});

	it('calls tools with parsed results, keeps console output and reports every call', async () => {
		const h = runJs({
			read: async (args) =>
				okText({ path: args.path, lines: [{ line: 1, text: 'alpha' }], totalLines: 2 }),
			write: async () => okText({ operation: 'created' }),
		});
		const r = await h.run(`
			const note = await tools.read({ path: 'notes/a.md' });
			console.log('lines', note.totalLines);
			console.warn('careful');
			const [a, b] = await Promise.all([tools.read({ path: 'x' }), tools.read({ path: 'y' })]);
			await tools.write({ path: 'b.md', content: a.path + b.path });
			return note.lines[0].text;
		`);
		expect(r.ok).toBe(true);
		expect(r.text).toBe(
			'lines 2\n[warn] careful\nReturned: "alpha"\nTool calls: read ok, read ok, read ok, write ok',
		);
		expect(h.calls.map((c) => c.id)).toEqual(['call-1/1', 'call-1/2', 'call-1/3', 'call-1/4']);
		expect(h.calls[3]!.args).toEqual({ path: 'b.md', content: 'xy' });
	});

	it('turns a refused call into an exception the script may catch', async () => {
		const h = runJs({
			write: async () => ({ text: 'Tool blocked by settings', status: 'blocked' }),
		});
		const caught = await h.run(
			"try { await tools.write({ path: 'b.md', content: 'x' }); } catch (e) { return 'caught ' + e.message; }",
		);
		expect(caught.text).toContain('Returned: "caught Tool blocked by settings"');
		const thrown = await h.run("await tools.write({ path: 'b.md', content: 'x' });");
		expect(thrown.ok).toBe(false);
		expect(thrown.text).toContain('Error: Tool blocked by settings');
		expect(thrown.text).toContain('Tool calls: write blocked');
	});

	it('reports an uncaught exception with its name, message and stack', async () => {
		const r = await runJs({}).run("console.log('before');\nthrow new TypeError('bad');");
		expect(r.ok).toBe(false);
		expect(r.text).toMatch(/^before\nTypeError: bad\n.*script\.js/s);
	});

	it('stops computing after two seconds without an await, before the overall timeout', async () => {
		const started = Date.now();
		const r = await runJs({}).run('while (true) {}', { timeout: 30 });
		expect(r).toEqual({
			ok: false,
			text: 'The script computed for 2 seconds without waiting and was stopped.',
		});
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it('times out a script that keeps awaiting, but not for time spent on approvals', async () => {
		const tick = async () => {
			await new Promise((r) => setTimeout(r, 50));
			return okText(null);
		};
		const looping = await runJs({ tick }).run('for (;;) await tools.tick({});', { timeout: 1 });
		expect(looping.text).toMatch(/^Script timed out after 1 seconds/);
		// An approval card that takes longer than the whole timeout does not count against it.
		const approved = await runJs({
			slow: async (_args, onWaiting) => {
				onWaiting(true);
				await new Promise((r) => setTimeout(r, 1300));
				onWaiting(false);
				return { text: '1', status: 'ok' };
			},
		}).run('return await tools.slow({});', { timeout: 1 });
		expect(approved).toEqual({ ok: true, text: 'Returned: 1\nTool calls: slow ok' });
	});

	it('stops at the memory limit', async () => {
		const r = await runJs({}).run('const a = []; while (true) a.push(new Array(1e5).fill(1));');
		expect(r.ok).toBe(false);
		expect(r.text).toContain('out of memory');
	});

	it('ends with Script stopped when the turn is stopped while it waits', async () => {
		const stop = new AbortController();
		const r = runJs({
			hang: () => {
				setTimeout(() => stop.abort(), 50);
				return new Promise(() => {});
			},
		}).run('await tools.hang({}); return 1;', { signal: stop.signal });
		expect(await r).toEqual({ ok: false, text: 'Script stopped' });
	});
});
