import type { Model } from '@earendil-works/pi-ai';
import type {
	LibrarianSettings,
	ModelConfig,
	ProviderCompat,
	ProviderConfig,
	ThinkingLevel,
} from '../types';
import { THINKING_LEVELS } from '../types';

export type PiModel = Model<'openai-completions'>;

export interface ActiveSelection {
	provider: ProviderConfig;
	model: ModelConfig;
}

/** Keys that AgentController owns; `extraBody` and sampling params may not override them. */
const RESERVED_BODY_KEYS = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream']);

export function mergeCompat(provider: ProviderConfig, model: ModelConfig): ProviderCompat {
	return { ...provider.compat, ...(model.compat ?? {}) };
}

export interface EffectiveRequestOptions {
	temperature?: number;
	maxTokens: number;
	timeoutMs: number;
	maxRetries: number;
	samplingParams: Record<string, unknown>;
	thinkingLevel: ThinkingLevel;
	stream: boolean;
}

export function effectiveRequestOptions(
	provider: ProviderConfig,
	model: ModelConfig,
	sessionThinkingLevel?: ThinkingLevel,
): EffectiveRequestOptions {
	const d = provider.requestDefaults;
	const sampling: Record<string, unknown> = {};
	if (d.topP !== undefined) sampling.top_p = d.topP;
	if (d.topK !== undefined) sampling.top_k = d.topK;
	if (d.minP !== undefined) sampling.min_p = d.minP;
	for (const [k, v] of Object.entries(d.extraBody ?? {})) {
		if (!RESERVED_BODY_KEYS.has(k)) sampling[k] = v;
	}
	for (const [k, v] of Object.entries(model.samplingParams ?? {})) {
		if (!RESERVED_BODY_KEYS.has(k)) sampling[k] = v;
	}
	return {
		temperature: d.temperature,
		maxTokens: d.maxTokens ?? model.maxTokens,
		timeoutMs: d.timeoutMs,
		maxRetries: d.maxRetries,
		samplingParams: sampling,
		thinkingLevel: sessionThinkingLevel ?? d.thinkingLevel ?? 'off',
		stream: d.stream !== false,
	};
}

/** Thinking levels the chat selector may offer for a model. `null` in the map hides a level. */
export function selectableThinkingLevels(model: ModelConfig): ThinkingLevel[] {
	if (!model.reasoning) return ['off'];
	const map = model.thinkingLevelMap;
	if (!map) return [...THINKING_LEVELS];
	return THINKING_LEVELS.filter((level) => map[level] !== null);
}

export function toPiModel(provider: ProviderConfig, model: ModelConfig): PiModel {
	const { cacheControlFormat, thinkingFormat, ...rest } = mergeCompat(provider, model);
	return {
		id: model.id,
		name: model.name,
		api: 'openai-completions',
		provider: provider.id,
		baseUrl: provider.baseUrl.replace(/\/+$/, ''),
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		compat: {
			...rest,
			...(cacheControlFormat ? { cacheControlFormat } : {}),
			...(thinkingFormat
				? {
						thinkingFormat: thinkingFormat as NonNullable<
							PiModel['compat']
						>['thinkingFormat'],
					}
				: {}),
		},
	};
}

export class ProviderManager {
	constructor(private readonly settings: () => LibrarianSettings) {}

	getProvider(id: string | null | undefined): ProviderConfig | undefined {
		return this.settings().providers.find((p) => p.id === id);
	}

	getModel(providerId: string | null | undefined, modelId: string | null | undefined) {
		const provider = this.getProvider(providerId);
		const model = provider?.models.find((m) => m.id === modelId);
		return provider && model ? { provider, model } : undefined;
	}

	/** Currently selected provider and model, only when the model can call tools. */
	getActive(): ActiveSelection | undefined {
		const s = this.settings();
		const found = this.getModel(s.activeProviderId, s.activeModelId);
		return found?.model.toolCalling ? found : undefined;
	}

	/** Every model the chat can pick: tool-calling models only. */
	listSelectable(): ActiveSelection[] {
		const out: ActiveSelection[] = [];
		for (const provider of this.settings().providers) {
			for (const model of provider.models)
				if (model.toolCalling) out.push({ provider, model });
		}
		return out;
	}
}
