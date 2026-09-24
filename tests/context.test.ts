import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { ContextManager, cacheHitRatio, estimateText } from '../src/context/context-manager';
import { toPiModel } from '../src/provider/provider-manager';
import { replay } from '../src/session/session-manager';
import type { SessionEvent } from '../src/session/session-types';
import { createVaultTools } from '../src/tools/registry';
import { DEFAULT_SETTINGS, mergeSettings, newModel, newProvider } from '../src/types';
import { FakeApp } from './fake-app';
import { Platform } from './obsidian-stub';
import { scriptedStream } from './scripted-stream';

function ev(type: string, extra: Record<string, unknown> = {}): SessionEvent {
	return { t: '2026-09-21T00:00:00.000Z', type, ...extra } as SessionEvent;
}

const provider = newProvider('p');
const model = { ...newModel('m'), contextWindow: 4096, maxTokens: 512 };
const piModel = toPiModel(provider, model);

function manager(overrides: Partial<typeof DEFAULT_SETTINGS.context> = {}) {
	const settings = mergeSettings({ context: { ...DEFAULT_SETTINGS.context, ...overrides } });
	const app = new FakeApp();
	const tools = createVaultTools({ app: app as unknown as App, settings: () => settings });
	return {
		cm: new ContextManager(app as unknown as App, () => settings.context),
		tools,
		settings,
		app,
	};
}

describe('token estimate (LIB-TEST-063)', () => {
	it('counts Hangul per character and Latin per four characters', () => {
		expect(estimateText('가나다라마')).toBe(5);
		expect(estimateText('abcdefgh')).toBe(2);
		expect(estimateText('한글 and English')).toBe(
			2 + Math.ceil(('한글 and English'.length - 2) / 4),
		);
	});
});

describe('budget (LIB-TEST-061, LIB-TEST-062)', () => {
	it('keeps a positive budget on a 4k model by capping the margin at 10%', () => {
		const { cm } = manager();
		const b = cm.budget(model);
		expect(b.margin).toBe(409);
		expect(b.usable).toBe(4096 - 512 - 409);
		const usage = cm.usageFor(2800, model);
		expect(usage.availableInputTokens).toBe(3175);
		expect(usage.state).toBe('critical');
		expect(usage.usageRatio).toBeCloseTo(2800 / 3175);
	});

	it('uses 70% and 85% by default and follows changed thresholds', () => {
		const { cm, settings } = manager();
		expect(cm.usageFor(Math.ceil(3175 * 0.7), model).state).toBe('warning');
		expect(cm.usageFor(Math.ceil(3175 * 0.85), model).state).toBe('critical');
		expect(cm.usageFor(Math.floor(3175 * 0.69), model).state).toBe('normal');
		settings.context.warningAt = 0.5;
		settings.context.compactAt = 0.6;
		expect(cm.usageFor(Math.ceil(3175 * 0.5), model).state).toBe('warning');
		expect(cm.usageFor(Math.ceil(3175 * 0.6), model).state).toBe('critical');
	});
});

describe('projection (LIB-TEST-058, LIB-TEST-059, LIB-TEST-060)', () => {
	const events = replay([
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
		ev('user', { content: 'first' }),
		ev('assistant', {
			content: 'ok',
			toolCalls: [{ id: 'c1', name: 'ls', args: {} }],
			usage: { input: 100, output: 10, cacheRead: 0, totalTokens: 110 },
		}),
		ev('tool_call', { toolCallId: 'c1', name: 'ls', args: {} }),
		ev('tool_result', {
			toolCallId: 'c1',
			name: 'ls',
			ok: true,
			content: '{"entries":[]}',
			truncated: false,
		}),
		ev('assistant', { content: 'done', toolCalls: [] }),
		ev('compaction', {
			summary: 'earlier stuff',
			coveredUntil: 5,
			tokensBefore: 200,
			tokensAfter: 50,
			method: 'summary',
		}),
		ev('user', { content: 'second' }),
	]);

	it('orders the request as system prompt, tools, summary, then the recent messages', async () => {
		const { cm, tools } = manager();
		const prepared = await cm.build({ events, model: piModel, systemPrompt: 'SYSTEM', tools });
		const roles = prepared.messages.map((m) => m.role);
		expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
		const system = prepared.messages[0] as { content: string; toolsAdded?: { name: string }[] };
		expect(system.content).toBe('SYSTEM');
		expect(system.toolsAdded?.map((t) => t.name)).toEqual([
			'ls',
			'find',
			'grep',
			'read',
			'get_active_note',
			'write',
			'edit',
		]);
		expect((prepared.messages[1] as { content: string }).content).toContain('earlier stuff');
		expect((prepared.messages[3] as { content: string }).content).toBe('second');
		expect(events).toHaveLength(8);
	});

	it('leaves out the trailing user message when the agent will add it', async () => {
		const { cm, tools } = manager();
		const prepared = await cm.build({
			events,
			model: piModel,
			systemPrompt: 'S',
			tools,
			excludeLastUser: true,
		});
		expect(prepared.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
	});

	it('LIB-TEST-060: the ring shows only what the provider reported for the last response', () => {
		const { cm } = manager();
		const meta = ev('meta', {
			session: {
				id: 's',
				title: '',
				providerId: 'p',
				modelId: 'm',
				createdAt: 't',
				updatedAt: 't',
			},
		});
		const withUsage = replay([
			meta,
			ev('user', { content: 'x'.repeat(400) }),
			ev('assistant', {
				content: 'reply',
				toolCalls: [],
				usage: { input: 5000, output: 2, cacheRead: 0, totalTokens: 5002 },
			}),
			ev('tool_result', {
				toolCallId: 'none',
				name: 'read',
				ok: true,
				content: 'y'.repeat(40),
				truncated: false,
			}),
			ev('user', { content: 'z'.repeat(4000) }),
		]);
		expect(cm.reportedUsed(withUsage)).toBe(5002);
		const noUsage = replay([meta, ev('user', { content: 'x'.repeat(400) })]);
		expect(cm.reportedUsed(noUsage)).toBe(0);
		const errored = replay([
			meta,
			ev('assistant', {
				content: '',
				toolCalls: [],
				usage: { input: 700, output: 30, cacheRead: 0, totalTokens: 730 },
			}),
			ev('assistant', { content: 'cut', toolCalls: [], stopReason: 'error' }),
		]);
		expect(cm.reportedUsed(errored)).toBe(730);
	});

	it('carries the four counts of the last response and the cache hit ratio (LIB-TEST-069)', () => {
		const { cm } = manager();
		const meta = ev('meta', { session: { id: 's' } });
		const events = replay([
			meta,
			ev('assistant', {
				content: 'reply',
				toolCalls: [],
				usage: {
					input: 200,
					output: 40,
					cacheRead: 600,
					cacheWrite: 200,
					totalTokens: 1040,
				},
			}),
		]);
		const usage = cm.usage(events, piModel);
		expect(usage.lastResponse).toEqual({
			input: 200,
			output: 40,
			cacheRead: 600,
			cacheWrite: 200,
		});
		expect(usage.usedTokens).toBe(1040);
		// 600 read from the cache out of a 1,000-token prompt (200 fresh, 600 read, 200 written).
		expect(cacheHitRatio(usage.lastResponse)).toBeCloseTo(0.6);
		// A session written before cache write was kept reads it as 0.
		const older = replay([
			meta,
			ev('assistant', {
				content: 'r',
				toolCalls: [],
				usage: { input: 300, output: 5, cacheRead: 100, totalTokens: 405 },
			}),
		]);
		expect(cm.usage(older, piModel).lastResponse?.cacheWrite).toBe(0);
		expect(cacheHitRatio(cm.usage(older, piModel).lastResponse)).toBeCloseTo(0.25);
		// Before the first response, and for a server that reports no prompt, there is no ratio.
		expect(cm.usage(replay([meta]), piModel).lastResponse).toBeNull();
		expect(cacheHitRatio(null)).toBeNull();
		expect(cacheHitRatio({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeNull();
	});

	it('inlines attached images from the vault and marks missing ones', async () => {
		const { cm, tools, app } = manager();
		app.vault.seedBinary('img.png', new Uint8Array([1, 2, 3]).buffer);
		const withImages = replay([
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
			ev('user', { content: 'look', images: ['img.png', 'gone.png'] }),
		]);
		const prepared = await cm.build({
			events: withImages,
			model: piModel,
			systemPrompt: 'S',
			tools,
		});
		const user = prepared.messages[1] as {
			content: { type: string; text?: string; mimeType?: string }[];
		};
		expect(user.content.map((c) => c.type)).toEqual(['text', 'image', 'text']);
		expect(user.content[1]?.mimeType).toBe('image/png');
		expect(user.content[2]?.text).toContain('gone.png');
	});
});

describe("Gemini's signature in the session (LIB-TEST-251)", () => {
	it('comes back on the tool call when the session is read again', async () => {
		const { cm } = manager();
		const messages = await cm.project({
			model: piModel,
			events: [
				ev('user', { content: 'find x' }),
				ev('assistant', {
					content: '',
					toolCalls: [{ id: 'c1', name: 'grep', args: {}, thoughtSignature: 'SIG' }],
				}),
			].map((event, index) => ({ event, index })),
		});
		const call = (messages[1] as { content: { type: string }[] }).content[0];
		expect(call).toMatchObject({ type: 'toolCall', id: 'c1', thoughtSignature: 'SIG' });
	});
});

describe('compaction (LIB-TEST-065, LIB-TEST-066)', () => {
	function longConversation(turns: number) {
		const list: SessionEvent[] = [
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
		];
		for (let i = 0; i < turns; i++) {
			list.push(ev('user', { content: `question ${i}` }));
			list.push(
				ev('assistant', {
					content: '',
					toolCalls: [{ id: `c${i}`, name: 'grep', args: { query: `q${i}` } }],
				}),
			);
			list.push(
				ev('tool_call', { toolCallId: `c${i}`, name: 'grep', args: { query: `q${i}` } }),
			);
			list.push(
				ev('tool_result', {
					toolCallId: `c${i}`,
					name: 'grep',
					ok: true,
					content: '{"matches":[]}',
					truncated: false,
				}),
			);
			list.push(ev('assistant', { content: `answer ${i}`, toolCalls: [] }));
		}
		return replay(list);
	}

	it('cuts at a user turn so a tool call and its result stay together', () => {
		const { cm } = manager({ preserveRecentTurns: 2 });
		const events = longConversation(5);
		const cut = cm.findCut(events)!;
		const at = events.find((e) => e.index === cut)!;
		expect(at.event.type).toBe('user');
		expect((at.event as { content: string }).content).toBe('question 3');
		expect(cm.findCut(longConversation(2))).toBeNull();
	});

	it('summarizes with the model and records the covered range', async () => {
		const { cm } = manager({ preserveRecentTurns: 1 });
		const events = longConversation(3);
		const { streamFn, requests } = scriptedStream([{ text: 'Summary: decided things.' }]);
		const result = await cm.compact(events, piModel, streamFn);
		expect(result?.method).toBe('summary');
		expect(result?.summary).toBe('Summary: decided things.');
		expect(result?.coveredUntil).toBe(
			events.find((e) => (e.event as { content?: string }).content === 'question 2')!.index,
		);
		const sent = requests[0]!.messages.map((m) => m.role);
		expect(sent).toEqual(['system', 'user']);
		expect(JSON.stringify(requests[0])).not.toContain('"toolsAdded"');
	});

	it('keeps the history when the summary failed while the app was away (LIB-TEST-148)', async () => {
		const g = globalThis as unknown as { document?: unknown };
		g.document = { visibilityState: 'hidden' };
		Platform.isMobile = true;
		try {
			const { cm } = manager({ preserveRecentTurns: 1 });
			const { streamFn } = scriptedStream([{ stopReason: 'error', errorMessage: 'down' }]);
			expect(await cm.compact(longConversation(3), piModel, streamFn)).toBeNull();
		} finally {
			Platform.isMobile = false;
			delete g.document;
		}
	});

	it('falls back to dropping the older part when the summary request fails', async () => {
		const { cm } = manager({ preserveRecentTurns: 1 });
		const { streamFn } = scriptedStream([{ stopReason: 'error', errorMessage: 'down' }]);
		const result = await cm.compact(longConversation(3), piModel, streamFn);
		expect(result?.method).toBe('truncate');
		expect(result?.summary).toMatch(/dropped .*\(\d+ events\)/);
	});
});
