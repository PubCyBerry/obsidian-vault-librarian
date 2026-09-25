import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';
import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import {
	ContextManager,
	cacheHitRatio,
	estimateText,
	HANDOFF_PROMPT,
	SUMMARY_PREFIX,
	truncateMiddle,
} from '../src/context/context-manager';
import { toPiModel } from '../src/provider/provider-manager';
import { replay } from '../src/session/session-manager';
import type { SessionEvent } from '../src/session/session-types';
import { createVaultTools } from '../src/tools/registry';
import {
	DEFAULT_SETTINGS,
	mergeSettings,
	newModel,
	newProvider,
	RESPONSES_API,
} from '../src/types';
import { FakeApp } from './fake-app';
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

describe('earlier thinking on the Responses API (LIB-TEST-249)', () => {
	const events = [
		ev('user', { content: 'plan it' }),
		ev('assistant', { content: 'Done.', thinking: 'First the outline.', toolCalls: [] }),
		ev('user', { content: 'and then?' }),
	].map((event, index) => ({ event, index }));
	const types = (messages: unknown[]) =>
		(messages[1] as { content: { type: string }[] }).content.map((c) => c.type);

	it('goes back as reasoning_content on Chat Completions', async () => {
		const { cm } = manager();
		expect(types(await cm.project({ model: piModel, events }))).toEqual(['thinking', 'text']);
	});

	it('stays out of a Responses request, which Pi can then build', async () => {
		const { cm } = manager();
		const responses = toPiModel(provider, { ...model, api: RESPONSES_API });
		const messages = await cm.project({ model: responses, events });
		expect(types(messages)).toEqual(['text']);
		expect(() =>
			convertResponsesMessages(responses, { messages }, new Set(['openai'])),
		).not.toThrow();
	});

	it('sends a call back without the item id that pairs it with that reasoning', async () => {
		const { cm } = manager();
		const responses = toPiModel(provider, { ...model, api: RESPONSES_API });
		const messages = await cm.project({
			model: responses,
			events: [
				ev('user', { content: 'find x' }),
				ev('assistant', {
					content: '',
					thinking: 'Search first.',
					toolCalls: [{ id: 'call_1|fc_1', name: 'grep', args: { pattern: 'x' } }],
				}),
				ev('tool_result', {
					toolCallId: 'call_1|fc_1',
					name: 'grep',
					ok: true,
					content: 'a.md:1: x',
					truncated: false,
				}),
			].map((event, index) => ({ event, index })),
		});
		const items = convertResponsesMessages(responses, { messages }, new Set(['openai']));
		const call = items.find((i) => i.type === 'function_call');
		const output = items.find((i) => i.type === 'function_call_output');
		expect(call).toMatchObject({ call_id: 'call_1', id: undefined });
		expect(output).toMatchObject({ call_id: 'call_1' });
		expect(items.some((i) => i.type === 'reasoning')).toBe(false);
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

	const text = (m: unknown) => (m as { content: string }).content;

	it('LIB-TEST-257: asks for a handoff summary with the prompt and tools of the next request, tools off', async () => {
		const { cm, tools } = manager();
		const events = longConversation(3);
		const { streamFn, requests, sentOptions } = scriptedStream([{ text: 'Handoff.' }]);
		const result = await cm.compact(events, piModel, streamFn, {
			systemPrompt: 'SYSTEM',
			tools,
		});
		expect(result).toMatchObject({
			method: 'summary',
			summary: 'Handoff.',
			coveredUntil: events[events.length - 1]!.index + 1,
			retained: ['question 0', 'question 1', 'question 2'],
		});
		const sent = requests[0]!.messages;
		expect(sent[0]).toMatchObject({ role: 'system', content: 'SYSTEM' });
		expect((sent[0] as { toolsAdded?: unknown[] }).toolsAdded).toHaveLength(tools.length);
		expect(sent.map((m) => m.role)).toContain('toolResult');
		expect(text(sent[sent.length - 1])).toBe(HANDOFF_PROMPT);
		expect(sentOptions[0]).toMatchObject({ toolChoice: 'none' });
	});

	it('LIB-TEST-257: sends the kept user messages, then the summary, then what came after', async () => {
		const { cm, tools } = manager();
		const list = longConversation(2).map((e) => e.event);
		list.push(ev('user', { content: 'new question' }));
		const events = replay(list);
		const { streamFn } = scriptedStream([{ text: 'Handoff.' }]);
		const result = await cm.compact(events, piModel, streamFn, {
			systemPrompt: 'S',
			tools,
			keepLastUser: true,
		});
		expect(result?.retained).toEqual(['question 0', 'question 1']);
		const after = replay([...list, ev('compaction', { ...result })]);
		const prepared = await cm.build({
			events: after,
			model: piModel,
			systemPrompt: 'S',
			tools,
		});
		const sent = prepared.messages.slice(1);
		expect(sent.map((m) => m.role)).toEqual(['user', 'user', 'user', 'user']);
		expect(sent.map(text).slice(0, 2)).toEqual(['question 0', 'question 1']);
		expect(text(sent[2])).toBe(`${SUMMARY_PREFIX}\n\nHandoff.`);
		expect(text(sent[3])).toBe('new question');
	});

	it('LIB-TEST-257: keeps the newest user messages within a budget and cuts the next in the middle', async () => {
		const { cm, tools } = manager();
		const list = longConversation(3).map((e) => {
			const content = (e.event as { content?: string }).content;
			return e.event.type === 'user'
				? ev('user', { content: `${content} ${'x'.repeat(1000)} end` })
				: e.event;
		});
		const { streamFn } = scriptedStream([{ text: 'Handoff.' }]);
		const result = await cm.compact(replay(list), piModel, streamFn, {
			systemPrompt: 'S',
			tools,
		});
		// 4096 window, 512 output, 409 margin: a tenth of the rest is 317 tokens.
		expect(result?.retained).toHaveLength(2);
		expect(result?.retained[0]).toMatch(/^question 1 x+\n…\d+ tokens truncated…\nx+ end$/);
		expect(result?.retained[1]).toMatch(/^question 2 x+ end$/);
		expect(truncateMiddle('short', 10)).toBe('short');
	});

	it('LIB-TEST-257: leaves out the oldest turn and asks again when the summary request is too long', async () => {
		const { cm, tools } = manager();
		const { streamFn, requests } = scriptedStream([
			{
				stopReason: 'error',
				errorMessage: 'Your input exceeds the context window of this model.',
			},
			{ text: 'Handoff.' },
		]);
		const result = await cm.compact(longConversation(3), piModel, streamFn, {
			systemPrompt: 'S',
			tools,
		});
		expect(result?.method).toBe('summary');
		expect(text(requests[0]!.messages[1])).toBe('question 0');
		expect(text(requests[1]!.messages[1])).toBe('question 1');
	});

	it('LIB-TEST-257: has nothing to do when no response came after the last summary', async () => {
		const { cm, tools } = manager();
		const events = replay([
			...longConversation(1).map((e) => e.event),
			ev('compaction', {
				summary: 's',
				coveredUntil: 99,
				retained: ['question 0'],
				tokensBefore: 1,
				tokensAfter: 1,
				method: 'summary',
			}),
			ev('user', { content: 'next' }),
		]);
		const { streamFn, requests } = scriptedStream([]);
		expect(
			await cm.compact(events, piModel, streamFn, { systemPrompt: 'S', tools }),
		).toBeNull();
		expect(requests).toHaveLength(0);
	});

	it('LIB-TEST-257: counts a large tool result added after the last response', () => {
		const { cm } = manager();
		const events = replay([
			ev('user', { content: 'q' }),
			ev('assistant', {
				content: '',
				toolCalls: [{ id: 'c', name: 'read', args: {} }],
				usage: { input: 1000, output: 10, cacheRead: 0, totalTokens: 1010 },
			}),
			ev('tool_result', {
				toolCallId: 'c',
				name: 'read',
				ok: true,
				content: 'x'.repeat(8000),
				truncated: false,
			}),
		]);
		expect(cm.usage(events, piModel).state).toBe('normal');
		expect(cm.needsCompaction(events, piModel)).toBe(true);
	});

	const down = { stopReason: 'error' as const, errorMessage: 'down' };

	it('LIB-TEST-257: asks once more without tools when the server refuses the summary request', async () => {
		const { cm, tools } = manager();
		const { streamFn, requests, sentOptions } = scriptedStream([
			{ stopReason: 'error', errorMessage: 'tool_choice none is not supported' },
			{ text: 'Handoff.' },
		]);
		const result = await cm.compact(longConversation(2), piModel, streamFn, {
			systemPrompt: 'S',
			tools,
		});
		expect(result?.summary).toBe('Handoff.');
		expect((requests[1]!.messages[0] as { toolsAdded?: unknown[] }).toolsAdded ?? []).toEqual(
			[],
		);
		expect(sentOptions[1]).not.toHaveProperty('toolChoice');
	});

	it('LIB-TEST-148, LIB-TEST-257: a failed summary changes nothing and says why, away or not', async () => {
		const { cm, tools } = manager();
		const opts = { systemPrompt: 'S', tools };
		// Refused with tools off, then without tools: the history is left as it is.
		const refused = scriptedStream([down, down]);
		await expect(
			cm.compact(longConversation(3), piModel, refused.streamFn, opts),
		).rejects.toThrow('down');
		// A busy server is not asked again without tools.
		const busy = scriptedStream([{ stopReason: 'error', errorMessage: 'Error: 503: busy' }]);
		await expect(cm.compact(longConversation(3), piModel, busy.streamFn, opts)).rejects.toThrow(
			'503',
		);
		expect(busy.requests).toHaveLength(1);
		const empty = scriptedStream([{ text: '   ' }]);
		await expect(
			cm.compact(longConversation(3), piModel, empty.streamFn, opts),
		).rejects.toThrow('no summary');
	});
});
