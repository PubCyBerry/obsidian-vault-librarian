import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models';
import { GOOGLE_MODELS } from '@earendil-works/pi-ai/providers/google.models';
import { GROQ_MODELS } from '@earendil-works/pi-ai/providers/groq.models';
import { MISTRAL_MODELS } from '@earendil-works/pi-ai/providers/mistral.models';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models';
import {
	COMPLETIONS_API,
	type InputModality,
	type ModelConfig,
	newModel,
	RESPONSES_API,
	type ThinkingLevel,
} from '../types';
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
 * name. Only the provider's own server takes the list's request format: a proxy that lists
 * `gpt-6-luna` may speak only Chat Completions.
 */
export function modelFromServer(baseUrl: string, server: ServerModel): ModelConfig {
	const own = CATALOGS.find((c) => c.host.test(hostOf(baseUrl)));
	// Google's OpenAI endpoint lists `models/gemini-...`.
	const id = server.id.replace(/^models\//, '');
	const known = own
		? own.models[id]
		: CATALOGS.map((c) => c.models[id]).find((m) => m !== undefined);
	const model: ModelConfig = {
		...newModel(server.id),
		name: server.name ?? known?.name ?? server.id,
	};
	if (known) {
		model.reasoning = known.reasoning;
		model.input = known.input.filter((m): m is InputModality => m === 'text' || m === 'image');
		model.contextWindow = known.contextWindow;
		model.maxTokens = known.maxTokens;
		const { input, output, cacheRead, cacheWrite } = known.cost;
		model.cost = { input, output, cacheRead, cacheWrite };
		// A level map is written for one request format; another's would send the wrong words. The
		// Gemini list uses minimal to high, the words Google's OpenAI endpoint takes as
		// reasoning_effort, and maps what Gemini 3 cannot do (off, xhigh, max) to null (LIB-FEAT-250).
		const speaks = [COMPLETIONS_API, RESPONSES_API, 'google-generative-ai'].includes(known.api);
		if (speaks && known.thinkingLevelMap)
			model.thinkingLevelMap = { ...known.thinkingLevelMap };
		if (own && known.api === RESPONSES_API) model.api = RESPONSES_API;
	}
	if (server.contextWindow) model.contextWindow = server.contextWindow;
	if (server.maxTokens) model.maxTokens = server.maxTokens;
	if (server.input) model.input = server.input;
	if (server.reasoning !== undefined) model.reasoning = server.reasoning;
	if (server.toolCalling !== undefined) model.toolCalling = server.toolCalling;
	// With no output limit known, a small window cannot hold the default output reserve.
	if (!known && !server.maxTokens)
		model.maxTokens = Math.min(model.maxTokens, Math.floor(model.contextWindow / 4));
	return model;
}
