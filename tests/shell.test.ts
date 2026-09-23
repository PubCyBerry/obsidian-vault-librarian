import type { App } from 'obsidian';
import { beforeEach, describe, expect, it } from 'vitest';
import { CurlUsageError, cliHandlers, parseCurl } from '../src/shell/commands';
import { ShellSession } from '../src/shell/shell-tool';
import { normalizeShellPath } from '../src/shell/vault-fs';
import { FakeApp } from './fake-app';
import { requestUrlMock } from './obsidian-stub';

interface Asked {
	name: string;
	args: Record<string, unknown>;
}

function shell(opts: { refuse?: (a: Asked) => string | null } = {}) {
	const app = new FakeApp();
	app.vault.seed('notes/a.md', 'alpha\nbeta');
	app.vault.seed('notes/b.md', 'gamma');
	const asked: Asked[] = [];
	const snapshots: string[] = [];
	const session = new ShellSession({
		app: app as unknown as App,
		resultLimit: () => 8000,
		gate: async (name, args) => {
			asked.push({ name, args });
			const refusal = opts.refuse?.({ name, args });
			if (refusal) throw new Error(refusal);
		},
		snapshot: {
			before: async () => {},
			after: async (_id, path) => {
				snapshots.push(path);
			},
		},
	});
	let n = 0;
	const run = (command: string, timeout = 10) => session.run(`call-${++n}`, command, timeout);
	return { app, asked, snapshots, run, session };
}

beforeEach(() => {
	requestUrlMock.impl = null;
});

describe('the shell over the vault (LIB-TEST-174)', () => {
	it('resolves paths the way a shell does', () => {
		expect(normalizeShellPath('/vault/a/../b/./c')).toBe('/vault/b/c');
		expect(normalizeShellPath('tmp//x')).toBe('/tmp/x');
	});

	it('runs shell syntax and reads notes', async () => {
		const { run } = shell();
		expect(await run('for i in 1 2; do echo "n=$i"; done | tr a-z A-Z')).toBe('N=1\nN=2\n');
		// The seeded note has no trailing newline, so wc counts one line break, as POSIX wc does.
		expect(await run('cat notes/a.md | wc -l')).toBe('1\n');
		expect(await run('cat notes/a.md | head -1')).toBe('alpha\n');
		expect(await run("grep -rl 'gamma' . | sort")).toContain('notes/b.md');
		expect(await run('ls notes | sort')).toBe('a.md\nb.md\n');
	});

	it('asks before it writes to the vault and leaves a snapshot', async () => {
		const { run, app, asked, snapshots } = shell();
		expect(await run('echo hello > notes/c.md')).toBe('');
		expect(app.vault.text('notes/c.md')).toBe('hello\n');
		// A redirect truncates and then writes, but that is one change to one note, so one card.
		expect(asked).toEqual([{ name: 'write', args: { path: 'notes/c.md' } }]);
		expect(snapshots).toEqual(['notes/c.md']);
		asked.length = 0;
		expect(await run("sed -i 's/hello/HI/' notes/c.md")).toBe('');
		expect(app.vault.text('notes/c.md')).toBe('HI\n');
		expect(asked).toEqual([{ name: 'write', args: { path: 'notes/c.md', content: 'HI\n' } }]);
	});

	it('does not change the vault when the write is refused', async () => {
		const { run, app } = shell({ refuse: () => 'Tool blocked by settings' });
		const out = await run('echo hello > notes/c.md');
		expect(out).toContain('Tool blocked by settings');
		expect(app.vault.text('notes/c.md')).toBeUndefined();
	});

	it('keeps config folders read-only', async () => {
		const { run, app, asked } = shell();
		const out = await run('echo x > .obsidian/app.json');
		expect(out).toContain('read-only');
		expect(app.vault.text('.obsidian/app.json')).toBeUndefined();
		expect(asked).toEqual([]);
	});

	it('keeps /tmp between calls and forgets it on reset', async () => {
		const { run, session, asked } = shell();
		expect(await run('echo kept > /tmp/a && cat /tmp/a')).toBe('kept\n');
		expect(await run('cat /tmp/a')).toBe('kept\n');
		// Scratch space is outside the vault, so none of it went through the approval gate.
		expect(asked).toEqual([]);
		session.reset();
		expect(await run('cat /tmp/a')).toContain('Exit code: 1');
	});

	it('stops a runaway loop and reports a deadline', async () => {
		const { run } = shell();
		const loop = await run('while true; do :; done');
		expect(loop).toMatch(/Exit code: 12[46]/);
		const slow = await run('sleep 5', 1);
		expect(slow).toContain('Exit code: 124');
	});

	it('keeps the tail of a long result and parks the rest in /tmp', async () => {
		const { run } = shell();
		const out = await run('seq 1 20000');
		expect(out).toContain('/tmp/bash-1.out');
		expect(out.trimEnd().endsWith('20000')).toBe(true);
		expect(await run('tail -1 /tmp/bash-1.out')).toBe('20000\n');
	});
});

describe('curl (LIB-TEST-175)', () => {
	it('reads the options curl uses', () => {
		const args = parseCurl([
			'-X',
			'post',
			'-H',
			'Content-Type: application/json',
			'-d',
			'{"a":1}',
			'https://api.test/items',
		]);
		expect(args).toMatchObject({
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{"a":1}',
			url: 'https://api.test/items',
		});
		expect(parseCurl(['-d', 'x', 'https://api.test/'])).toMatchObject({ method: 'POST' });
		expect(() => parseCurl(['ftp://x/'])).toThrow(CurlUsageError);
		expect(() => parseCurl(['--nosuchflag', 'https://a.test/'])).toThrow(/unknown option/);
		expect(() => parseCurl([])).toThrow(/no URL/);
	});

	it('writes the response body to stdout exactly as it arrived', async () => {
		const page = '<html><body><a href="/x">x</a></body></html>';
		requestUrlMock.impl = async () => ({ status: 200, headers: {}, text: page });
		const { run } = shell();
		expect(await run('curl -s https://api.test/page')).toBe(page);
		expect(await run(`curl -s https://api.test/page | grep -o 'href="[^"]*"'`)).toBe(
			'href="/x"\n',
		);
		await run('curl -s https://api.test/page -o /tmp/p.html');
		expect(await run('wc -c < /tmp/p.html')).toBe(`${page.length}\n`);
	});

	it('sends the method, headers and body it was given', async () => {
		const seen: Record<string, unknown>[] = [];
		requestUrlMock.impl = async (req) => {
			seen.push(req as Record<string, unknown>);
			return { status: 201, headers: { 'content-type': 'application/json' }, text: '{}' };
		};
		const { run, asked } = shell();
		await run(
			`curl -s -X POST -H 'Authorization: Bearer abcdef' -d '{"a":1}' https://api.test/items`,
		);
		expect(seen[0]).toMatchObject({
			url: 'https://api.test/items',
			method: 'POST',
			headers: { Authorization: 'Bearer abcdef' },
			body: '{"a":1}',
		});
		// The approved bash call already showed this URL, so the request asks nothing further.
		expect(asked).toEqual([]);
	});

	it('shows the status only when asked', async () => {
		requestUrlMock.impl = async () => ({ status: 404, headers: {}, text: 'nope' });
		const { run } = shell();
		expect(await run('curl -s https://api.test/x')).toBe('nope');
		expect(await run('curl -si https://api.test/x')).toContain('HTTP 404');
		expect(await run('curl -sf https://api.test/x')).toContain('Exit code: 22');
	});
});

describe('the obsidian command (LIB-TEST-175)', () => {
	function withCli(
		app: FakeApp,
		entries: Record<string, (flags: Record<string, unknown>) => unknown>,
	) {
		const handlers = new Map(
			Object.entries(entries).map(([verb, handler]) => [
				verb,
				{ handler, description: verb },
			]),
		);
		(app as unknown as { cli: unknown }).cli = { handlers };
	}

	it('passes key=value flags to the registry and prints what comes back', async () => {
		const s = shell();
		const seen: Record<string, unknown>[] = [];
		withCli(s.app, {
			version: () => '1.13.7',
			search: (flags) => {
				seen.push(flags);
				return 'notes/a.md';
			},
		});
		expect(await s.run('obsidian version')).toBe('1.13.7\n');
		expect(await s.run('obsidian search query=alpha limit=5 total')).toBe('notes/a.md\n');
		expect(seen[0]).toEqual({ query: 'alpha', limit: '5', total: true });
		// The approved bash call already showed the verb, so running it asks nothing further.
		expect(s.asked).toEqual([]);
	});

	it('refuses an unknown verb, the withheld ones and a missing registry', async () => {
		const s = shell();
		withCli(s.app, { version: () => 'v', eval: () => 'should never run', search: () => 's' });
		const unknown = await s.run('obsidian nosuchverb');
		expect(unknown).toContain('Exit code: 127');
		const withheld = await s.run('obsidian eval code=1');
		expect(withheld).toContain('unknown command: eval');
		expect(await s.run('obsidian')).toContain('Exit code: 2');
		expect(await s.run('obsidian sear')).toMatch(/Did you mean: search/);
		const bare = shell();
		expect(await bare.run('obsidian version')).toContain('Exit code: 127');
	});

	it('reports what a verb threw', async () => {
		const s = shell();
		withCli(s.app, {
			read: () => {
				throw 'File "x.md" not found.';
			},
		});
		const out = await s.run('obsidian read path=x.md');
		expect(out).toContain('File "x.md" not found.');
		expect(out).toContain('Exit code: 1');
	});

	it('finds the registry only when it is a Map', () => {
		const app = new FakeApp();
		expect(cliHandlers(app as unknown as App)).toBeNull();
		(app as unknown as { cli: unknown }).cli = { handlers: {} };
		expect(cliHandlers(app as unknown as App)).toBeNull();
	});
});
