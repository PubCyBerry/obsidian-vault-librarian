import { describe, expect, it } from 'vitest';
import type { IndexedEvent, SessionEvent } from '../src/session/session-types';
import { readableResult } from '../src/ui/cards';
import { firstLine, formatDuration, groupRuns, looksLikeAnswer, viewOf } from '../src/ui/work-log';

const at = (s: number) => new Date(Date.UTC(2026, 8, 25, 1, 0, s)).toISOString();

function events(...list: Record<string, unknown>[]): IndexedEvent[] {
	return list.map((event, index) => ({ index, event: event as unknown as SessionEvent }));
}

const call = (id: string, name = 'grep') => ({ id, name, args: { query: id } });

describe('work log (LIB-TEST-253)', () => {
	const conversation = events(
		{ t: at(0), type: 'meta', session: {} },
		{ t: at(1), type: 'user', content: 'find x' },
		{
			t: at(5),
			type: 'assistant',
			content: 'Looking in two places.',
			thinking: 'plan',
			toolCalls: [call('a'), call('b', 'read')],
		},
		{ t: at(6), type: 'tool_call', toolCallId: 'a', name: 'grep', args: {} },
		{ t: at(7), type: 'tool_result', toolCallId: 'a', name: 'grep', ok: true, content: '[]' },
		{
			t: at(9),
			type: 'compaction',
			summary: 's',
			coveredUntil: 1,
			tokensBefore: 9000,
			tokensAfter: 900,
		},
		{ t: at(20), type: 'assistant', content: '', toolCalls: [call('c')] },
		{ t: at(202), type: 'assistant', content: 'Found it.', thinking: 'done', toolCalls: [] },
		{ t: at(210), type: 'user', content: 'thanks' },
		{ t: at(212), type: 'error', stage: 'provider', message: 'HTTP 500' },
	);

	it('groups each request with everything up to the next one', () => {
		const runs = groupRuns(conversation);
		expect(runs.map((r) => [r.key, r.user?.content, r.events.length])).toEqual([
			[1, 'find x', 6],
			[8, 'thanks', 1],
		]);
	});

	it('puts thinking, notes, calls made together and compaction on the timeline, the answer under it', () => {
		const view = viewOf(groupRuns(conversation)[0]!);
		expect(view.steps.map((s) => [s.key, s.kind])).toEqual([
			['2:thinking', 'thinking'],
			['2:text', 'text'],
			['2:tools', 'tools'],
			['5:compaction', 'compaction'],
			['6:tools', 'tools'],
			['7:thinking', 'thinking'],
		]);
		const together = view.steps[2];
		expect(together?.kind === 'tools' ? together.calls.map((c) => c.name) : []).toEqual([
			'grep',
			'read',
		]);
		expect(view.answer).toBe('Found it.');
		expect(formatDuration(view.endedAt! - view.startedAt!)).toBe('3m 21s');
	});

	it('leaves a run without a closing answer, and keeps its errors apart', () => {
		const stopped = viewOf(
			groupRuns(
				events(
					{ t: at(0), type: 'user', content: 'go' },
					{
						t: at(3),
						type: 'assistant',
						content: 'Next I read.',
						toolCalls: [call('a')],
					},
				),
			)[0]!,
		);
		expect(stopped.answer).toBeNull();
		expect(stopped.steps.map((s) => s.kind)).toEqual(['text', 'tools']);
		const failed = viewOf(groupRuns(conversation)[1]!);
		expect(failed.steps).toEqual([]);
		expect(failed.errors).toEqual(['HTTP 500']);
	});

	it('times only the work: a model change before the request or after the answer does not count', () => {
		const runs = groupRuns(
			events(
				{ t: at(0), type: 'model_change', providerId: 'p', modelId: 'm' },
				{ t: at(10), type: 'user', content: 'hi' },
				{ t: at(14), type: 'assistant', content: 'Hello.', toolCalls: [] },
				{ t: at(90), type: 'model_change', providerId: 'p', modelId: 'n' },
				{ t: at(95), type: 'rename', title: 'Greeting' },
			),
		);
		// The leading run holds only the model change; the view draws nothing for it.
		expect(viewOf(runs[0]!)).toMatchObject({ steps: [], errors: [], answer: null });
		const view = viewOf(runs[1]!);
		expect(formatDuration(view.endedAt! - view.startedAt!)).toBe('4s');
	});

	it('writes durations and first lines for the header and the steps', () => {
		expect(formatDuration(400)).toBe('0s');
		expect(formatDuration(42_000)).toBe('42s');
		expect(formatDuration(202_000)).toBe('3m 22s');
		expect(formatDuration(3_900_000)).toBe('1h 5m');
		expect(firstLine('\n  Searching the vault.\nThen reading.')).toBe('Searching the vault.');
		expect(firstLine('x'.repeat(100), 10)).toBe(`${'x'.repeat(10)}…`);
	});

	it('shows results the way a person reads them in the popover', () => {
		const read = JSON.stringify({
			path: 'a.md',
			offset: 9,
			lines: [
				{ line: 9, text: 'nine' },
				{ line: 10, text: 'ten' },
			],
			totalLines: 40,
			nextOffset: 11,
		});
		expect(readableResult('read', read)).toBe(' 9  nine\n10  ten\nContinues at line 11');
		const grep = JSON.stringify({
			query: 'x',
			matches: [{ path: 'a.md', line: 3, text: '  has x ', before: ['2'] }],
			truncated: true,
		});
		expect(readableResult('grep', grep)).toBe('a.md:3  has x\nMore matches not shown');
		expect(readableResult('find', JSON.stringify({ matches: [], truncated: false }))).toBe(
			'No matches',
		);
		const ls = JSON.stringify({
			path: '',
			entries: [
				{ type: 'folder', path: 'notes' },
				{ type: 'file', path: 'a.md' },
			],
			offset: 0,
			nextOffset: 2,
			total: 5,
		});
		expect(readableResult('webdav_ls', ls)).toBe('notes/\na.md\n3 more not listed');
		expect(readableResult('custom', '{"ok":true}')).toBe('{\n  "ok": true\n}');
		expect(readableResult('bash', 'plain output')).toBe('plain output');
		// Output that reaches the popover as one JSON string shows as the text, not escaped.
		const jq = '{\n  "tag_name": "v1.13.8"\n}\n';
		expect(readableResult('bash', JSON.stringify(jq))).toBe(jq);
	});
});

describe('text on its way (LIB-TEST-271)', () => {
	it('stays a note while it is a sentence or two, and reads as the answer once it is more', () => {
		expect(looksLikeAnswer('Let me list the vault first.')).toBe(false);
		expect(looksLikeAnswer('먼저 Vault에 관련 맥락이 있는지 확인하겠습니다. ')).toBe(false);
		expect(looksLikeAnswer('2026년 계획을 확인하겠습니다.')).toBe(false);
		for (const answer of [
			'## What the vault holds',
			'- Projects',
			'1. First',
			'> quoted',
			'| a | b |',
			'```ts',
			'The projects are:\n\n1. Pricing',
			'x'.repeat(401),
		])
			expect(looksLikeAnswer(answer)).toBe(true);
	});
});
