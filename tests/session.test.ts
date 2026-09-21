import type { App } from 'obsidian';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	contentHash,
	parseEvents,
	replay,
	SessionManager,
	summarize,
} from '../src/session/session-manager';
import type { SessionEvent } from '../src/session/session-types';
import { FakeApp } from './fake-app';

let app: FakeApp;
let sessions: SessionManager;

beforeEach(() => {
	app = new FakeApp();
	sessions = new SessionManager(app as unknown as App, '.obsidian/plugins/vault-librarian');
});

function ev(type: string, extra: Record<string, unknown> = {}): SessionEvent {
	return { t: '2026-09-21T00:00:00.000Z', type, ...extra } as SessionEvent;
}

describe('session file', () => {
	it('LIB-TEST-054: events append in order and earlier lines never change', async () => {
		const meta = await sessions.create({ providerId: 'p', modelId: 'm' });
		const path = sessions.sessionPath(meta.id);
		const first = app.vault.text(path)!;
		await sessions.append(meta.id, { type: 'user', content: 'hello' });
		await sessions.append(meta.id, {
			type: 'assistant',
			content: 'hi',
			toolCalls: [{ id: 'c1', name: 'ls', args: {} }],
		});
		await sessions.append(meta.id, {
			type: 'tool_call',
			toolCallId: 'c1',
			name: 'ls',
			args: {},
		});
		await sessions.append(meta.id, {
			type: 'approval',
			toolCallId: 'c1',
			name: 'ls',
			decision: 'approved',
		});
		await sessions.append(meta.id, {
			type: 'tool_result',
			toolCallId: 'c1',
			name: 'ls',
			ok: true,
			content: '{}',
			truncated: false,
		});
		await sessions.append(meta.id, {
			type: 'compaction',
			summary: 's',
			coveredUntil: 1,
			tokensBefore: 10,
			tokensAfter: 5,
			method: 'summary',
		});
		await sessions.append(meta.id, { type: 'model_change', providerId: 'p', modelId: 'm2' });
		await sessions.append(meta.id, { type: 'error', stage: 'provider', message: 'boom' });
		await sessions.rename(meta.id, 'Renamed');
		const text = app.vault.text(path)!;
		expect(text.startsWith(first)).toBe(true);
		const events = parseEvents(text);
		expect(events.map((e) => e.type)).toEqual([
			'meta',
			'user',
			'assistant',
			'tool_call',
			'approval',
			'tool_result',
			'compaction',
			'model_change',
			'error',
			'rename',
		]);
		expect(text.split('\n').filter(Boolean)).toHaveLength(10);
		// A torn trailing line is skipped, not fatal.
		expect(parseEvents(`${text}{"t":"x","type":"user","con`)).toHaveLength(10);
	});

	it('LIB-TEST-056: the title comes from the last rename or the first message', async () => {
		const meta = await sessions.create({ providerId: 'p', modelId: 'm' });
		await sessions.append(meta.id, { type: 'user', content: `${'a'.repeat(70)} tail` });
		let s = (await sessions.list())[0]!;
		expect(s.title).toBe('a'.repeat(60));
		await sessions.rename(meta.id, 'One');
		await sessions.rename(meta.id, 'Two');
		s = (await sessions.list())[0]!;
		expect(s.title).toBe('Two');
		const events = await sessions.load(meta.id);
		expect(s.updatedAt).toBe(events[events.length - 1]!.t);
		expect(s.messageCount).toBe(1);
	});

	it('list treats a sync conflict copy as its own session', async () => {
		const meta = await sessions.create({ providerId: 'p', modelId: 'm' });
		await sessions.append(meta.id, { type: 'user', content: 'x' });
		const copy = `${sessions.sessionsDir}/${meta.id} (conflict).jsonl`;
		await app.vault.adapter.write(copy, app.vault.text(sessions.sessionPath(meta.id))!);
		const list = await sessions.list();
		expect(list).toHaveLength(2);
		expect(list.map((s) => s.id).sort()).toEqual([meta.id, `${meta.id} (conflict)`]);
	});

	it('LIB-TEST-011: a pending approval expires on reopen and is never resumed', async () => {
		const meta = await sessions.create({ providerId: 'p', modelId: 'm' });
		await sessions.append(meta.id, { type: 'user', content: 'go' });
		await sessions.append(meta.id, {
			type: 'assistant',
			content: '',
			toolCalls: [{ id: 'c1', name: 'write', args: { path: 'a.md' } }],
		});
		await sessions.append(meta.id, {
			type: 'tool_call',
			toolCallId: 'c1',
			name: 'write',
			args: { path: 'a.md' },
		});
		const expired = await sessions.expirePendingApprovals(meta.id);
		expect(expired).toEqual(['c1']);
		const events = await sessions.load(meta.id);
		expect(events.some((e) => e.type === 'approval' && e.decision === 'expired')).toBe(true);
		expect(
			events.some((e) => e.type === 'tool_result' && e.content === 'Approval expired'),
		).toBe(true);
		expect(await sessions.expirePendingApprovals(meta.id)).toEqual([]);
		expect(app.vault.text('a.md')).toBeUndefined();
	});
});

describe('replay', () => {
	it('LIB-TEST-084: a rewind hides its range from replay but not from the file', () => {
		const events = [
			ev('meta', {
				session: {
					id: 's',
					title: '',
					providerId: 'p',
					modelId: 'm',
					createdAt: 't',
					updatedAt: 't',
				},
			}),
			ev('user', { content: 'one' }), // 1
			ev('assistant', { content: 'a1', toolCalls: [] }), // 2
			ev('user', { content: 'two' }), // 3
			ev('assistant', { content: 'a2', toolCalls: [] }), // 4
			ev('rewind', { toEventIndex: 3 }), // 5
			ev('user', { content: 'two again' }), // 6
			ev('assistant', { content: 'a3', toolCalls: [] }), // 7
			ev('rewind', { toEventIndex: 1 }), // 8
		];
		const once = replay(events.slice(0, 8));
		expect(once.map((e) => e.index)).toEqual([0, 1, 2, 6, 7]);
		const twice = replay(events);
		expect(twice.map((e) => e.index)).toEqual([0]);
		expect(events).toHaveLength(9);
	});

	it('LIB-TEST-085: a summary that covered rewound events is dropped', () => {
		const events = [
			ev('meta', {
				session: {
					id: 's',
					title: '',
					providerId: 'p',
					modelId: 'm',
					createdAt: 't',
					updatedAt: 't',
				},
			}),
			ev('user', { content: 'one' }), // 1
			ev('assistant', { content: 'a1', toolCalls: [] }), // 2
			ev('user', { content: 'two' }), // 3
			ev('assistant', { content: 'a2', toolCalls: [] }), // 4
			ev('compaction', {
				summary: 'old',
				coveredUntil: 3,
				tokensBefore: 1,
				tokensAfter: 1,
				method: 'summary',
			}), // 5
			ev('user', { content: 'three' }), // 6
			ev('rewind', { toEventIndex: 1 }), // 7
		];
		const alive = replay(events);
		expect(alive.map((e) => e.index)).toEqual([0]);
		const keepSummary = replay(events.slice(0, 7).concat([ev('rewind', { toEventIndex: 6 })]));
		expect(keepSummary.some((e) => e.event.type === 'compaction')).toBe(true);
	});

	it('summarize follows the last model change', () => {
		const events = [
			ev('meta', {
				session: {
					id: 's',
					title: '',
					providerId: 'p',
					modelId: 'm',
					createdAt: 't',
					updatedAt: 't',
				},
			}),
			ev('user', { content: 'hi' }),
			ev('model_change', { providerId: 'p2', modelId: 'm2', thinkingLevel: 'low' }),
		];
		const s = summarize('s', 'x', events)!;
		expect(s.providerId).toBe('p2');
		expect(s.modelId).toBe('m2');
		expect(s.thinkingLevel).toBe('low');
	});
});

describe('snapshots (LIB-TEST-095)', () => {
	it('stores the previous content beside the session and goes away with it', async () => {
		const meta = await sessions.create({ providerId: 'p', modelId: 'm' });
		const ref = await sessions.writeSnapshot(meta.id, 14, 'notes/메모.md', 'before');
		expect(ref).toBe('0014-메모.md');
		expect(await sessions.readSnapshot(meta.id, ref)).toBe('before');
		await sessions.deleteSnapshot(meta.id, ref);
		expect(await sessions.readSnapshot(meta.id, ref)).toBeNull();
		await sessions.writeSnapshot(meta.id, 15, 'a.md', 'x');
		await sessions.delete(meta.id);
		expect(await app.vault.adapter.exists(sessions.snapshotDirFor(meta.id))).toBe(false);
		expect(await app.vault.adapter.exists(sessions.sessionPath(meta.id))).toBe(false);
	});

	it('contentHash changes with the content', () => {
		expect(contentHash('abc')).toBe(contentHash('abc'));
		expect(contentHash('abc')).not.toBe(contentHash('abd'));
	});
});
