import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { spread, widenRepeats } from '../src/shell/grep';
import { latin1, normalizeShellPath, toBytes } from '../src/shell/vault-fs';

// The nightly workflow raises the number of cases; a push runs fast-check's default.
fc.configureGlobal({ numRuns: Number(process.env.FC_NUM_RUNS) || 100 });

describe('normalizeShellPath', () => {
	const segment = fc.oneof(
		fc.constantFrom('.', '..', '', 'a', 'b c', '.obsidian'),
		fc.string({ maxLength: 5 }).filter((s) => !s.includes('/')),
	);
	const path = fc
		.tuple(fc.boolean(), fc.array(segment, { maxLength: 8 }))
		.map(([absolute, parts]) => (absolute ? '/' : '') + parts.join('/'));

	it('gives an absolute path with no empty, `.` or `..` part, and leaves such a path as it is', () => {
		fc.assert(
			fc.property(path, (p) => {
				const out = normalizeShellPath(p);
				expect(out.startsWith('/')).toBe(true);
				if (out !== '/')
					for (const part of out.slice(1).split('/'))
						expect(['', '.', '..']).not.toContain(part);
				expect(normalizeShellPath(out)).toBe(out);
			}),
		);
	});
});

describe('bytes and the strings that carry them', () => {
	it('carries every byte through a binary string and back', () => {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
				const text = latin1(bytes);
				expect(text.length).toBe(bytes.length);
				expect(toBytes(text, 'binary')).toEqual(bytes);
			}),
		);
	});

	it('stores any other text as UTF-8', () => {
		fc.assert(
			fc.property(fc.string({ unit: 'grapheme', maxLength: 64 }), (text) => {
				expect(new TextDecoder().decode(toBytes(text))).toBe(text);
			}),
		);
	});
});

describe('spread', () => {
	/** Matches of the core in a line: in order, apart, each at least one character. */
	const line = fc
		.array(fc.tuple(fc.nat(20), fc.integer({ min: 1, max: 10 })), { maxLength: 12 })
		.chain((gaps) => {
			let at = 0;
			const cores = gaps.map(([gap, width]) => {
				const start = at + gap;
				at = start + width;
				return { start, end: at };
			});
			return fc.record({ cores: fc.constant(cores), length: fc.constant(at + 5) });
		});

	it('gives matches in order that do not overlap, stay in the line and hold a core each', () => {
		fc.assert(
			fc.property(line, fc.nat(30), fc.nat(30), ({ cores, length }, before, after) => {
				const out = spread(cores, { core: 'x', before, after }, length);
				let from = 0;
				for (const span of out) {
					expect(span.start).toBeGreaterThanOrEqual(from);
					expect(span.end).toBeLessThanOrEqual(length);
					expect(cores.some((c) => c.start >= span.start && c.end <= span.end)).toBe(
						true,
					);
					from = span.end;
				}
				expect(out.length).toBeLessThanOrEqual(cores.length);
				if (cores.length) expect(out.length).toBeGreaterThan(0);
			}),
		);
	});

	it('is the cores themselves when no text around them is asked for', () => {
		fc.assert(
			fc.property(line, ({ cores, length }) => {
				expect(spread(cores, { core: 'x', before: 0, after: 0 }, length)).toEqual(cores);
			}),
		);
	});
});

describe('widenRepeats', () => {
	const counts = fc
		.tuple(fc.nat(2500), fc.nat(2500))
		.map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const);

	it('keeps every count within the engine and matches the same lengths', () => {
		fc.assert(
			fc.property(counts, fc.boolean(), ([min, max], ranged) => {
				const wide = widenRepeats(ranged ? `a{${min},${max}}` : `a{${max}}`, 'ere');
				// The pieces stand in a row, so the lengths they match are the sums of their counts.
				// A regex engine that backtracks takes minutes over them, so they are added up here.
				let least = 0;
				let most = 0;
				let rest = wide;
				for (const m of wide.matchAll(/a\{(\d+)(?:,(\d+))?\}/g)) {
					const top = Number(m[2] ?? m[1]);
					expect(top).toBeLessThanOrEqual(1000);
					least += Number(m[1]);
					most += top;
					rest = rest.replace(m[0], '');
				}
				expect(rest).toBe('');
				expect([least, most]).toEqual([ranged ? min : max, max]);
			}),
		);
	});

	it('leaves a pattern without a count as it is', () => {
		fc.assert(
			fc.property(fc.stringMatching(/^[a-z.*+?|()[\]^$ ]{0,20}$/), (pattern) => {
				expect(widenRepeats(pattern, 'ere')).toBe(pattern);
			}),
		);
	});
});
