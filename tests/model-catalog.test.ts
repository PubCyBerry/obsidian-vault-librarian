import { describe, expect, it } from 'vitest';
import { describeServerModel, modelFromServer } from '../src/provider/model-catalog';
import {
	fromOllamaShow,
	OLLAMA_CLOUD_SHOW,
	ollamaDetails,
	ollamaShowUrl,
} from '../src/provider/ollama';
import { apiOf, toPiModel } from '../src/provider/provider-manager';
import { COMPLETIONS_API, newProvider, RESPONSES_API } from '../src/types';
import { requestUrlMock } from './obsidian-stub';

describe('models added from a server (LIB-TEST-248)', () => {
	it("fills what OpenAI's list leaves out from Pi's catalog, with its request format", () => {
		const model = modelFromServer('https://api.openai.com/v1', { id: 'gpt-6-luna' });
		expect(model).toMatchObject({
			id: 'gpt-6-luna',
			name: 'GPT-6 Luna',
			api: RESPONSES_API,
			reasoning: true,
			input: ['text', 'image'],
			maxTokens: 128000,
			thinkingLevelMap: { off: 'none', minimal: null, medium: 'medium' },
		});
		expect(model.contextWindow).toBeGreaterThanOrEqual(272000);
		expect(model.cost.input).toBeGreaterThan(0);
	});

	it('behind a proxy takes the details but keeps Chat Completions', () => {
		const model = modelFromServer('http://localhost:3000/api', { id: 'gpt-6-luna' });
		expect(model.reasoning).toBe(true);
		expect(model.api).toBeUndefined();
	});

	it("what the server itself reports wins, as OpenRouter's list does", () => {
		const model = modelFromServer('https://openrouter.ai/api/v1', {
			id: 'openai/gpt-6-luna',
			name: 'OpenAI: GPT-6 Luna',
			contextWindow: 1050000,
			maxTokens: 128000,
			input: ['text', 'image'],
			reasoning: true,
			toolCalling: true,
		});
		expect(model).toMatchObject({
			name: 'OpenAI: GPT-6 Luna',
			contextWindow: 1050000,
			maxTokens: 128000,
			input: ['text', 'image'],
			reasoning: true,
		});
		expect(model.api).toBeUndefined();
	});

	it('an unknown model keeps the defaults, with the output reserve fitting a small window', () => {
		const model = modelFromServer('http://localhost:8000/v1', {
			id: 'qwen-local',
			contextWindow: 16000,
		});
		expect(model).toMatchObject({ reasoning: false, input: ['text'], contextWindow: 16000 });
		expect(model.maxTokens).toBe(4000);
	});
});

describe('request format (LIB-TEST-249)', () => {
	it("a model's override wins over its provider, and anything unknown is Chat Completions", () => {
		const provider = { ...newProvider('p'), baseUrl: 'https://api.openai.com/v1' };
		const model = modelFromServer(provider.baseUrl, { id: 'gpt-6-luna' });
		expect(apiOf(provider, model)).toBe(RESPONSES_API);
		expect(toPiModel(provider, model)).toMatchObject({ api: RESPONSES_API });
		expect(toPiModel(provider, model)).not.toHaveProperty('compat');
		expect(apiOf({ ...provider, api: RESPONSES_API }, { ...model, api: undefined })).toBe(
			RESPONSES_API,
		);
		expect(
			apiOf({ ...provider, api: 'anthropic-messages' }, { ...model, api: undefined }),
		).toBe(COMPLETIONS_API);
	});
});

// /api/show answers as Ollama's cloud gave them on 2026-09-29, without the long fields.
const KIMI_K3 = {
	capabilities: ['vision', 'thinking', 'completion', 'tools'],
	model_info: { 'general.architecture': 'kimi-k3', 'kimi-k3.context_length': 1048576 },
	thinking: { values: [false, 'low', 'high', 'max'], default: 'max' },
};
const GEMMA4 = {
	capabilities: ['completion', 'thinking', 'tools', 'vision'],
	model_info: { 'gemma4.context_length': 262144 },
	thinking: { values: [false, true], default: false },
};
const GLM_53 = {
	capabilities: ['completion', 'thinking', 'tools'],
	model_info: { 'glm_dsa_moe.context_length': 1048576 },
	thinking: { values: ['low', 'high', 'max'], default: 'max' },
};
const KIMI_K27_CODE = {
	capabilities: ['vision', 'thinking', 'completion', 'tools'],
	model_info: { 'kimi-k2.context_length': 262144 },
	thinking: { values: [false, true], default: true },
};

describe('models Ollama serves and open-weight models (LIB-TEST-295)', () => {
	it('knows where Ollama describes a model, behind Open WebUI and on its own', () => {
		const webui = 'https://llm.example/api';
		// Open WebUI's Ollama connection, its OpenAI connection to Ollama's cloud, and a vLLM model.
		expect(ollamaShowUrl({ id: 'qwen3:32b', owned_by: 'ollama', ollama: {} }, webui)).toBe(
			'https://llm.example/ollama/api/show',
		);
		expect(
			ollamaShowUrl(
				{ id: 'kimi-k3', owned_by: 'openai', openai: { owned_by: 'ollama' } },
				webui,
			),
		).toBe(OLLAMA_CLOUD_SHOW);
		expect(
			ollamaShowUrl(
				{ id: 'qwen3.8-27B', owned_by: 'openai', openai: { owned_by: 'openai' } },
				webui,
			),
		).toBeUndefined();
		// Ollama itself, local and in the cloud.
		expect(
			ollamaShowUrl({ id: 'gemma4', owned_by: 'library' }, 'http://localhost:11434/v1/'),
		).toBe('http://localhost:11434/api/show');
		expect(ollamaShowUrl({ id: 'kimi-k3', owned_by: 'ollama' }, 'https://ollama.com/v1')).toBe(
			OLLAMA_CLOUD_SHOW,
		);
		expect(
			ollamaShowUrl({ id: 'gpt-6-luna', owned_by: 'system' }, 'https://api.openai.com/v1'),
		).toBeUndefined();
	});

	it("reads the capabilities, the window and the thinking values from Ollama's answer", () => {
		expect(fromOllamaShow(KIMI_K3)).toEqual({
			contextWindow: 1048576,
			input: ['text', 'image'],
			toolCalling: true,
			reasoning: true,
			thinkingLevelMap: {
				off: 'none',
				minimal: null,
				low: 'low',
				medium: null,
				high: 'high',
				xhigh: null,
				max: 'max',
			},
		});
		// Thinking that is only on or off shows as one level; no false means it cannot be turned off.
		expect(fromOllamaShow(GEMMA4).thinkingLevelMap).toEqual({
			off: 'none',
			minimal: null,
			low: null,
			medium: 'medium',
			high: null,
			xhigh: null,
			max: null,
		});
		expect(fromOllamaShow(GLM_53)).toMatchObject({
			input: ['text'],
			thinkingLevelMap: { off: null, low: 'low', high: 'high', max: 'max' },
		});
		// Older Ollama lists no values; a context size set on the model is the one it runs with.
		expect(
			fromOllamaShow({
				capabilities: ['completion', 'thinking'],
				model_info: { 'qwen3.context_length': 40960 },
				parameters: 'num_ctx                        16384\nstop "<|im_end|>"',
			}),
		).toEqual({
			contextWindow: 16384,
			input: ['text'],
			toolCalling: false,
			reasoning: true,
			thinkingLevelMap: {
				off: 'none',
				minimal: null,
				low: 'low',
				medium: 'medium',
				high: 'high',
				xhigh: null,
				max: null,
			},
		});
		expect(fromOllamaShow({ error: "model 'x' not found" })).toEqual({});
	});

	it("sends the key only to the provider's own server", async () => {
		const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
		requestUrlMock.impl = async (request) => {
			seen.push(request as (typeof seen)[number]);
			return { status: 200, json: KIMI_K3 };
		};
		try {
			const webui = 'https://llm.example/api';
			await ollamaDetails({ id: 'kimi-k3', show: OLLAMA_CLOUD_SHOW }, webui, 'secret', true);
			await ollamaDetails(
				{ id: 'qwen3:32b', show: 'https://llm.example/ollama/api/show' },
				webui,
				'secret',
				true,
			);
			expect(seen[0]).toMatchObject({ url: OLLAMA_CLOUD_SHOW, body: '{"model":"kimi-k3"}' });
			expect(seen[0]!.headers.Authorization).toBeUndefined();
			expect(seen[1]!.headers.Authorization).toBe('Bearer secret');
			// A model Ollama does not serve asks nothing; a failed answer adds nothing.
			expect(await ollamaDetails({ id: 'qwen3.8-27B' }, webui, 'secret', true)).toEqual({});
			requestUrlMock.impl = async () => ({ status: 404, json: { error: 'not found' } });
			expect(
				await ollamaDetails({ id: 'x', show: OLLAMA_CLOUD_SHOW }, webui, 'secret', true),
			).toEqual({});
			expect(seen).toHaveLength(2);
		} finally {
			requestUrlMock.impl = null;
		}
	});

	it("fills a self-hosted model from the open-weight list by its own name, without the list's price", () => {
		const model = modelFromServer('https://llm.example/api', { id: 'qwen3.8-27B' });
		expect(model).toMatchObject({
			name: 'Qwen3.8 27B',
			reasoning: true,
			input: ['text', 'image'],
			contextWindow: 262144,
			maxTokens: 32768,
			thinkingLevelMap: {
				off: null,
				low: 'low',
				medium: 'medium',
				high: null,
				xhigh: 'xhigh',
			},
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(model.api).toBeUndefined();
		// vLLM serves the model under an alias; the list names it, and the server's window wins.
		expect(
			modelFromServer('http://localhost:8000/v1', {
				id: 'house-model',
				root: 'Qwen/Qwen3.8-27B',
				contextWindow: 131072,
			}),
		).toMatchObject({
			name: 'Qwen3.8 27B',
			reasoning: true,
			contextWindow: 131072,
			maxTokens: 32768,
		});
		// A provider's own server keeps to its own list.
		expect(modelFromServer('https://api.openai.com/v1', { id: 'qwen3.8-27B' }).reasoning).toBe(
			false,
		);
	});

	it('takes what Ollama says over the lists, and keeps room for the conversation', async () => {
		requestUrlMock.impl = async (request) => {
			const model = JSON.parse((request as { body: string }).body).model as string;
			const show = {
				'kimi-k3': KIMI_K3,
				'gemma4:31b': GEMMA4,
				'kimi-k2.7-code': KIMI_K27_CODE,
			}[model];
			return show ? { status: 200, json: show } : { status: 404, json: {} };
		};
		try {
			const provider = { ...newProvider('openwebui'), baseUrl: 'https://llm.example/api' };
			const cloud = (id: string) => ({ id, show: OLLAMA_CLOUD_SHOW });
			const kimi = await describeServerModel(provider, 'secret', cloud('kimi-k3'));
			// The window and levels are Ollama's; the output limit is the open-weight list's.
			expect(kimi).toMatchObject({
				name: 'Kimi K3',
				contextWindow: 1048576,
				maxTokens: 131072,
				reasoning: true,
				toolCalling: true,
				input: ['text', 'image'],
				thinkingLevelMap: { off: 'none', medium: null, high: 'high', max: 'max' },
			});
			// No list knows gemma4:31b: an eighth of a large window, at most a quarter.
			const gemma = await describeServerModel(provider, 'secret', cloud('gemma4:31b'));
			expect(gemma).toMatchObject({
				name: 'gemma4:31b',
				contextWindow: 262144,
				maxTokens: 32768,
			});
			// The list's output limit is the whole window; half of it stays for the input.
			const code = await describeServerModel(provider, 'secret', cloud('kimi-k2.7-code'));
			expect(code).toMatchObject({ contextWindow: 262144, maxTokens: 131072 });
			expect(code.thinkingLevelMap).toMatchObject({
				off: 'none',
				medium: 'medium',
				high: null,
			});
		} finally {
			requestUrlMock.impl = null;
		}
	});
});
