import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import type { App } from 'obsidian';
import { afterEach, describe, expect, it } from 'vitest';
import {
	effectiveRequestOptions,
	mergeCompat,
	ProviderManager,
	selectableThinkingLevels,
	toPiModel,
} from '../src/provider/provider-manager';
import { buildRequestBody, TransportRouter, testConnection } from '../src/provider/transport';
import { isValidSecretId, SecretStore } from '../src/storage/secret-store';
import { createVaultTools } from '../src/tools/registry';
import { mergeSettings, newModel, newProvider } from '../src/types';
import { noteVisibility } from '../src/visibility';
import { FakeApp } from './fake-app';
import { requestUrlMock } from './obsidian-stub';

describe('connection check', () => {
	it('uses requestUrl for every transport and reports HTTP and network errors', async () => {
		try {
			for (const transport of ['auto', 'fetch', 'requestUrl'] as const) {
				const provider = {
					...newProvider('p'),
					baseUrl: 'https://llm.example/v1/',
					transport,
				};
				requestUrlMock.impl = async (request) => {
					expect(request).toMatchObject({
						url: 'https://llm.example/v1/models',
						throw: false,
					});
					return { status: 200, json: { data: [{ id: 'model' }] } };
				};
				expect(await testConnection(provider, 'key')).toEqual({ ok: true, models: 1 });
				requestUrlMock.impl = async () => ({
					status: 401,
					get json() {
						throw new Error('Not JSON');
					},
				});
				expect(await testConnection(provider, 'key')).toEqual({
					ok: false,
					message: 'HTTP 401',
				});
			}
			requestUrlMock.impl = async () => {
				throw new Error('Offline');
			};
			expect(await testConnection(newProvider('p'), null)).toEqual({
				ok: false,
				message: 'Offline',
			});
		} finally {
			requestUrlMock.impl = null;
		}
	});
});

const app = new FakeApp();
const settings = mergeSettings({});
const tools = createVaultTools({ app: app as unknown as App, settings: () => settings });

function context(userText: string, extra: Parameters<typeof normalizeContext>[0]['messages'] = []) {
	return normalizeContext({
		systemPrompt: 'SYSTEM PROMPT',
		tools,
		messages: [{ role: 'user', content: userText, timestamp: 1 }, ...extra],
	});
}

describe('provider config (LIB-TEST-017, LIB-TEST-018, LIB-TEST-023)', () => {
	it('merges compat with the model winning', () => {
		const provider = {
			...newProvider('p'),
			compat: {
				supportsStore: false,
				supportsReasoningEffort: true,
				maxTokensField: 'max_tokens' as const,
			},
		};
		const model = { ...newModel('m'), compat: { supportsReasoningEffort: false } };
		expect(mergeCompat(provider, model)).toEqual({
			supportsStore: false,
			supportsReasoningEffort: false,
			maxTokensField: 'max_tokens',
		});
	});

	it('hides thinking levels mapped to null', () => {
		const model = {
			...newModel('m'),
			reasoning: true,
			thinkingLevelMap: { off: 'none', minimal: null, low: 'low', high: null },
		};
		expect(selectableThinkingLevels(model)).toEqual(['off', 'low', 'medium', 'xhigh', 'max']);
		expect(selectableThinkingLevels({ ...newModel('m'), reasoning: false })).toEqual(['off']);
	});

	it('only offers tool-calling models', () => {
		const s = mergeSettings({
			providers: [
				{
					...newProvider('p'),
					models: [{ ...newModel('a'), toolCalling: false }, newModel('b')],
				},
			],
			activeProviderId: 'p',
			activeModelId: 'a',
		});
		const pm = new ProviderManager(() => s);
		expect(pm.listSelectable().map((x) => x.model.id)).toEqual(['b']);
		expect(pm.getActive()).toBeUndefined();
	});
});

describe('request body (LIB-TEST-019, LIB-TEST-089, LIB-TEST-090)', () => {
	const provider = {
		...newProvider('openwebui'),
		baseUrl: 'https://llm.example/api/',
		compat: { supportsReasoningEffort: true, supportsStore: false },
		requestDefaults: {
			...newProvider('x').requestDefaults,
			temperature: 0.7,
			topP: 0.8,
			topK: 20,
			extraBody: { repetition_penalty: 1.1, model: 'evil', stream: true },
		},
	};
	const model = {
		...newModel('qwen'),
		reasoning: true,
		thinkingLevelMap: { off: 'none', low: 'low' },
		samplingParams: { min_p: 0.05 },
	};
	const pi = toPiModel(provider, model);

	it('puts sampling parameters and extra JSON in the body but never the reserved keys', () => {
		const opts = effectiveRequestOptions(provider, model, 'low');
		const body = buildRequestBody(pi, context('hi'), {
			temperature: opts.temperature,
			maxTokens: opts.maxTokens,
			samplingParams: opts.samplingParams,
			thinkingLevel: opts.thinkingLevel,
		});
		expect(body.temperature).toBe(0.7);
		expect(body.top_p).toBe(0.8);
		expect(body.top_k).toBe(20);
		expect(body.min_p).toBe(0.05);
		expect(body.repetition_penalty).toBe(1.1);
		expect(body.model).toBe('qwen');
		expect(body.stream).toBe(false);
		expect(body.max_tokens).toBe(8192);
		expect(body.reasoning_effort).toBe('low');
		expect(pi.baseUrl).toBe('https://llm.example/api');
	});

	it('keeps the instruction and tool prefix byte-identical across requests', () => {
		const first = buildRequestBody(pi, context('one'), {});
		const second = buildRequestBody(
			pi,
			context('one', [
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'a' }],
					api: 'openai-completions',
					provider: 'openwebui',
					model: 'qwen',
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: 'stop',
					timestamp: 2,
				},
				{ role: 'user', content: 'two', timestamp: 3 },
			]),
			{},
		);
		const prefix = (body: Record<string, unknown>) =>
			JSON.stringify({ system: (body.messages as unknown[])[0], tools: body.tools });
		expect(prefix(first)).toBe(prefix(second));
		expect(prefix(first)).not.toMatch(/timestamp|"t":/);
		const names = (first.tools as { function: { name: string } }[]).map((t) => t.function.name);
		expect(names).toEqual(['ls', 'find', 'grep', 'read', 'get_active_note', 'write', 'edit']);
		expect(
			Object.keys((first.tools as { function: Record<string, unknown> }[])[0]!.function),
		).toEqual(['name', 'description', 'parameters']);
	});

	it('adds cache markers only when the compat asks for them', () => {
		const plain = buildRequestBody(pi, context('x'), {});
		expect(JSON.stringify(plain)).not.toContain('cache_control');
		const marked = buildRequestBody(
			toPiModel(
				{ ...provider, compat: { ...provider.compat, cacheControlFormat: 'anthropic' } },
				model,
			),
			context('x'),
			{},
		);
		const tools = marked.tools as Record<string, unknown>[];
		expect(tools[tools.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
		expect((marked.messages as Record<string, unknown>[])[0]!.cache_control).toEqual({
			type: 'ephemeral',
		});
		expect(Object.keys(marked)).toEqual(Object.keys(plain));
	});
});

describe('secrets (LIB-TEST-024)', () => {
	it('validates ids and distinguishes missing from empty keys', () => {
		expect(isValidSecretId('vault-librarian-openwebui')).toBe(true);
		expect(isValidSecretId('LOCAL_LLM_API_KEY')).toBe(false);
		expect(isValidSecretId('a'.repeat(65))).toBe(false);
		const store = new SecretStore(app as unknown as App);
		expect(() => store.set('Bad_Id', 'x')).toThrow(/Invalid/);
		expect(store.get('vault-librarian-openwebui')).toBeNull();
		store.set('vault-librarian-openwebui', '');
		expect(store.get('vault-librarian-openwebui')).toBe('');
		store.set('vault-librarian-openwebui', 'secret');
		expect(store.get('vault-librarian-openwebui')).toBe('secret');
		store.clear('vault-librarian-openwebui');
		expect(store.get('vault-librarian-openwebui')).toBe('');
	});
});

describe('auto transport while the app is away (LIB-TEST-148)', () => {
	const g = globalThis as unknown as { window?: unknown; document?: unknown };
	afterEach(() => {
		delete g.window;
		delete g.document;
		noteVisibility();
		requestUrlMock.impl = null;
	});

	async function failOnce(visibility: 'hidden' | 'visible') {
		g.document = { visibilityState: visibility };
		noteVisibility();
		g.window = {
			fetch: async () => {
				throw new TypeError('Failed to fetch');
			},
		};
		let urlCalls = 0;
		requestUrlMock.impl = async () => {
			urlCalls++;
			throw new Error('UnknownHostException');
		};
		const provider = { ...newProvider('p'), baseUrl: 'https://x', transport: 'auto' as const };
		const model = { ...newModel('m'), contextWindow: 8000, maxTokens: 500 };
		provider.models = [model];
		const router = new TransportRouter();
		const streamFn = router.createStreamFn(provider, () => ({
			apiKey: 'k',
			authHeader: true,
			options: effectiveRequestOptions(provider, model, 'off'),
		}));
		const context = normalizeContext({
			systemPrompt: 's',
			messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
		});
		const stream = await streamFn(toPiModel(provider, model), context, {});
		const result = await stream.result();
		return { result, urlCalls, fellBack: router.hasFallenBack('p') };
	}

	it('a request blocked while the app is away fails without turning streaming off', async () => {
		const away = await failOnce('hidden');
		expect(away.result.stopReason).toBe('error');
		expect(away.urlCalls).toBe(0);
		expect(away.fellBack).toBe(false);
	});

	it('the same failure in front of the user is still treated as CORS and falls back', async () => {
		const front = await failOnce('visible');
		expect(front.urlCalls).toBe(1);
		expect(front.fellBack).toBe(true);
	});
});
