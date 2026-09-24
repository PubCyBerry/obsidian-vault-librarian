import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import type { App } from 'obsidian';
import { afterEach, describe, expect, it } from 'vitest';
import { modelFromServer } from '../src/provider/model-catalog';
import {
	effectiveRequestOptions,
	mergeCompat,
	ProviderManager,
	selectableThinkingLevels,
	toPiModel,
} from '../src/provider/provider-manager';
import {
	buildRequestBody,
	createDiagnosticFetch,
	TransportRouter,
	testConnection,
	UNSIGNED_CALL,
} from '../src/provider/transport';
import { isValidSecretId, SecretStore } from '../src/storage/secret-store';
import { createVaultTools } from '../src/tools/registry';
import { mergeSettings, newModel, newProvider } from '../src/types';
import { noteVisibility } from '../src/visibility';
import { FakeApp } from './fake-app';
import { Platform, requestUrlMock } from './obsidian-stub';

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
					return {
						status: 200,
						json: {
							data: [
								{ id: 'model' },
								{ id: 'qwen', name: 'Qwen', max_model_len: 262144 },
								{ id: 'router', context_length: 131072 },
								{ name: 'no id' },
								// OpenRouter's entry also tells the output limit, inputs and parameters (LIB-TEST-248).
								{
									id: 'openai/gpt-6-luna',
									context_length: 1050000,
									top_provider: { max_completion_tokens: 128000 },
									architecture: { input_modalities: ['text', 'image', 'file'] },
									supported_parameters: ['tools', 'reasoning', 'max_tokens'],
								},
							],
						},
					};
				};
				expect(await testConnection(provider, 'key')).toEqual({
					ok: true,
					models: [
						{ id: 'model' },
						{ id: 'qwen', name: 'Qwen', contextWindow: 262144 },
						{ id: 'router', contextWindow: 131072 },
						{
							id: 'openai/gpt-6-luna',
							contextWindow: 1050000,
							maxTokens: 128000,
							input: ['text', 'image'],
							reasoning: true,
							toolCalling: true,
						},
					],
				});
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

describe("Gemini's thought signatures (LIB-TEST-251)", () => {
	afterEach(() => {
		requestUrlMock.impl = null;
	});

	const google = {
		...newProvider('google'),
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
		transport: 'requestUrl' as const,
	};
	const gemini = modelFromServer(google.baseUrl, { id: 'models/gemini-3.6-flash' });
	const signedCall = {
		id: 'call_a',
		type: 'function',
		function: { name: 'grep', arguments: '{"query":"x"}' },
		extra_content: { google: { thought_signature: 'SIG_A' } },
	};
	const assistant = (calls: { id: string; signature?: string }[]) => ({
		role: 'assistant' as const,
		content: calls.map((c) => ({
			type: 'toolCall' as const,
			id: c.id,
			name: 'grep',
			arguments: { query: 'x' },
			...(c.signature ? { thoughtSignature: c.signature } : {}),
		})),
		api: 'openai-completions',
		provider: 'google',
		model: gemini.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: 'toolUse' as const,
		timestamp: 2,
	});
	const result = (id: string) => ({
		role: 'toolResult' as const,
		toolCallId: id,
		toolName: 'grep',
		content: [{ type: 'text' as const, text: 'none' }],
		isError: false,
		timestamp: 3,
	});

	it('keeps the signature of a call through requestUrl and sends it back', async () => {
		requestUrlMock.impl = async () => ({
			status: 200,
			json: {
				choices: [
					{
						message: { content: '', tool_calls: [signedCall] },
						finish_reason: 'tool_calls',
					},
				],
			},
		});
		const streamFn = new TransportRouter().createStreamFn(google, () => ({
			apiKey: 'k',
			authHeader: true,
			options: effectiveRequestOptions(google, gemini, 'low'),
		}));
		const first = await (
			await streamFn(toPiModel(google, gemini), context('find x'), {})
		).result();
		expect(first.content).toContainEqual(
			expect.objectContaining({ type: 'toolCall', id: 'call_a', thoughtSignature: 'SIG_A' }),
		);

		const body = buildRequestBody(
			toPiModel(google, gemini) as Parameters<typeof buildRequestBody>[0],
			context('find x', [
				assistant([{ id: 'call_a', signature: 'SIG_A' }]),
				result('call_a'),
			]),
			{ thinkingLevel: 'low' },
		);
		const sent = (body.messages as { role: string; tool_calls?: unknown[] }[]).find(
			(m) => m.role === 'assistant',
		);
		expect(sent?.tool_calls?.[0]).toMatchObject({
			id: 'call_a',
			extra_content: { google: { thought_signature: 'SIG_A' } },
		});
		// Google's endpoint takes reasoning_effort, and Gemini 3 offers minimal to high only.
		expect(body.reasoning_effort).toBe('low');
		expect(selectableThinkingLevels(gemini)).toEqual(['minimal', 'low', 'medium', 'high']);
	});

	it("gives Google's placeholder to an unsigned first call, and nothing to other servers", () => {
		const history = [
			assistant([{ id: 'old_1' }, { id: 'old_2' }]),
			result('old_1'),
			result('old_2'),
		];
		const messages = (
			buildRequestBody(
				toPiModel(google, gemini) as Parameters<typeof buildRequestBody>[0],
				context('again', history),
				{},
			).messages as { role: string; tool_calls?: { extra_content?: unknown }[] }[]
		).find((m) => m.role === 'assistant')!;
		expect(messages.tool_calls?.[0]?.extra_content).toEqual({
			google: { thought_signature: UNSIGNED_CALL },
		});
		expect(messages.tool_calls?.[1]?.extra_content).toBeUndefined();

		const local = { ...newProvider('local'), baseUrl: 'http://localhost:8000/v1' };
		const plain = (
			buildRequestBody(
				toPiModel(local, newModel('m')) as Parameters<typeof buildRequestBody>[0],
				context('again', history),
				{},
			).messages as { role: string; tool_calls?: { extra_content?: unknown }[] }[]
		).find((m) => m.role === 'assistant')!;
		expect(plain.tool_calls?.[0]?.extra_content).toBeUndefined();
	});

	it('reads the signature out of a streamed response for the finished message', async () => {
		const chunks = [
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									...signedCall,
									function: { name: 'grep', arguments: '' },
								},
							],
						},
					},
				],
			},
			{
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, function: { arguments: '{"query":"x"}' } }],
						},
					},
				],
			},
		];
		const text = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
		const diag = createDiagnosticFetch(async () => new Response(text, { status: 200 }));
		await (await diag.fetch('https://x')).text();
		const message = assistant([{ id: 'call_a' }]);
		diag.sign(message as unknown as Parameters<typeof diag.sign>[0]);
		expect(message.content[0]).toMatchObject({ thoughtSignature: 'SIG_A' });
	});
});

describe('Responses API (LIB-TEST-249)', () => {
	afterEach(() => {
		requestUrlMock.impl = null;
	});

	const sse = (events: Record<string, unknown>[]) =>
		new TextEncoder().encode(
			events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
		).buffer;
	const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read' };
	const args = '{"path":"a.md"}';

	it('goes to /responses with the reasoning effort and tools, also through requestUrl', async () => {
		const sent: { url: string; body: Record<string, unknown> }[] = [];
		requestUrlMock.impl = async (request) => {
			const r = request as { url: string; body: string };
			sent.push({ url: r.url, body: JSON.parse(r.body) });
			return {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
				arrayBuffer: sse([
					{
						type: 'response.created',
						response: { id: 'resp_1', status: 'in_progress', output: [] },
					},
					{
						type: 'response.output_item.added',
						output_index: 0,
						item: { ...call, arguments: '', status: 'in_progress' },
					},
					{
						type: 'response.function_call_arguments.delta',
						item_id: 'fc_1',
						output_index: 0,
						delta: args,
					},
					{
						type: 'response.output_item.done',
						output_index: 0,
						item: { ...call, arguments: args, status: 'completed' },
					},
					{
						type: 'response.completed',
						response: {
							id: 'resp_1',
							status: 'completed',
							output: [{ ...call, arguments: args, status: 'completed' }],
							usage: {
								input_tokens: 20,
								output_tokens: 5,
								total_tokens: 25,
								input_tokens_details: { cached_tokens: 0 },
								output_tokens_details: { reasoning_tokens: 3 },
							},
						},
					},
				]),
			};
		};
		const provider = {
			...newProvider('openai'),
			baseUrl: 'https://api.openai.com/v1',
			transport: 'requestUrl' as const,
		};
		const model = modelFromServer(provider.baseUrl, { id: 'gpt-6-luna' });
		provider.models = [model];
		const streamFn = new TransportRouter().createStreamFn(provider, () => ({
			apiKey: 'k',
			authHeader: true,
			options: effectiveRequestOptions(provider, model, 'medium'),
		}));
		const read = createVaultTools({
			app: new FakeApp() as unknown as App,
			settings: () => mergeSettings({}),
		}).find((t) => t.name === 'read')!;
		const context = normalizeContext({
			systemPrompt: 's',
			messages: [{ role: 'user', content: 'read a.md', timestamp: 0 }],
			tools: [read],
		});
		const stream = await streamFn(toPiModel(provider, model), context, { reasoning: 'medium' });
		const result = await stream.result();

		expect(sent).toHaveLength(1);
		expect(sent[0]!.url).toBe('https://api.openai.com/v1/responses');
		expect(sent[0]!.body).toMatchObject({
			model: 'gpt-6-luna',
			reasoning: { effort: 'medium' },
			tools: [expect.objectContaining({ type: 'function', name: 'read' })],
		});
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe('toolUse');
		expect(result.content).toContainEqual(
			expect.objectContaining({
				type: 'toolCall',
				name: 'read',
				arguments: { path: 'a.md' },
			}),
		);
	});
});

describe('auto transport while the app is away (LIB-TEST-148)', () => {
	const g = globalThis as unknown as { window?: unknown; document?: unknown };
	afterEach(() => {
		delete g.window;
		delete g.document;
		Platform.isMobile = false;
		noteVisibility();
		requestUrlMock.impl = null;
	});

	async function failOnce(visibility: 'hidden' | 'visible') {
		g.document = { visibilityState: visibility };
		Platform.isMobile = true;
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
