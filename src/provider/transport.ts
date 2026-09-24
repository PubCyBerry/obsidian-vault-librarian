import type { StreamFn } from '@earendil-works/pi-agent-core';
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	SimpleStreamOptions,
	StopReason,
	ToolCall,
	TranscriptContext,
	Usage,
} from '@earendil-works/pi-ai';
import { convertMessages, streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as streamResponses } from '@earendil-works/pi-ai/api/openai-responses';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { parseStreamingJson } from '@earendil-works/pi-ai/utils/json-parse';
import {
	getCurrentTools,
	resolveTranscript,
	toToolDeclaration,
} from '@earendil-works/pi-ai/utils/transcript';
import { requestUrl } from 'obsidian';
import { requestUrlFetch } from '../mcp/fetch-shim';
import type { InputModality, ProviderConfig, ThinkingLevel, TransportMode } from '../types';
import { appIsHidden, wasHiddenSince } from '../visibility';
import type { CompletionsModel, EffectiveRequestOptions, PiModel } from './provider-manager';

export const NO_STREAMING_NOTICE =
	'Streaming is not available for this provider. Waiting for the full response.';
export const FETCH_FAILED_NOTICE =
	'Request failed. Try the requestUrl transport for this provider.';
export const TOOLS_REJECTED_NOTICE =
	'This endpoint rejected tool calling. Check the provider settings.';

export interface TransportEvents {
	/** The request is going out without streaming, so the UI should show a waiting state. */
	onNonStreaming?: () => void;
	/** A fetch attempt failed before any response and the provider fell back to requestUrl. */
	onFallback?: (providerId: string) => void;
}

export interface ResolvedRequest {
	/** `null` means the key is not set on this device; `''` means connect without a key. */
	apiKey: string | null;
	authHeader: boolean;
	options: EffectiveRequestOptions;
}

type Compat = NonNullable<CompletionsModel['compat']>;

/** Fill the defaults `pi-ai` derives from the URL so `convertMessages` gets a complete compat. */
function resolveCompat(model: CompletionsModel) {
	const c: Compat = model.compat ?? {};
	return {
		supportsStore: c.supportsStore ?? false,
		supportsDeveloperRole: c.supportsDeveloperRole ?? false,
		// Google's OpenAI endpoint takes it, as pi-ai's own detection says (LIB-FEAT-250).
		supportsReasoningEffort: c.supportsReasoningEffort ?? isGoogle(model.baseUrl),
		supportsUsageInStreaming: c.supportsUsageInStreaming ?? true,
		supportsFinishReason: c.supportsFinishReason ?? true,
		maxTokensField: c.maxTokensField ?? 'max_tokens',
		requiresToolResultName: c.requiresToolResultName ?? false,
		requiresAssistantAfterToolResult: c.requiresAssistantAfterToolResult ?? false,
		requiresThinkingAsText: c.requiresThinkingAsText ?? false,
		requiresReasoningContentOnAssistantMessages:
			c.requiresReasoningContentOnAssistantMessages ?? false,
		thinkingFormat: c.thinkingFormat ?? 'openai',
		chatTemplateKwargs: c.chatTemplateKwargs ?? {},
		chatTemplateArgs: c.chatTemplateArgs ?? {},
		openRouterRouting: c.openRouterRouting ?? {},
		vercelGatewayRouting: c.vercelGatewayRouting ?? {},
		zaiToolStream: c.zaiToolStream ?? false,
		supportsOpenAIGrammarTools: c.supportsOpenAIGrammarTools ?? false,
		supportsStrictMode: c.supportsStrictMode ?? true,
		sendSessionAffinityHeaders: c.sendSessionAffinityHeaders ?? false,
		sessionAffinityFormat: c.sessionAffinityFormat ?? 'openai',
		supportsLongCacheRetention: c.supportsLongCacheRetention ?? false,
		cacheControlFormat: c.cacheControlFormat,
		supportsThinkingTokenBudget: c.supportsThinkingTokenBudget,
		thinkingTokenBudgetField: c.thinkingTokenBudgetField,
		supportsMidConvoSystemMessages: c.supportsMidConvoSystemMessages,
		supportsMidConvoToolAdditions: c.supportsMidConvoToolAdditions,
		vllmPriority: c.vllmPriority,
	};
}

function mapStopReason(reason: string | null | undefined): StopReason {
	switch (reason) {
		case 'stop':
		case 'end':
		case null:
		case undefined:
			return 'stop';
		case 'tool_calls':
		case 'function_call':
			return 'toolUse';
		case 'length':
			return 'length';
		default:
			return 'error';
	}
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function usageFrom(model: CompletionsModel, raw: Record<string, unknown> | undefined): Usage {
	const u = emptyUsage();
	if (!raw) return u;
	const n = (v: unknown) => (typeof v === 'number' ? v : 0);
	const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
	u.cacheRead = n(details?.cached_tokens);
	u.input = Math.max(0, n(raw.prompt_tokens) - u.cacheRead);
	u.output = n(raw.completion_tokens);
	u.totalTokens = n(raw.total_tokens) || u.input + u.output + u.cacheRead;
	const per = 1_000_000;
	u.cost = {
		input: (u.input * model.cost.input) / per,
		output: (u.output * model.cost.output) / per,
		cacheRead: (u.cacheRead * model.cost.cacheRead) / per,
		cacheWrite: 0,
		total: 0,
	};
	u.cost.total = u.cost.input + u.cost.output + u.cost.cacheRead;
	return u;
}

function reasoningEffort(
	model: CompletionsModel,
	level: ThinkingLevel | undefined,
): string | undefined {
	if (!model.reasoning) return undefined;
	const wanted = level ?? 'off';
	const mapped = model.thinkingLevelMap?.[wanted];
	if (mapped === null) return undefined;
	if (mapped !== undefined) return mapped;
	return wanted === 'off' ? undefined : wanted;
}

/** Google's placeholder for a call it did not sign, such as one kept before signatures were. */
export const UNSIGNED_CALL = 'skip_thought_signature_validator';

function isGoogle(baseUrl: string): boolean {
	try {
		return /(^|\.)generativelanguage\.googleapis\.com$/.test(new URL(baseUrl).hostname);
	} catch {
		return false;
	}
}

type SignedCall = { id?: string; extra_content?: { google?: { thought_signature?: unknown } } };

/** The signature Gemini put on a call in a Chat Completions response, if any. */
function signatureOf(call: SignedCall): string | undefined {
	const value = call.extra_content?.google?.thought_signature;
	return typeof value === 'string' && value ? value : undefined;
}

/**
 * Gemini signs the first function call of each step and wants that signature back on the call in
 * every later request, under `extra_content.google` (LIB-FEAT-250). Calls keep the signatures
 * their responses gave; on Google's own endpoint a first call without one, such as one from
 * another model or an older session, gets Google's placeholder instead of a 400.
 */
export function withThoughtSignatures(
	messages: unknown[],
	context: TranscriptContext,
	baseUrl: string,
): void {
	const signed = new Map<string, string>();
	for (const m of context.messages)
		if (m.role === 'assistant')
			for (const c of m.content)
				if (c.type === 'toolCall' && c.thoughtSignature)
					signed.set(c.id, c.thoughtSignature);
	const google = isGoogle(baseUrl);
	if (!signed.size && !google) return;
	for (const m of messages as { role?: string; tool_calls?: SignedCall[] }[]) {
		if (m.role !== 'assistant' || !m.tool_calls) continue;
		m.tool_calls.forEach((call, i) => {
			const signature =
				(call.id ? signed.get(call.id) : undefined) ??
				(google && i === 0 ? UNSIGNED_CALL : undefined);
			if (signature) call.extra_content = { google: { thought_signature: signature } };
		});
	}
}

/**
 * The non-streaming request body. Assembly order is fixed so the prefix stays byte-identical
 * across requests of the same conversation: instructions and tools first, conversation last.
 */
export function buildRequestBody(
	model: CompletionsModel,
	context: TranscriptContext,
	options: SimpleStreamOptions & { thinkingLevel?: ThinkingLevel },
): Record<string, unknown> {
	const compat = resolveCompat(model);
	const transcript = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
	const messages = convertMessages(model, transcript, compat);
	const tools = getCurrentTools(transcript.messages).map((tool) => {
		const decl = toToolDeclaration(tool);
		return {
			type: 'function',
			function: {
				name: decl.name,
				description: decl.description,
				parameters: decl.parameters,
			},
		};
	});
	withThoughtSignatures(messages, transcript, model.baseUrl);
	const body: Record<string, unknown> = { model: model.id, messages };
	if (tools.length > 0) body.tools = tools;
	body.stream = false;
	if (options.maxTokens) body[compat.maxTokensField] = options.maxTokens;
	if (options.temperature !== undefined) body.temperature = options.temperature;
	if (compat.supportsStore) body.store = false;
	const effort = compat.supportsReasoningEffort
		? reasoningEffort(model, options.thinkingLevel ?? options.reasoning)
		: undefined;
	if (effort !== undefined) body.reasoning_effort = effort;
	if (compat.cacheControlFormat === 'anthropic') {
		const first = messages[0] as Record<string, unknown> | undefined;
		if (first && first.role === 'system') first.cache_control = { type: 'ephemeral' };
		const lastTool = tools[tools.length - 1] as Record<string, unknown> | undefined;
		if (lastTool) lastTool.cache_control = { type: 'ephemeral' };
	}
	if (options.samplingParams) Object.assign(body, options.samplingParams);
	return body;
}

function buildHeaders(apiKey: string | null, authHeader: boolean): Record<string, string> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (authHeader && apiKey) headers.Authorization = `Bearer ${apiKey}`;
	return headers;
}

/** OpenAI-compatible request through Obsidian's `requestUrl`: no CORS, but no streaming either. */
export function streamViaRequestUrl(
	model: CompletionsModel,
	context: TranscriptContext,
	options: SimpleStreamOptions & { thinkingLevel?: ThinkingLevel },
	auth: { apiKey: string | null; authHeader: boolean },
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: 'assistant',
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: 'pending',
		timestamp: Date.now(),
	};
	const startedAt = Date.now();
	void (async () => {
		try {
			const body = buildRequestBody(model, context, options);
			const response = await requestUrl({
				url: `${model.baseUrl}/chat/completions`,
				method: 'POST',
				headers: buildHeaders(auth.apiKey, auth.authHeader),
				body: JSON.stringify(body),
				throw: false,
			});
			if (options.signal?.aborted) throw new Error('Request was aborted');
			if (response.status >= 400) {
				throw new Error(`${response.status}: ${response.text.slice(0, 4000)}`);
			}
			const json = response.json as Record<string, unknown>;
			const choice = (json.choices as Record<string, unknown>[] | undefined)?.[0];
			const message = (choice?.message ?? {}) as Record<string, unknown>;
			output.usage = usageFrom(model, json.usage as Record<string, unknown> | undefined);
			if (typeof json.id === 'string') output.responseId = json.id;
			stream.push({ type: 'start', partial: output });
			const reasoning =
				(message.reasoning_content as string | undefined) ??
				(message.reasoning as string | undefined);
			if (typeof reasoning === 'string' && reasoning.length > 0) {
				const block = {
					type: 'thinking' as const,
					thinking: '',
					thinkingSignature: 'reasoning_content',
				};
				output.content.push(block);
				const idx = output.content.length - 1;
				stream.push({ type: 'thinking_start', contentIndex: idx, partial: output });
				block.thinking = reasoning;
				stream.push({
					type: 'thinking_delta',
					contentIndex: idx,
					delta: reasoning,
					partial: output,
				});
				stream.push({
					type: 'thinking_end',
					contentIndex: idx,
					content: reasoning,
					partial: output,
				});
			}
			const text = message.content;
			if (typeof text === 'string' && text.length > 0) {
				const block = { type: 'text' as const, text: '' };
				output.content.push(block);
				const idx = output.content.length - 1;
				stream.push({ type: 'text_start', contentIndex: idx, partial: output });
				block.text = text;
				stream.push({
					type: 'text_delta',
					contentIndex: idx,
					delta: text,
					partial: output,
				});
				stream.push({
					type: 'text_end',
					contentIndex: idx,
					content: text,
					partial: output,
				});
			}
			const calls = (message.tool_calls as Record<string, unknown>[] | undefined) ?? [];
			for (const call of calls) {
				const fn = (call.function ?? {}) as Record<string, unknown>;
				const args = fn.arguments;
				const signature = signatureOf(call);
				const block: ToolCall = {
					type: 'toolCall',
					id:
						typeof call.id === 'string'
							? call.id
							: `call_${Math.random().toString(36).slice(2)}`,
					name: typeof fn.name === 'string' ? fn.name : '',
					arguments:
						typeof args === 'string'
							? parseStreamingJson(args)
							: ((args as ToolCall['arguments'] | undefined) ?? {}),
					...(signature ? { thoughtSignature: signature } : {}),
				};
				output.content.push(block);
				const idx = output.content.length - 1;
				stream.push({ type: 'toolcall_start', contentIndex: idx, partial: output });
				stream.push({
					type: 'toolcall_end',
					contentIndex: idx,
					toolCall: block,
					partial: output,
				});
			}
			const finish = choice?.finish_reason as string | null | undefined;
			output.rawStopReason = finish ?? undefined;
			const mapped = mapStopReason(finish);
			if (mapped === 'error') throw new Error(`Provider returned finish_reason "${finish}"`);
			const stop: 'stop' | 'length' | 'toolUse' =
				mapped === 'length'
					? 'length'
					: mapped === 'toolUse' || calls.length > 0
						? 'toolUse'
						: 'stop';
			output.stopReason = stop;
			stream.push({ type: 'done', reason: stop, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
			const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
			output.errorMessage = `${describeError(error)} (requestUrl, after ${seconds} s)`;
			stream.push({ type: 'error', reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

/**
 * A fetch that remembers what happened to the last request, so a bare "network error" from the
 * runtime can be reported with when it broke, whether a response had arrived and how much body.
 */
export function createDiagnosticFetch(base: typeof fetch = window.fetch.bind(window)) {
	let startedAt = 0;
	let status: number | null = null;
	let bytes = 0;
	let failure: string | null = null;
	// Pi's Chat Completions parser drops `extra_content`, so the signatures are read here (LIB-FEAT-250).
	const signatures = new Map<string, string>();
	const idAt = new Map<number, string>();
	const decoder = new TextDecoder();
	let pending = '';
	const readSignatures = (bytes: Uint8Array) => {
		pending += decoder.decode(bytes, { stream: true });
		const lines = pending.split('\n');
		pending = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.startsWith('data:') || !line.includes('"tool_calls"')) continue;
			try {
				const chunk = JSON.parse(line.slice(5)) as {
					choices?: { delta?: { tool_calls?: (SignedCall & { index?: number })[] } }[];
				};
				for (const call of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
					if (call.id && call.index !== undefined) idAt.set(call.index, call.id);
					const id =
						call.id ?? (call.index !== undefined ? idAt.get(call.index) : undefined);
					const signature = signatureOf(call);
					if (id && signature) signatures.set(id, signature);
				}
			} catch {
				// Not every data line is JSON ([DONE]); the parser reports real errors itself.
			}
		}
	};
	const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;
	const wrapped: typeof fetch = async (input, init) => {
		startedAt = Date.now();
		status = null;
		bytes = 0;
		failure = null;
		signatures.clear();
		idAt.clear();
		pending = '';
		let response: Response;
		try {
			response = await base(input, init);
		} catch (error) {
			failure = describeError(error);
			throw error;
		}
		status = response.status;
		const body = response.body;
		if (!body) return response;
		const reader = body.getReader();
		const counted = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (done) controller.close();
					else {
						bytes += value.byteLength;
						readSignatures(value);
						controller.enqueue(value);
					}
				} catch (error) {
					// A phone freezes the app's sockets in the background; say so when that was the case.
					failure = describeError(error) + (appIsHidden() ? ', app in background' : '');
					controller.error(error);
				}
			},
			cancel: (reason) => reader.cancel(reason),
		});
		return new Response(counted, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
	return {
		fetch: wrapped,
		/** Puts the signatures the response carried on the finished message's tool calls. */
		sign(message: AssistantMessage): void {
			for (const c of message.content)
				if (c.type === 'toolCall' && !c.thoughtSignature && signatures.has(c.id))
					c.thoughtSignature = signatures.get(c.id);
		},
		/** One parenthetical for the error block, empty before any request. */
		describe(): string {
			if (!startedAt) return '';
			const parts = [`fetch, after ${elapsed()}`];
			parts.push(
				status === null
					? 'no response'
					: `HTTP ${status} received, body cut after ${bytes} bytes`,
			);
			if (failure) parts.push(failure);
			return parts.join(', ');
		},
	};
}

function describeError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = (error as { cause?: unknown }).cause;
	const causeText = cause instanceof Error ? `; cause: ${cause.name}: ${cause.message}` : '';
	return `${error.name}: ${error.message}${causeText}`;
}

function looksLikeHttpError(message: string | undefined): boolean {
	return /^\s*\d{3}\b/.test(message ?? '') || /\b(4\d\d|5\d\d)\b.*status/i.test(message ?? '');
}

/** Builds the `streamFn` given to the Pi agent for one provider. */
export class TransportRouter {
	/** Providers whose `auto` transport fell back to requestUrl for the rest of this app run. */
	private readonly fallenBack = new Set<string>();

	constructor(private readonly events: TransportEvents = {}) {}

	effectiveMode(provider: ProviderConfig): TransportMode {
		if (provider.transport === 'auto' && this.fallenBack.has(provider.id)) return 'requestUrl';
		return provider.transport;
	}

	hasFallenBack(providerId: string): boolean {
		return this.fallenBack.has(providerId);
	}

	createStreamFn(provider: ProviderConfig, resolve: () => ResolvedRequest): StreamFn {
		return (model, context, loopOptions) => {
			const req = resolve();
			const opts: SimpleStreamOptions & { thinkingLevel?: ThinkingLevel } = {
				...loopOptions,
				temperature: req.options.temperature,
				maxTokens: req.options.maxTokens,
				timeoutMs: req.options.timeoutMs,
				maxRetries: req.options.maxRetries,
				samplingParams: req.options.samplingParams,
				thinkingLevel: req.options.thinkingLevel,
			};
			const piModel = model as PiModel;
			const mode = this.effectiveMode(provider);
			const fetchOpts: SimpleStreamOptions = {
				...opts,
				apiKey: req.authHeader && req.apiKey ? req.apiKey : 'unused',
				headers: req.authHeader && req.apiKey ? undefined : { Authorization: null },
			};
			// One request in the model's format (LIB-FEAT-247). Without streaming, Chat Completions has a
			// request of its own; the Responses API takes requestUrl as its fetch and reads the whole
			// event stream at once.
			const send = (o: SimpleStreamOptions) =>
				piModel.api === 'openai-responses'
					? streamResponses(piModel, context, o)
					: streamSimple(piModel, context, {
							...o,
							onPayload: async (params, m) => {
								const next = (await o.onPayload?.(params, m)) ?? params;
								const messages = (next as { messages?: unknown[] }).messages;
								if (messages)
									withThoughtSignatures(messages, context, piModel.baseUrl);
								return next;
							},
						});
			const viaRequestUrl = () =>
				piModel.api === 'openai-responses'
					? streamResponses(piModel, context, { ...fetchOpts, fetch: requestUrlFetch })
					: streamViaRequestUrl(piModel, context, opts, req);
			if (mode === 'requestUrl') {
				this.events.onNonStreaming?.();
				return viaRequestUrl();
			}
			if (mode === 'fetch') return this.fetchStream(send, fetchOpts);
			return this.autoStream(provider, send, viaRequestUrl, fetchOpts);
		};
	}

	/** A fixed fetch transport reports network failures with the hint to switch transports. */
	private fetchStream(
		send: (options: SimpleStreamOptions) => AssistantMessageEventStream,
		options: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const out = createAssistantMessageEventStream();
		const diag = createDiagnosticFetch();
		let gotResponse = false;
		const inner = send({
			...options,
			fetch: diag.fetch,
			onResponse: async (r, m) => {
				gotResponse = true;
				await options.onResponse?.(r, m);
			},
		});
		void (async () => {
			for await (const ev of inner) {
				if (ev.type === 'done') diag.sign(ev.message);
				if (ev.type === 'error' && ev.reason === 'error') {
					const raw = ev.error.errorMessage ?? '';
					ev.error.errorMessage =
						!gotResponse && !looksLikeHttpError(raw)
							? `${FETCH_FAILED_NOTICE} (${raw}; ${diag.describe()})`
							: `${raw} (${diag.describe()})`;
				}
				out.push(ev);
			}
			out.end();
		})();
		return out;
	}

	private autoStream(
		provider: ProviderConfig,
		send: (options: SimpleStreamOptions) => AssistantMessageEventStream,
		viaRequestUrl: () => AssistantMessageEventStream,
		fetchOptions: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const out = createAssistantMessageEventStream();
		const diag = createDiagnosticFetch();
		let gotResponse = false;
		const startedAt = Date.now();
		const inner = send({
			...fetchOptions,
			fetch: diag.fetch,
			onResponse: async (r, m) => {
				gotResponse = true;
				await fetchOptions.onResponse?.(r, m);
			},
		});
		void (async () => {
			for await (const ev of inner) {
				if (ev.type === 'done') diag.sign(ev.message);
				const networkFailure =
					ev.type === 'error' &&
					ev.reason === 'error' &&
					!gotResponse &&
					!fetchOptions.signal?.aborted &&
					!looksLikeHttpError(ev.error.errorMessage) &&
					// A phone blocks requests while the app is away; that is not CORS, and requestUrl
					// would fail the same way. The controller asks again when the app returns.
					!wasHiddenSince(startedAt);
				// The runtime's own text ("network error") says nothing; add when and how it broke.
				if (ev.type === 'error' && ev.reason === 'error')
					ev.error.errorMessage = `${ev.error.errorMessage ?? ''} (${diag.describe()})`;
				if (networkFailure) {
					this.fallenBack.add(provider.id);
					this.events.onFallback?.(provider.id);
					this.events.onNonStreaming?.();
					for await (const retryEv of viaRequestUrl()) out.push(retryEv);
					out.end();
					return;
				}
				out.push(ev);
			}
			out.end();
		})();
		return out;
	}
}

/** A model a server lists at /models, with whatever details the server reports about it. */
export interface ServerModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: InputModality[];
	reasoning?: boolean;
	toolCalling?: boolean;
}

const positive = (n: unknown): n is number => typeof n === 'number' && n > 0;

/**
 * vLLM reports max_model_len; OpenRouter reports context_length, the output limit, the input kinds
 * and the parameters it takes (LIB-FEAT-246). OpenAI and most servers report only the name.
 */
function serverModel(entry: unknown): ServerModel[] {
	if (!entry || typeof entry !== 'object') return [];
	const e = entry as Record<string, unknown>;
	if (typeof e.id !== 'string' || !e.id) return [];
	const size = [e.max_model_len, e.context_length, e.context_window].find(positive);
	const top = e.top_provider as { max_completion_tokens?: unknown } | undefined;
	const modalities = (e.architecture as { input_modalities?: unknown } | undefined)
		?.input_modalities;
	const params = Array.isArray(e.supported_parameters) ? e.supported_parameters : undefined;
	return [
		{
			id: e.id,
			...(typeof e.name === 'string' && e.name ? { name: e.name } : {}),
			...(size ? { contextWindow: size } : {}),
			...(positive(top?.max_completion_tokens)
				? { maxTokens: top.max_completion_tokens }
				: {}),
			...(Array.isArray(modalities)
				? { input: modalities.includes('image') ? ['text', 'image'] : ['text'] }
				: {}),
			...(params
				? { reasoning: params.includes('reasoning'), toolCalling: params.includes('tools') }
				: {}),
		},
	];
}

/** Cheapest connection check: list the models, which the provider editor also offers to add. */
export async function testConnection(
	provider: ProviderConfig,
	apiKey: string | null,
): Promise<{ ok: true; models: ServerModel[] } | { ok: false; message: string }> {
	const url = `${provider.baseUrl.replace(/\/+$/, '')}/models`;
	const headers = buildHeaders(apiKey, provider.authHeader);
	try {
		// Listing models does not stream; use Obsidian's CORS-independent transport.
		const response = await requestUrl({ url, headers, throw: false });
		const status = response.status;
		if (status >= 400) return { ok: false, message: `HTTP ${status}` };
		const data = (response.json as { data?: unknown[] } | undefined)?.data;
		return { ok: true, models: Array.isArray(data) ? data.flatMap(serverModel) : [] };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}
