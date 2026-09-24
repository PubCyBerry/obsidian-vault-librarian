import { describe, expect, it } from 'vitest';
import { modelFromServer } from '../src/provider/model-catalog';
import { apiOf, toPiModel } from '../src/provider/provider-manager';
import { COMPLETIONS_API, newProvider, RESPONSES_API } from '../src/types';

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
