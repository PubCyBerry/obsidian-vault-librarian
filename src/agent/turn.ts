import type { AssistantMessage, TextContent } from '@earendil-works/pi-ai';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import type { ResponsesReplay, StoredToolCall, StoredUsage } from '../session/session-types';
import { RESPONSES_API } from '../types';
import { appIsHidden } from '../visibility';

/** What ends an agent's loop early: failures by call, turns that called tools, and why it ended. */
export interface LoopLimits {
	failures: Map<string, number>;
	iterations: number;
	stopReason: string | null;
	/** Turns with tool calls allowed, when not the setting's: a sub-agent's maxTurns. */
	max?: number;
}

export function freshLimits(): LoopLimits {
	return { failures: new Map(), iterations: 0, stopReason: null };
}

/**
 * A tool-calling model by `<provider id>/<model id>`, or by model ID or name alone. Model IDs may
 * hold a slash themselves, so the provider is only split off when one has that ID.
 */
export function findModel<
	T extends { provider: { id: string }; model: { id: string; name: string } },
>(options: readonly T[], ref: string): T | undefined {
	const slash = ref.indexOf('/');
	if (slash > 0) {
		const [provider, model] = [ref.slice(0, slash), ref.slice(slash + 1)];
		const exact = options.find((o) => o.provider.id === provider && o.model.id === model);
		if (exact) return exact;
	}
	const lower = ref.toLowerCase();
	return options.find(
		(o) => o.model.id.toLowerCase() === lower || o.model.name.toLowerCase() === lower,
	);
}

export const RETRY_DELAY_MS = 1500;

/**
 * Backstop for a request that keeps failing while the app is sent away and brought back. Each
 * resume needs the app to become visible again, so reaching this means the user retried by hand.
 */
export const MAX_BACKGROUND_RESUMES = 10;

/** The transport's parenthetical for a response the network cut after HTTP 200. */
export function isStreamCut(message: string | undefined): boolean {
	return /HTTP 200 received, body cut after/.test(message ?? '');
}

/** Why a failed request is asked again: the app comes back, a cut stream, a context overflow. */
export type Recovery = 'visible' | 'cut' | 'overflow';

/**
 * Whether a response that did not arrive is asked again, and how. Being sent to the background
 * takes priority, because a phone freezes the connection there and the request would fail again
 * right away; then a stream the network cut, once; then a request that did not fit the window,
 * once, after compacting.
 */
export class TurnRecovery {
	/** The app was away during the request now running. */
	hiddenDuringRequest = false;
	/** What the turn does next, decided by the last failed response; null when it goes on as is. */
	next: Recovery | null = null;
	/** The error of the overflowing request, shown when compacting does not make it fit. */
	overflowMessage = '';
	private backgroundResumes = 0;
	private cutRetries = 0;
	private overflowRetries = 0;

	/** A new turn starts with every retry available again. */
	reset(): void {
		this.hiddenDuringRequest = false;
		this.next = null;
		this.overflowMessage = '';
		this.backgroundResumes = 0;
		this.cutRetries = 0;
		this.overflowRetries = 0;
	}

	/** Each request tracks its own backgrounding, so only the one that was away resumes. */
	requestStarted(): void {
		this.hiddenDuringRequest = appIsHidden();
	}

	/** True when the failed response is not kept and the turn asks the model again. */
	plan(m: AssistantMessage, contextWindow: number | undefined): boolean {
		if (this.hiddenDuringRequest && this.backgroundResumes < MAX_BACKGROUND_RESUMES) {
			this.backgroundResumes++;
			this.next = 'visible';
			return true;
		}
		if (isStreamCut(m.errorMessage) && this.cutRetries < 1) {
			this.cutRetries++;
			this.next = 'cut';
			return true;
		}
		if (isContextOverflow(m, contextWindow) && this.overflowRetries < 1) {
			this.overflowRetries++;
			this.overflowMessage = m.errorMessage ?? 'Context window exceeded';
			this.next = 'overflow';
			return true;
		}
		return false;
	}

	/** A response arrived: the next overflow may be compacted away again. */
	arrived(): void {
		this.overflowRetries = 0;
	}

	/** The recovery to run now, and nothing is pending after it until the next failure. */
	take(): Recovery | null {
		const next = this.next;
		this.next = null;
		return next;
	}
}

export function textOf(content: readonly { type: string }[]): string {
	return content
		.filter((c): c is TextContent => c.type === 'text')
		.map((c) => c.text)
		.join('');
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function withErrorPrefix(text: string, isError: boolean): string {
	return isError && !text.startsWith('Error:') ? `Error: ${text}` : text;
}

/**
 * The items of a Responses API reply, in order, when it came with reasoning the server let us
 * keep: a reasoning item without its encrypted content cannot be sent back, so none of it is.
 */
export function responsesReplay(m: AssistantMessage): ResponsesReplay | undefined {
	if (m.api !== RESPONSES_API) return undefined;
	const items: ResponsesReplay['items'] = [];
	for (const c of m.content) {
		if (c.type === 'thinking') {
			if (!c.thinkingSignature) continue;
			try {
				if (
					!(JSON.parse(c.thinkingSignature) as { encrypted_content?: unknown })
						.encrypted_content
				)
					return undefined;
			} catch {
				return undefined;
			}
			items.push({ reasoning: c.thinkingSignature });
		} else if (c.type === 'text')
			items.push({
				text: c.text.length,
				...(c.textSignature ? { signature: c.textSignature } : {}),
			});
		else if (c.type === 'toolCall') items.push({ call: c.id });
	}
	if (!items.some((i) => 'reasoning' in i)) return undefined;
	return { model: `${m.provider}/${m.model}`, items };
}

/** A response as the session log keeps it. */
export function assistantEvent(m: AssistantMessage) {
	const usage: StoredUsage | undefined =
		m.usage.totalTokens > 0
			? {
					input: m.usage.input,
					output: m.usage.output,
					cacheRead: m.usage.cacheRead,
					cacheWrite: m.usage.cacheWrite,
					totalTokens: m.usage.totalTokens,
				}
			: undefined;
	const thinking = m.content
		.filter((c): c is Extract<typeof c, { type: 'thinking' }> => c.type === 'thinking')
		.map((c) => c.thinking)
		.join('');
	const toolCalls: StoredToolCall[] = m.content
		.filter((c): c is Extract<typeof c, { type: 'toolCall' }> => c.type === 'toolCall')
		.map((c) => ({
			id: c.id,
			name: c.name,
			args: c.arguments,
			...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
		}));
	const responses = responsesReplay(m);
	return {
		type: 'assistant' as const,
		content: textOf(m.content),
		thinking: thinking || undefined,
		toolCalls,
		usage,
		stopReason: m.stopReason,
		...(responses ? { responses } : {}),
	};
}

/**
 * A provider error as the chat shows it. `keyless` names the provider when its key on this device
 * is empty, which sends no key at all: a 401 then says why, after the server's own words.
 */
export function rewriteProviderError(message: string, keyless?: string): string {
	if (
		/tool(s|_choice)?\b.*(not supported|unsupported|does not support|invalid)/i.test(message) ||
		/does not support tools/i.test(message)
	) {
		return 'This endpoint rejected tool calling. Check the provider settings.';
	}
	if (keyless && /\b401\b/.test(message))
		return `${message}\n\nNo API key is saved for ${keyless} on this device, so the request went without one. Add the key under Providers in Settings.`;
	return message;
}
