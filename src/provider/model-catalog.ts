import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models';
import { GOOGLE_MODELS } from '@earendil-works/pi-ai/providers/google.models';
import { GROQ_MODELS } from '@earendil-works/pi-ai/providers/groq.models';
import { HUGGINGFACE_MODELS } from '@earendil-works/pi-ai/providers/huggingface.models';
import { MISTRAL_MODELS } from '@earendil-works/pi-ai/providers/mistral.models';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models';
import {
	COMPLETIONS_API,
	type InputModality,
	type ModelConfig,
	newModel,
	type ProviderConfig,
	RESPONSES_API,
	type ThinkingLevel,
} from '../types';
import { ollamaDetails } from './ollama';
import type { ServerModel } from './transport';

/** The part of a Pi catalog entry a model's settings take. */
interface CatalogModel {
	name: string;
	api: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * Pi's model lists for the providers whose /models gives a name and nothing else, by the host of
 * their own API (LIB-FEAT-246). About 57 KB together; OpenRouter tells its own details.
 */
const CATALOGS: { host: RegExp; models: Record<string, CatalogModel> }[] = [
	{ host: /(^|\.)api\.openai\.com$/, models: OPENAI_MODELS },
	{ host: /(^|\.)generativelanguage\.googleapis\.com$/, models: GOOGLE_MODELS },
	{ host: /(^|\.)api\.x\.ai$/, models: XAI_MODELS },
	{ host: /(^|\.)api\.deepseek\.com$/, models: DEEPSEEK_MODELS },
	{ host: /(^|\.)api\.groq\.com$/, models: GROQ_MODELS },
	{ host: /(^|\.)api\.mistral\.ai$/, models: MISTRAL_MODELS },
];

/** A model's name without its owner, in lower case: `Qwen/Qwen3.8-27B` is `qwen3.8-27b`. */
const bare = (id: string) => id.slice(id.lastIndexOf('/') + 1).toLowerCase();

/**
 * Open-weight models by the Hugging Face name a self-hosted server (vLLM, Ollama) serves them
 * under, often without the owner or in other letter case (LIB-FEAT-292). About 35 KB.
 */
const OPEN_WEIGHTS = new Map<string, CatalogModel>(
	Object.entries(HUGGINGFACE_MODELS as Record<string, CatalogModel>).map(([id, m]) => [
		bare(id),
		m,
	]),
);

function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return '';
	}
}

/**
 * A model to add from a server's list. What the server says wins; what it leaves out comes from
 * Pi's list for that provider, or, behind a proxy such as Open WebUI, from any list that knows the
 * name, and last from the open-weight list by the model's own name. Only the provider's own server
 * takes the list's request format: a proxy that lists `gpt-6-luna` may speak only Chat
 * Completions. A self-hosted model's price is not the one the list quotes, so it stays 0.
 */
export function modelFromServer(baseUrl: string, server: ServerModel): ModelConfig {
	const own = CATALOGS.find((c) => c.host.test(hostOf(baseUrl)));
	// Google's OpenAI endpoint lists `models/gemini-...`.
	const id = server.id.replace(/^models\//, '');
	const known = own
		? own.models[id]
		: CATALOGS.map((c) => c.models[id]).find((m) => m !== undefined);
	const open =
		own || known
			? undefined
			: (OPEN_WEIGHTS.get(bare(server.root ?? id)) ?? OPEN_WEIGHTS.get(bare(id)));
	const listed = known ?? open;
	const model: ModelConfig = {
		...newModel(server.id),
		name: server.name ?? listed?.name ?? server.id,
	};
	if (listed) {
		model.reasoning = listed.reasoning;
		model.input = listed.input.filter((m): m is InputModality => m === 'text' || m === 'image');
		model.contextWindow = listed.contextWindow;
		model.maxTokens = listed.maxTokens;
		// A level map is written for one request format; another's would send the wrong words. The
		// Gemini list uses minimal to high, the words Google's OpenAI endpoint takes as
		// reasoning_effort, and maps what Gemini 3 cannot do (off, xhigh, max) to null (LIB-FEAT-250).
		const speaks = [COMPLETIONS_API, RESPONSES_API, 'google-generative-ai'].includes(
			listed.api,
		);
		if (speaks && listed.thinkingLevelMap)
			model.thinkingLevelMap = { ...listed.thinkingLevelMap };
	}
	if (known) {
		const { input, output, cacheRead, cacheWrite } = known.cost;
		model.cost = { input, output, cacheRead, cacheWrite };
		if (own && known.api === RESPONSES_API) model.api = RESPONSES_API;
	}
	if (server.contextWindow) model.contextWindow = server.contextWindow;
	if (server.maxTokens) model.maxTokens = server.maxTokens;
	if (server.input) model.input = server.input;
	if (server.reasoning !== undefined) model.reasoning = server.reasoning;
	if (server.toolCalling !== undefined) model.toolCalling = server.toolCalling;
	if (server.thinkingLevelMap) model.thinkingLevelMap = { ...server.thinkingLevelMap };
	if (!model.reasoning) delete model.thinkingLevelMap;
	const window = model.contextWindow;
	// With no output limit known, reasoning models on a large window get room to think, and a
	// small window keeps room for the conversation.
	if (!listed && !server.maxTokens)
		model.maxTokens = Math.min(Math.max(8192, Math.floor(window / 8)), Math.floor(window / 4));
	// An output limit as large as the window, as some lists give, would leave no room for input.
	model.maxTokens = Math.min(model.maxTokens, Math.floor(window / 2));
	return model;
}

/** A model from the server's list, with what Ollama tells about it when Ollama serves it. */
export async function describeServerModel(
	provider: ProviderConfig,
	apiKey: string | null,
	server: ServerModel,
): Promise<ModelConfig> {
	const details = await ollamaDetails(server, provider.baseUrl, apiKey, provider.authHeader);
	return modelFromServer(provider.baseUrl, { ...server, ...details });
}
