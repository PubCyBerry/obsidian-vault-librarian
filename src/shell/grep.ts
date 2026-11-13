import type { Command, CommandContext, ExecResult } from 'just-bash/browser';
import { defineCommand } from 'just-bash/browser';
import { toBytes } from './vault-fs';

/**
 * grep, as the interpreter bundles it, with what a model reaches for and it refuses or cannot
 * finish (LIB-FEAT-301): -b, -H, options that change nothing here, repeat counts past its regex
 * engine's limit, and a pattern that asks for the text around a match, as `.{0,300}needle.{0,300}`
 * does, which the engine takes minutes over on a page that is one long line. The bundled command
 * still does the matching; this reads the options, rewrites the pattern and puts the offsets, the
 * names and the text around a match on what it found.
 */

/** The most a repeat count may be in the interpreter's regex engine (RE2). */
const MAX_REPEAT = 1000;
/** The most a repeat count is widened to. */
const MAX_WIDE = 20_000;

/** grep's pattern syntaxes: basic (braces and groups take a backslash), extended, Perl's. */
type Syntax = 'bre' | 'ere' | 'pcre';

/** Where a bracket expression that opens at `i` ends. A `]` right after the opening is a literal. */
function bracketEnd(p: string, i: number, escapes: boolean): number {
	let j = i + 1;
	if (p[j] === '^') j++;
	if (p[j] === ']') j++;
	while (j < p.length && p[j] !== ']') {
		if (escapes && p[j] === '\\') j += 2;
		else if (p[j] === '[' && /[:.=]/.test(p[j + 1] ?? '')) {
			const end = p.indexOf(`${p[j + 1]}]`, j + 2);
			j = end < 0 ? p.length : end + 2;
		} else j++;
	}
	return Math.min(p.length, j + 1);
}

/**
 * Where the atom that starts at `i` ends: a character, an escape, a bracket expression or a whole
 * group, to the close that matches its opening.
 */
function atomEnd(p: string, i: number, syntax: Syntax): number {
	const bre = syntax === 'bre';
	const escapes = syntax === 'pcre';
	if (bre ? p.startsWith('\\(', i) : p[i] === '(') {
		let depth = 0;
		for (let j = i; j < p.length; j++) {
			if (p[j] === '\\') {
				if (bre && p[j + 1] === '(') depth++;
				if (bre && p[j + 1] === ')' && --depth === 0) return j + 2;
				j++;
			} else if (p[j] === '[') j = bracketEnd(p, j, escapes) - 1;
			else if (!bre && p[j] === '(') depth++;
			else if (!bre && p[j] === ')' && --depth === 0) return j + 1;
		}
		return p.length;
	}
	if (p[i] === '\\') return Math.min(p.length, i + 2);
	if (p[i] === '[') return bracketEnd(p, i, escapes);
	return i + 1;
}

/**
 * A pattern whose repeat counts fit the engine: `X{m,n}` past the limit becomes repeats of X in a
 * row that match the same, as `x{2500}` becomes `x{1000}x{1000}x{500}`.
 */
export function widenRepeats(pattern: string, syntax: Syntax): string {
	const bre = syntax === 'bre';
	const open = bre ? 2 : 1;
	const interval = bre ? /^\\\{(\d+)(,(\d*))?\\\}/ : /^\{(\d+)(,(\d*))?\}/;
	// X exactly k times, or from 0 to k times with `upTo`, as pieces in a row: the engine counts
	// a repeat inside a repeat against the same limit, so the pieces cannot share a group.
	const repeat = (x: string, k: number, upTo: boolean): string => {
		const piece = (n: number) => {
			const range = upTo ? `0,${n}` : String(n);
			return n ? (bre ? `${x}\\{${range}\\}` : `${x}{${range}}`) : '';
		};
		return piece(MAX_REPEAT).repeat(Math.floor(k / MAX_REPEAT)) + piece(k % MAX_REPEAT);
	};
	let out = '';
	/** The atom just written to `out`, which a repeat count applies to. */
	let atom = '';
	for (let i = 0; i < pattern.length; ) {
		const m = atom ? interval.exec(pattern.slice(i)) : null;
		const most = m ? Math.max(Number(m[1]), Number(m[3] ?? 0)) : 0;
		if (m && most > MAX_REPEAT && most <= MAX_WIDE) {
			const min = Number(m[1]);
			const more =
				m[2] === undefined
					? ''
					: m[3]
						? repeat(atom, Number(m[3]) - min, true)
						: `${atom}*`;
			out = out.slice(0, out.length - atom.length) + repeat(atom, min, false) + more;
			atom = '';
			i += m[0].length;
			continue;
		}
		const end = atomEnd(pattern, i, syntax);
		const group = bre ? pattern.startsWith('\\(', i) : pattern[i] === '(';
		// Counts inside a group are widened too.
		atom =
			group && end - i >= 2 * open
				? pattern.slice(i, i + open) +
					widenRepeats(pattern.slice(i + open, end - open), syntax) +
					pattern.slice(end - open, end)
				: pattern.slice(i, end);
		out += atom;
		i = end;
	}
	return out;
}

/** The text a pattern asks for around what it looks for: so many characters before and after. */
export interface Around {
	core: string;
	before: number;
	after: number;
}

/**
 * A pattern of the form `.{0,N}CORE.{0,M}`, with either end optional: the idiom for "show me what
 * stands around the match". Null for any other pattern, and for a core with alternatives, an
 * anchor or a lazy count, where taking the ends off would change what matches.
 */
export function aroundOf(pattern: string, syntax: Syntax): Around | null {
	const bre = syntax === 'bre';
	const lead = (bre ? /^\.\\\{0,(\d+)\\\}/ : /^\.\{0,(\d+)\}/).exec(pattern);
	let core = lead ? pattern.slice(lead[0].length) : pattern;
	const trail = (bre ? /\.\\\{0,(\d+)\\\}$/ : /\.\{0,(\d+)\}$/).exec(core);
	// A dot after an odd number of backslashes is a literal dot, not "any character".
	const escaped = trail ? /\\*$/.exec(core.slice(0, trail.index))?.[0].length : 0;
	const tail = trail && (escaped ?? 0) % 2 === 0 ? trail : null;
	if (!lead && !tail) return null;
	if (tail) core = core.slice(0, tail.index);
	if (!core || /^[?+*^]/.test(core) || /(^|[^\\])\$$/.test(core)) return null;
	for (let i = 0; i < core.length; i = atomEnd(core, i, syntax))
		if (bre ? core.startsWith('\\|', i) : core[i] === '|') return null;
	return { core, before: lead ? Number(lead[1]) : 0, after: tail ? Number(tail[1]) : 0 };
}

export interface GrepArgs {
	/** The options and the pattern for the bundled grep, without what it refuses. */
	head: string[];
	files: string[];
	byteOffset: boolean;
	lineNumber: boolean;
	onlyMatching: boolean;
	/** -H, or -h as false; null leaves it to the number of files. */
	withFilename: boolean | null;
	recursive: boolean;
	/** -c: one number per file instead of lines. */
	count: boolean;
	/** -l, -L, -q: no lines at all. */
	names: boolean;
	/** -A, -B or -C: lines around the matches come too. */
	context: boolean;
	/** The pattern asked for text around its match; `head` then looks for the core alone. */
	around: Around | null;
}

/** Long options with nothing to do here. */
const NO_EFFECT = /^--(?:colou?r|line-buffered|text|binary|no-messages)$/;
const LONG_VALUE = new Set([
	'--regexp',
	'--file',
	'--max-count',
	'--after-context',
	'--before-context',
	'--context',
	'--include',
	'--exclude',
	'--exclude-dir',
]);
const LONG_FLAG: Record<string, string> = {
	'--byte-offset': 'b',
	'--with-filename': 'H',
	'--no-filename': 'h',
	'--extended-regexp': 'E',
	'--perl-regexp': 'P',
	'--fixed-strings': 'F',
	'--basic-regexp': 'G',
	'--line-number': 'n',
	'--only-matching': 'o',
	'--recursive': 'r',
	'--dereference-recursive': 'r',
	'--count': 'c',
	'--files-with-matches': 'l',
	'--files-without-match': 'L',
	'--quiet': 'q',
	'--silent': 'q',
};

/** Reads grep's options: which of them this file answers, and the rest for the bundled grep. */
export function scanGrep(argv: string[]): GrepArgs {
	const g: GrepArgs = {
		head: [],
		files: [],
		byteOffset: false,
		lineNumber: false,
		onlyMatching: false,
		withFilename: null,
		recursive: false,
		count: false,
		names: false,
		context: false,
		around: null,
	};
	// Set from inside `flag`, which the compiler does not follow: the cast keeps the type whole.
	let syntax = 'bre' as Syntax | 'fixed';
	/** Where in `head` the patterns are, to rewrite once the syntax is known. */
	const patterns: number[] = [];
	const operands: string[] = [];
	let named = false;
	let rest = false;
	/** Notes a one-letter option; false when the bundled grep must not get it. */
	const flag = (c: string): boolean => {
		switch (c) {
			case 'b':
				g.byteOffset = true;
				return false;
			case 'H':
				g.withFilename = true;
				return false;
			// Binary files as text, and quiet about missing files: nothing to switch here.
			case 'a':
			case 'U':
			case 's':
				return false;
			case 'h':
				g.withFilename = false;
				break;
			case 'E':
				syntax = 'ere';
				break;
			case 'P':
				syntax = 'pcre';
				break;
			case 'F':
				syntax = 'fixed';
				break;
			case 'G':
				syntax = 'bre';
				break;
			case 'n':
				g.lineNumber = true;
				break;
			case 'o':
				g.onlyMatching = true;
				break;
			case 'r':
			case 'R':
				g.recursive = true;
				break;
			case 'c':
				g.count = true;
				break;
			case 'l':
			case 'L':
			case 'q':
				g.names = true;
				break;
		}
		return true;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (rest || !arg.startsWith('-') || arg === '-') operands.push(arg);
		else if (arg === '--') rest = true;
		else if (arg.startsWith('--')) {
			const eq = arg.indexOf('=');
			const name = eq < 0 ? arg : arg.slice(0, eq);
			if (NO_EFFECT.test(name)) continue;
			const letter = LONG_FLAG[name];
			if (letter) {
				if (flag(letter)) g.head.push(arg);
				continue;
			}
			if (/^--(?:after-|before-)?context$/.test(name)) g.context = true;
			if (name === '--regexp' || name === '--file') named = true;
			if (name === '--regexp' && eq >= 0) {
				g.head.push('-e');
				patterns.push(g.head.length);
				g.head.push(arg.slice(eq + 1));
				continue;
			}
			g.head.push(arg);
			if (!LONG_VALUE.has(name) || eq >= 0 || i + 1 >= argv.length) continue;
			if (name === '--regexp') patterns.push(g.head.length);
			g.head.push(argv[++i] as string);
		} else {
			// A cluster such as -ob or -A2, up to the option that takes the rest as its value.
			let kept = '-';
			for (let j = 1; j < arg.length; j++) {
				const c = arg[j] as string;
				if (!'efmABC'.includes(c)) {
					if (flag(c)) kept += c;
					continue;
				}
				if (c === 'e' || c === 'f') named = true;
				else if (c !== 'm') g.context = true;
				const value = arg.slice(j + 1) || argv[++i];
				g.head.push(kept + c);
				if (value !== undefined) {
					if (c === 'e') patterns.push(g.head.length);
					g.head.push(value);
				}
				kept = '';
				break;
			}
			if (kept.length > 1) g.head.push(kept);
		}
	}
	if (!named && operands.length) {
		// `--` keeps a pattern that starts with a dash from reading as an option.
		g.head.push('--');
		patterns.push(g.head.length);
		g.head.push(operands.shift() as string);
	}
	g.files = operands;
	if (syntax === 'fixed') return g;
	const only = patterns.length === 1 ? (patterns[0] as number) : -1;
	if (only >= 0) {
		g.around = aroundOf(g.head[only] as string, syntax);
		if (g.around) g.head[only] = g.around.core;
	}
	for (const at of patterns) g.head[at] = widenRepeats(g.head[at] as string, syntax);
	return g;
}

type Orig = (args: string[]) => Promise<ExecResult>;
type Io = Pick<CommandContext, 'fs' | 'cwd' | 'stdin'>;

const bytesOf = (s: string) => new TextEncoder().encode(s).length;

interface Span {
	start: number;
	end: number;
}

/**
 * What `.{0,before}CORE.{0,after}` matches in one line, from where CORE matches in it: each
 * match starts as early and ends as late as the counts let it, and the next one follows it, as
 * grep's own leftmost and longest matching would have it.
 */
export function spread(cores: Span[], around: Around, length: number): Span[] {
	const out: Span[] = [];
	let from = 0;
	for (let i = 0; i < cores.length; i++) {
		const first = cores[i] as Span;
		// Taken up by the match before it.
		if (first.start < from) continue;
		const start = Math.max(from, first.start - around.before);
		// The last core that still starts within reach is the one that ends the match latest.
		while (i + 1 < cores.length && (cores[i + 1] as Span).start - start <= around.before) i++;
		from = Math.min(length, (cores[i] as Span).end + around.after);
		out.push({ start, end: from });
	}
	return out;
}

/**
 * -b, and -o on a pattern that asks for the text around its match: the bundled grep finds the
 * lines and the matches, with their line numbers, and the rest is counted from the file itself.
 */
async function located(g: GrepArgs, ctx: Io, orig: Orig): Promise<ExecResult> {
	let files = g.files;
	let stderr = '';
	if (g.recursive) {
		// The bundled grep walks the folders; each file it names is then read on its own.
		const listed = await orig(['-l', ...g.head, ...g.files]);
		if (listed.exitCode > 1) return listed;
		files = listed.stdout.split('\n').filter(Boolean);
		if (!files.length) return { stdout: '', stderr: listed.stderr, exitCode: 1 };
	}
	const inputs = files.length ? files : [null];
	const named = g.withFilename ?? (g.recursive || inputs.length > 1);
	let stdout = '';
	for (const file of inputs) {
		const r = await orig(['-nh', ...g.head, ...(file === null ? [] : [file])]);
		stderr += r.stderr;
		if (r.exitCode > 1) return { stdout, stderr, exitCode: r.exitCode };
		if (!r.stdout) continue;
		const text =
			file === null
				? new TextDecoder().decode(toBytes(ctx.stdin, 'binary'))
				: await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, file));
		const lines = text.split('\n');
		/** Byte offset of each line's start, filled as far as it was asked for. */
		const starts = [0];
		const startOf = (n: number): number => {
			while (starts.length < n) {
				const last = starts.length - 1;
				starts.push((starts[last] as number) + bytesOf(lines[last] ?? '') + 1);
			}
			return starts[n - 1] as number;
		};
		const emit = (n: number, sep: string, at: number | null, shown: string) => {
			const whole = lines[n - 1] ?? '';
			const offset = g.byteOffset
				? `${startOf(n) + (at ? bytesOf(whole.slice(0, at)) : 0)}${sep}`
				: '';
			stdout += `${named ? `${file ?? '(standard input)'}${sep}` : ''}${g.lineNumber ? `${n}${sep}` : ''}${offset}${shown}\n`;
		};
		/** The matches of the line being read, which -o gives one per output line. */
		let line = 0;
		let cores: Span[] = [];
		const flush = () => {
			const whole = lines[line - 1] ?? '';
			const spans = g.around ? spread(cores, g.around, whole.length) : cores;
			for (const s of spans) emit(line, ':', s.start, whole.slice(s.start, s.end));
			cores = [];
		};
		for (const out of r.stdout.replace(/\n$/, '').split('\n')) {
			const m = /^(\d+)([:-])([\s\S]*)$/.exec(out);
			if (!m) stdout += `${out}\n`;
			else if (!g.onlyMatching) emit(Number(m[1]), m[2] as string, null, m[3] as string);
			else {
				if (Number(m[1]) !== line) {
					flush();
					line = Number(m[1]);
				}
				const shown = m[3] as string;
				const after = cores.length ? (cores[cores.length - 1] as Span).end : 0;
				const start = Math.max(0, (lines[line - 1] ?? '').indexOf(shown, after));
				cores.push({ start, end: start + shown.length });
			}
		}
		flush();
	}
	return { stdout, stderr, exitCode: stdout ? 0 : 1 };
}

/** What the engine cannot do, said where the model reads the refusal. */
function hinted(r: ExecResult): ExecResult {
	if (r.exitCode < 2 || !/invalid regular expression/.test(r.stderr)) return r;
	return {
		...r,
		stderr: `${r.stderr}grep: this grep has no lookahead, lookbehind or backreferences; match the text around it and cut with sed -E 's/…(…)…/\\1/' or awk\n`,
	};
}

export function createGrep(): Command {
	return defineCommand('grep', async (argv, ctx): Promise<ExecResult> => {
		const orig = ctx.origCommand;
		if (!orig) return { stdout: '', stderr: 'grep: not available\n', exitCode: 127 };
		const g = scanGrep(argv);
		const lines = !g.count && !g.names;
		if (lines && (g.byteOffset || (g.around && g.onlyMatching)))
			return hinted(await located(g, ctx, orig));
		const r = hinted(await orig([...g.head, ...g.files]));
		// -H on one input: the name grep puts on every line when it is given several files.
		if (g.withFilename !== true || g.names || g.recursive || g.files.length > 1 || !r.stdout)
			return r;
		const name = g.files[0] ?? '(standard input)';
		// shortcut: without -n a line around a match gets `:` like a match, upgrade if that matters.
		const named = r.stdout
			.replace(/\n$/, '')
			.split('\n')
			.map((line) =>
				line === '--' && g.context
					? line
					: `${name}${g.context && g.lineNumber && /^\d+-/.test(line) ? '-' : ':'}${line}`,
			);
		return { ...r, stdout: `${named.join('\n')}\n` };
	});
}
