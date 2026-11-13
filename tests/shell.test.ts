import type { App } from 'obsidian';
import { beforeEach, describe, expect, it } from 'vitest';
import { cliHandlers } from '../src/shell/commands';
import { CurlUsageError, parseCurl } from '../src/shell/curl';
import { aroundOf, spread, widenRepeats } from '../src/shell/grep';
import { createShellTool, ShellSession } from '../src/shell/shell-tool';
import { normalizeShellPath } from '../src/shell/vault-fs';
import { FakeApp } from './fake-app';
import { Platform, pdfJsMock, requestUrlMock } from './obsidian-stub';

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

	it('keeps the start and the end of a long result and parks the whole in /tmp (LIB-TEST-305)', async () => {
		const { run } = shell();
		const out = await run('seq 1 20000');
		expect(out).toContain('/tmp/bash-1.out');
		// A table is at the start and an error at the end: both stay, whole lines each.
		expect(out.startsWith('1\n2\n3\n')).toBe(true);
		expect(out.trimEnd().endsWith('19999\n20000')).toBe(true);
		expect(out).toMatch(/\n\[\d+ characters left out here; the whole output is in/);
		expect(out.length).toBeLessThanOrEqual(8000);
		expect(await run('tail -1 /tmp/bash-1.out')).toBe('20000\n');
		expect(await run('wc -l < /tmp/bash-1.out')).toBe('20000\n');
	});
});

describe('grep past what the bundled one takes (LIB-TEST-305)', () => {
	const page = `<html>${'x'.repeat(3000)}<title>The Title</title>${'y'.repeat(3000)}<p>needle here</p></html>`;
	function files() {
		const s = shell();
		s.app.vault.seed('notes/k.md', 'alpha\nbeta gamma\nGAMMA delta\n한글 줄\nlast line\n');
		s.app.vault.seed('one.html', page);
		s.app.vault.seed(
			'near.txt',
			'aXbXc........X..\nno hit\nX at start and X again far away X\n',
		);
		return s;
	}

	it('prints byte offsets with -b, of the line or with -o of each match', async () => {
		const { run } = files();
		expect(await run('grep -b beta notes/k.md')).toBe('6:beta gamma\n');
		expect(await run('grep -obi gamma notes/k.md')).toBe('11:gamma\n17:GAMMA\n');
		// Bytes, not characters: the line starts after 29 bytes, and line numbers go first.
		expect(await run('grep -nb 한글 notes/k.md')).toBe('4:29:한글 줄\n');
		expect(await run('grep -ob needle one.html')).toBe('6033:needle\n');
		expect(await run('cat notes/k.md | grep -b last')).toBe('40:last line\n');
		expect(await run('grep -b alpha notes/k.md one.html')).toBe('notes/k.md:0:alpha\n');
		expect(await run('grep -rob GAMMA notes')).toBe('notes/k.md:17:GAMMA\n');
		expect(await run('grep -b zzz notes/k.md; echo "rc=$?"')).toBe('rc=1\n');
	});

	it('takes the options that change nothing here, and names one file with -H', async () => {
		const { run } = files();
		expect(await run('grep --color=never -a -s alpha notes/k.md')).toBe('alpha\n');
		expect(await run('grep -Hn gamma notes/k.md')).toBe('notes/k.md:2:beta gamma\n');
		expect(await run('grep -Hc a notes/k.md')).toBe('notes/k.md:4\n');
		expect(await run('grep -A1 -Hn beta notes/k.md')).toBe(
			'notes/k.md:2:beta gamma\nnotes/k.md-3-GAMMA delta\n',
		);
		expect(await run('grep -e alpha -e last notes/k.md')).toBe('alpha\nlast line\n');
		expect(await run("echo 'a-b' | grep -e -b")).toBe('a-b\n');
		expect(await run("echo 'a-b' | grep -- '-b'")).toBe('a-b\n');
		expect(await run('grep --regexp=alpha --max-count=1 notes/k.md')).toBe('alpha\n');
	});

	it('widens a repeat count the engine would refuse', async () => {
		expect(widenRepeats('x{2500}', 'ere')).toBe('x{1000}x{1000}x{500}');
		expect(widenRepeats('[^<]{0,1500}y', 'ere')).toBe('[^<]{0,1000}[^<]{0,500}y');
		expect(widenRepeats('a\\{1200,\\}', 'bre')).toBe('a\\{1000\\}a\\{200\\}a*');
		expect(widenRepeats('(ab){1,1001}', 'ere')).toBe('(ab){1}(ab){0,1000}');
		// What fits stays as written, as does a brace that is no count and a class holding one.
		expect(widenRepeats('a{3}b{2,1000}{x}[{2000}]', 'ere')).toBe('a{3}b{2,1000}{x}[{2000}]');
		expect(widenRepeats('(a{1500})+', 'ere')).toBe('(a{1000}a{500})+');
		const { run } = files();
		expect(await run("grep -oE 'x{2500,}<title>' one.html | wc -c")).toBe('3008\n');
		expect(await run("grep -oE '[xy]{1500}' one.html | wc -l")).toBe('4\n');
	});

	it('cuts the text around a match itself, where the engine would take minutes', async () => {
		expect(aroundOf('.{0,300}needle.{0,200}', 'ere')).toEqual({
			core: 'needle',
			before: 300,
			after: 200,
		});
		expect(aroundOf('.\\{0,30\\}needle', 'bre')).toEqual({
			core: 'needle',
			before: 30,
			after: 0,
		});
		// Alternatives, a lazy count, an anchor or a literal dot would not mean the same without the ends.
		for (const p of ['.{0,3}a|b', '.{0,3}?a', 'a$.{0,3}', 'a\\.{0,3}', '.{2,3}a', 'needle'])
			expect(aroundOf(p, 'ere')).toBeNull();
		expect(
			spread(
				[
					{ start: 1, end: 2 },
					{ start: 3, end: 4 },
					{ start: 13, end: 14 },
				],
				{ core: 'X', before: 2, after: 3 },
				16,
			),
		).toEqual([
			{ start: 0, end: 5 },
			{ start: 11, end: 16 },
		]);
		const { run, app } = files();
		expect(await run("grep -oE '.{0,2}X.{0,3}' near.txt")).toBe(
			'aXbXc\n..X..\nX at\nd X ag\ny X\n',
		);
		expect(await run("grep -obE '.{0,2}X.{0,3}' near.txt | head -2")).toBe(
			'0:aXbXc\n11:..X..\n',
		);
		// Without -o the ends change nothing about which lines match.
		expect(await run("grep -cE '.{0,2}X.{0,3}' near.txt")).toBe('2\n');
		expect(await run("grep -o 'needle.\\{0,2500\\}' one.html")).toBe(
			'needle here</p></html>\n',
		);
		expect(await run("grep -oE '.{0,3000}needle' one.html | wc -c")).toBe('3007\n');
		// A megabyte on one line, as a minified page is: answered at once.
		const filler = '<div class="a">lorem ipsum dolor</div>'.repeat(13000);
		app.vault.seed('big.html', `${filler}<p>needle here</p>${filler}`);
		const started = Date.now();
		expect(await run("grep -oE '.{0,2500}needle.{0,2500}' big.html | wc -c")).toBe('5007\n');
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it('says what its engine lacks when it refuses a pattern', async () => {
		const { run } = files();
		const out = await run("grep -oP '(?<=<title>)[^<]+' one.html");
		expect(out).toContain('invalid regular expression');
		expect(out).toContain('no lookahead, lookbehind or backreferences');
	});
});

describe('pdftotext (LIB-TEST-305)', () => {
	it('writes the text of a PDF to stdout or to a file, a range of pages when asked', async () => {
		pdfJsMock.pages = [['Title', 'first page'], ['second page'], ['third']];
		const { run, app } = shell();
		app.vault.seedBinary('papers/p.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer);
		expect(await run('pdftotext papers/p.pdf - | grep -n page')).toBe(
			'1:--- page 1 ---\n3:first page\n4:--- page 2 ---\n5:second page\n6:--- page 3 ---\n',
		);
		expect(await run('pdftotext -layout -f 2 -l 2 papers/p.pdf -')).toBe(
			'--- page 2 ---\nsecond page\n',
		);
		expect(await run('pdftotext papers/p.pdf /tmp/p.txt && wc -l < /tmp/p.txt')).toBe('7\n');
		expect(await run('pdftotext nope.pdf -')).toContain('pdftotext: ');
		expect(await run('pdftotext')).toContain('Usage: pdftotext');
		pdfJsMock.pages = null;
		expect(await run('pdftotext papers/p.pdf -')).toContain('Invalid PDF structure');
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

	it('reads clustered short options with their values, and the options that change nothing (LIB-TEST-305)', () => {
		expect(parseCurl(['-sSfL', '-XPOST', '-m5', 'https://a.test/'])).toMatchObject({
			silent: true,
			showError: true,
			failOnError: true,
			method: 'POST',
			maxTimeMs: 5000,
		});
		expect(
			parseCurl([
				'--compressed',
				'-k',
				'--retry',
				'3',
				'--connect-timeout',
				'5',
				'--no-progress-meter',
				'https://a.test/',
			]),
		).toMatchObject({ url: 'https://a.test/', method: 'GET' });
		expect(
			parseCurl([
				'-u',
				'me:pw',
				'-A',
				'UA/1',
				'-e',
				'https://r.test/',
				'-b',
				'k=v',
				'-r',
				'0-9',
				'https://a.test/',
			]).headers,
		).toEqual({
			Authorization: 'Basic bWU6cHc=',
			'User-Agent': 'UA/1',
			Referer: 'https://r.test/',
			Cookie: 'k=v',
			Range: 'bytes=0-9',
		});
		// Several -d join into one form body; -G puts them in the query, encoded where asked.
		expect(parseCurl(['-d', 'a=1', '-d', 'b=2', 'https://a.test/p'])).toMatchObject({
			method: 'POST',
			body: 'a=1&b=2',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		});
		expect(
			parseCurl(['-G', '--data-urlencode', 'q=한 글', '-d', 'n=1', 'https://a.test/s']),
		).toMatchObject({ method: 'GET', url: 'https://a.test/s?q=%ED%95%9C%20%EA%B8%80&n=1' });
		expect(parseCurl(['--json', '{"a":1}', 'https://a.test/j'])).toMatchObject({
			method: 'POST',
			body: '{"a":1}',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		});
		expect(parseCurl(['-O', 'https://a.test/dir/file%20one.txt']).output).toBe('file one.txt');
		expect(() => parseCurl(['-O', 'https://a.test/'])).toThrow(/no length/);
		expect(() => parseCurl(['https://a.test/', 'https://b.test/'])).toThrow(/one URL/);
		expect(() => parseCurl(['-b', 'cookies.txt', 'https://a.test/'])).toThrow(/cookie files/);
		expect(() => parseCurl(['-F', 'a=b', 'https://a.test/'])).toThrow(/unknown option -F/);
		expect(() => parseCurl(['-H'])).toThrow(/needs a value/);
	});

	it('reads -d from a file or stdin, and reports with -w, -D and -v (LIB-TEST-305)', async () => {
		const seen: Record<string, unknown>[] = [];
		requestUrlMock.impl = async (req) => {
			seen.push(req as Record<string, unknown>);
			return { status: 200, headers: { 'content-type': 'text/plain' }, text: 'body' };
		};
		const { run } = shell();
		await run(
			`echo '{"z":9}' | curl -s -d @- -H 'Content-Type: application/json' https://x.test/`,
		);
		expect(seen[0]).toMatchObject({ method: 'POST', body: '{"z":9}' });
		await run(
			`printf 'l1\\nl2\\n' > /tmp/d.txt; curl -s --data-binary @/tmp/d.txt https://x.test/`,
		);
		expect(seen[1]).toMatchObject({ body: 'l1\nl2\n' });
		// -d drops a file's line breaks, as curl does.
		await run('curl -s -d @/tmp/d.txt https://x.test/');
		expect(seen[2]).toMatchObject({ body: 'l1l2' });
		expect(await run('curl -s -d @/tmp/none.txt https://x.test/')).toContain('Exit code: 26');
		expect(
			await run(
				`curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\\n' https://x.test/`,
			),
		).toBe('200 text/plain 4\n');
		expect(await run('ls /dev/null 2>&1 | head -1')).not.toBe('/dev/null\n');
		expect(await run('curl -s -D - -o /dev/null https://x.test/')).toBe(
			'HTTP 200\ncontent-type: text/plain\n\n',
		);
		expect(await run('curl -sv https://x.test/ 2>&1')).toBe(
			'body> GET https://x.test/\n>\n< HTTP 200\n< content-type: text/plain\n<\n',
		);
		expect(await run('curl -sO https://x.test/dir/got.txt && cat got.txt')).toBe('body');
	});

	it('leaves the file alone when -f fails, and keeps the body with --fail-with-body', async () => {
		requestUrlMock.impl = async () => ({ status: 500, headers: {}, text: 'broken' });
		const { run } = shell();
		expect(await run('curl -sf -o /tmp/e.txt https://x.test/; echo "rc=$?"; ls /tmp')).toBe(
			'rc=22\n',
		);
		expect(await run('curl -sS --fail-with-body https://x.test/')).toBe(
			'Exit code: 22\nbrokencurl: (22) The requested URL returned error: 500\n',
		);
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
