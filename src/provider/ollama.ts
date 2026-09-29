import { requestUrl } from 'obsidian';
import { THINKING_LEVELS, type ThinkingLevel } from '../types';
import type { ServerModel } from './transport';

/** Ollama's cloud, which describes its models to anyone, without a key. */
export const OLLAMA_CLOUD_SHOW = 'https://ollama.com/api/show';

/**
 * Where Ollama describes a model the list names, or undefined when Ollama does not serve it
 * (LIB-FEAT-292). Open WebUI passes its Ollama connections' /api/show through under /ollama, and
 * a model it takes from Ollama's cloud over an OpenAI connection says so in `openai.owned_by`.
 * Ollama itself lists its own models as owned by `library`, its cloud's by `ollama`, at /v1 with
 * /api beside it.
 */
export function ollamaShowUrl(entry: Record<string, unknown>, baseUrl: string): string | undefined {
	const base = baseUrl.replace(/\/+$/, '');
	if (entry.owned_by === 'ollama' && entry.ollama && typeof entry.ollama === 'object')
		return `${base.replace(/\/api$/, '')}/ollama/api/show`;
	if ((entry.openai as { owned_by?: unknown } | undefined)?.owned_by === 'ollama')
		return OLLAMA_CLOUD_SHOW;
	if ((entry.owned_by === 'library' || entry.owned_by === 'ollama') && base.endsWith('/v1'))
		return `${base.slice(0, -3)}/api/show`;
	return undefined;
}

/**
 * The effort levels an Ollama model takes, from the thinking values /api/show lists: `false`
 * turns thinking off, which its OpenAI endpoint takes as `none`, and level names pick one. A model
 * whose values are only `false` and `true` thinks at any level, so it shows one. Ollama before
 * these values took low, medium, high and none.
 */
export function ollamaLevelMap(
	values: unknown[] = [false, 'low', 'medium', 'high'],
): Partial<Record<ThinkingLevel, string | null>> {
	const map: Partial<Record<ThinkingLevel, string | null>> = {};
	for (const level of THINKING_LEVELS) map[level] = values.includes(level) ? level : null;
	map.off = values.includes(false) ? 'none' : null;
	if (values.includes(true) && THINKING_LEVELS.every((l) => l === 'off' || map[l] === null))
		map.medium = 'medium';
	return map;
}

/**
 * What an /api/show answer says about a model. A context size set on the model (`num_ctx`) is
 * the one Ollama runs it with, so it wins over the size the model was made for.
 */
export function fromOllamaShow(show: unknown): Partial<ServerModel> {
	if (!show || typeof show !== 'object') return {};
	const s = show as {
		capabilities?: unknown;
		model_info?: Record<string, unknown>;
		parameters?: unknown;
		thinking?: { values?: unknown };
	};
	const out: Partial<ServerModel> = {};
	const set = typeof s.parameters === 'string' ? /^num_ctx\s+(\d+)/m.exec(s.parameters) : null;
	const made = Object.entries(s.model_info ?? {}).find(
		([key, value]) => key.endsWith('.context_length') && typeof value === 'number' && value > 0,
	)?.[1] as number | undefined;
	const size = set ? Number(set[1]) : made;
	if (size) out.contextWindow = size;
	if (Array.isArray(s.capabilities)) {
		const caps = s.capabilities as unknown[];
		out.input = caps.includes('vision') ? ['text', 'image'] : ['text'];
		out.toolCalling = caps.includes('tools');
		out.reasoning = caps.includes('thinking');
		if (out.reasoning) {
			const values = s.thinking?.values;
			out.thinkingLevelMap = ollamaLevelMap(Array.isArray(values) ? values : undefined);
		}
	}
	return out;
}

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return '';
	}
}

/**
 * Asks Ollama about a model the list said it serves; nothing when it cannot be asked. The key
 * goes only to the provider's own server: Ollama's cloud answers without one.
 */
export async function ollamaDetails(
	server: ServerModel,
	baseUrl: string,
	apiKey: string | null,
	authHeader: boolean,
): Promise<Partial<ServerModel>> {
	if (!server.show) return {};
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (authHeader && apiKey && originOf(server.show) === originOf(baseUrl))
		headers.Authorization = `Bearer ${apiKey}`;
	try {
		const response = await requestUrl({
			url: server.show,
			method: 'POST',
			headers,
			body: JSON.stringify({ model: server.id }),
			throw: false,
		});
		return response.status < 400 ? fromOllamaShow(response.json) : {};
	} catch {
		return {};
	}
}
