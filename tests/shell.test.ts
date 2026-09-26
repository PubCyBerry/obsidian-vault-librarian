import type { App } from 'obsidian';
import { beforeEach, describe, expect, it } from 'vitest';
import { CurlUsageError, cliHandlers, parseCurl } from '../src/shell/commands';
import { createShellTool, ShellSession } from '../src/shell/shell-tool';
import { normalizeShellPath } from '../src/shell/vault-fs';
import { FakeApp } from './fake-app';
import { Platform, requestUrlMock } from './obsidian-stub';

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

	it('keeps bytes as bytes in /tmp and in the vault (LIB-TEST-223, issue #48)', async () => {
		const { run, app, asked } = shell();
		// base64 -d writes bytes. printf '\200' does not: just-bash treats its escapes as characters.
		expect(await run('echo gIH+/0FC | base64 -d > /tmp/t.bin && wc -c < /tmp/t.bin')).toBe(
			'6\n',
		);
		expect(await run('od -An -t x1 /tmp/t.bin')).toMatch(/80 81 fe ff 41 42/);
		expect(await run('cp /tmp/t.bin t.bin && cat /tmp/t.bin >> t.bin')).toBe('');
		const saved = new Uint8Array(await app.vault.adapter.readBinary('t.bin'));
		expect([...saved]).toEqual([
			0x80, 0x81, 0xfe, 0xff, 0x41, 0x42, 0x80, 0x81, 0xfe, 0xff, 0x41, 0x42,
		]);
		// A picture has no text to show, so its approval card carries the path alone.
		expect(asked[0]).toEqual({ name: 'write', args: { path: 't.bin' } });
		// Text still goes in and out as UTF-8.
		expect(await run('echo 한글 > /tmp/k && cat /tmp/k && wc -c < /tmp/k')).toBe('한글\n7\n');
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

	it('keeps a binary body byte for byte and a text body as text (LIB-TEST-223)', async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
		const page = new TextEncoder().encode('<p>한글</p>');
		requestUrlMock.impl = async (req) => ({
			status: 200,
			headers: {},
			arrayBuffer: ((req as { url: string }).url.endsWith('.png') ? png : page).buffer,
			get text(): string {
				throw new Error('the body must be read as bytes');
			},
		});
		const { run } = shell();
		expect(await run('curl -s -o /tmp/p.png https://x.test/a.png && wc -c < /tmp/p.png')).toBe(
			'10\n',
		);
		expect(await run('od -An -t x1 /tmp/p.png')).toMatch(/89 50 4e 47 0d 0a 1a 0a ff 00/);
		expect(await run('curl -s https://x.test/page')).toBe('<p>한글</p>');
		expect(await run('curl -s https://x.test/page | grep -o 한글')).toBe('한글\n');
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

	it('opens the developer verbs that only look (LIB-TEST-225)', async () => {
		const s = shell();
		const seen: string[] = [];
		withCli(s.app, {
			'dev:errors': () => 'No errors captured.',
			'dev:dom': (flags) => `dom ${String(flags.selector)}`,
			'dev:debug': (flags) => {
				seen.push(`debug ${JSON.stringify(flags)}`);
				return 'Debugger attached.';
			},
			'dev:console': () => 'No console messages captured.',
			'dev:cdp': () => 'should never run',
			eval: () => 'should never run',
		});
		expect(await s.run('obsidian dev:errors')).toBe('No errors captured.\n');
		expect(await s.run("obsidian dev:dom selector='.librarian'")).toBe('dom .librarian\n');
		// The console is captured only while the debugger is attached, so it is attached first.
		expect(await s.run('obsidian dev:console')).toBe('No console messages captured.\n');
		expect(seen).toEqual(['debug {"on":true}']);
		for (const withheld of ['dev:cdp method=Runtime.evaluate', 'dev:debug on', 'eval code=1'])
			expect(await s.run(`obsidian ${withheld}`)).toContain('unknown command');
		const help = await s.run('obsidian help');
		expect(help).toContain('dev:console');
		expect(help).not.toContain('dev:cdp');
	});

	it('moves a screenshot into the shell instead of wherever path points (LIB-TEST-225)', async () => {
		const s = shell();
		const taken: Record<string, unknown>[] = [];
		const disk = new Map<string, Uint8Array>();
		withCli(s.app, {
			'dev:screenshot': (flags) => {
				taken.push(flags);
				disk.set('/os/tmp/shot.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]));
				return '/os/tmp/shot.png';
			},
		});
		expect(await s.run('obsidian dev:screenshot')).toContain('needs desktop');
		const g = globalThis as { window?: unknown };
		Platform.isDesktopApp = true;
		g.window = {
			require: () => ({
				readFileSync: (p: string) => disk.get(p),
				unlinkSync: (p: string) => disk.delete(p),
			}),
		};
		try {
			expect(await s.run('obsidian dev:screenshot path=/etc/x.png')).toBe('/etc/x.png\n');
			// The app never saw the path, so it could not write outside the shell.
			expect(taken.at(-1)).toEqual({});
			expect(disk.size).toBe(0);
			expect(await s.run('wc -c < /etc/x.png')).toBe('5\n');
			expect(await s.run('obsidian dev:screenshot')).toMatch(
				/^\/tmp\/screenshot-\d+\.png\n$/,
			);
			expect(await s.run('obsidian dev:screenshot path=shots/a.png')).toBe(
				'/vault/shots/a.png\n',
			);
			// Into the vault it asks like any write and keeps every byte.
			expect(s.asked).toEqual([{ name: 'write', args: { path: 'shots/a.png' } }]);
			const saved = new Uint8Array(await s.app.vault.adapter.readBinary('shots/a.png'));
			expect([...saved]).toEqual([0x89, 0x50, 0x4e, 0x47, 0xff]);
		} finally {
			Platform.isDesktopApp = false;
			delete g.window;
		}
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

describe('the bash tool result (LIB-TEST-267)', () => {
	it('is the output as plain text, not a JSON string', async () => {
		const { session } = shell();
		const result = await createShellTool(session).execute(
			'c1',
			{ command: 'printf \'a "b"\\nc\\n\'' } as never,
			undefined,
		);
		expect((result.content[0] as { text: string }).text).toBe('a "b"\nc\n');
	});

	it('LIB-TEST-270, LIB-TEST-284: writes and removes agent definitions and skills, and nothing else hidden', async () => {
		const { run, app, asked } = shell();
		await run('mkdir -p .agents/agents && echo "name: x" > .agents/agents/x.md');
		expect(app.vault.text('.agents/agents/x.md')).toBe('name: x\n');
		expect(asked.map((a) => a.args.path)).toContain('.agents/agents/x.md');
		await run('rm .agents/agents/x.md');
		expect(app.vault.text('.agents/agents/x.md')).toBeUndefined();
		await run('mkdir -p .agents/skills/s && echo "name: s" > .agents/skills/s/SKILL.md');
		expect(app.vault.text('.agents/skills/s/SKILL.md')).toBe('name: s\n');
		for (const path of [
			'.agents/other/s.md',
			'.obsidian/x.md',
			'a/b/c/d/.agents/skills/s/SKILL.md',
		]) {
			expect(
				await run(`mkdir -p ${path.slice(0, path.lastIndexOf('/'))}; echo y > ${path}`),
			).toMatch(/read-only/i);
			expect(app.vault.text(path)).toBeUndefined();
		}
	});

	it('LIB-TEST-284: rm -r takes a folder file by file, each asked and snapshotted', async () => {
		const { run, app, asked, snapshots } = shell();
		app.vault.seed('.agents/skills/tidy/SKILL.md', 'skill');
		app.vault.seed('.agents/skills/tidy/references/style.md', 'style');
		expect(await run('rm -r .agents/skills/tidy')).toBe('');
		expect(asked.map((a) => a.args)).toEqual([
			{ path: '.agents/skills/tidy/SKILL.md', removed: true },
			{ path: '.agents/skills/tidy/references/style.md', removed: true },
		]);
		expect(snapshots.sort()).toEqual([
			'.agents/skills/tidy/SKILL.md',
			'.agents/skills/tidy/references/style.md',
		]);
		expect(await app.vault.adapter.exists('.agents/skills/tidy')).toBe(false);
		expect(await app.vault.adapter.exists('.agents/skills')).toBe(true);
		// A folder of notes goes the same way; an empty one with rmdir.
		expect(await run('rm -r notes && mkdir empty && rmdir empty')).toBe('');
		expect(app.vault.text('notes/a.md')).toBeUndefined();
		expect(await app.vault.adapter.exists('empty')).toBe(false);
	});

	it('LIB-TEST-284: rm -r stops before anything goes when a file inside is read-only or refused', async () => {
		const refusing = shell({
			refuse: (a) => (a.args.path === 'notes/b.md' ? 'rejected' : null),
		});
		refusing.app.vault.seed('notes/.hidden/x.md', 'x');
		expect(await refusing.run('rm -r notes')).toMatch(/read-only: notes\/\.hidden\/x\.md/i);
		expect(refusing.app.vault.text('notes/a.md')).toBe('alpha\nbeta');
		expect(refusing.asked).toEqual([]);
		// A refused approval leaves that note; -f swallows the error, so the result says it.
		expect(await refusing.run('rm -f notes/b.md')).toBe('bash: not changed: rejected\n');
		expect(refusing.app.vault.text('notes/b.md')).toBe('gamma');
		expect(await refusing.run('rm notes/b.md')).toBe(
			"Exit code: 1\nrm: cannot remove 'notes/b.md': rejected\n",
		);
		for (const target of ['/vault', '.', '/'])
			expect(await refusing.run(`rm -rf ${target}`)).toMatch(
				/not changed: refusing to remove/,
			);
		expect(refusing.app.vault.text('notes/b.md')).toBe('gamma');
	});

	it('runs the commands of agents working side by side one after another', async () => {
		const { run } = shell();
		const order: string[] = [];
		await Promise.all([
			run('echo one > /tmp/x; cat /tmp/x').then((o) => order.push(o)),
			run('echo two > /tmp/x; cat /tmp/x').then((o) => order.push(o)),
		]);
		expect(order).toEqual(['one\n', 'two\n']);
	});
});
