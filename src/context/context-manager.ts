import type { AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type {
	AssistantMessage,
	ImageContent,
	Message,
	ThinkingLevel as PiThinkingLevel,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from '@earendil-works/pi-ai';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import {
	createInitialSystemMessage,
	normalizeContext,
	toToolDeclaration,
} from '@earendil-works/pi-ai/utils/transcript';
import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import type { PiModel } from '../provider/provider-manager';
import type { IndexedEvent, SessionEvent, StoredUsage } from '../session/session-types';
import { type ContextSettings, type ModelConfig, RESPONSES_API } from '../types';

export interface ContextUsage {
	usedTokens: number;
	maxTokens: number;
	reservedOutputTokens: number;
	safetyMarginTokens: number;
	availableInputTokens: number;
	usageRatio: number;
	/** The token counts of the last response the server reported, or null before the first one. */
	lastResponse: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
	state: 'normal' | 'warning' | 'critical';
}

/**
 * Share of the last prompt the server served from its cache. The reported input excludes what
 * was read from or written to the cache, so the whole prompt is the three added together.
 */
export function cacheHitRatio(last: ContextUsage['lastResponse']): number | null {
	const prompt = last ? last.input + last.cacheRead + last.cacheWrite : 0;
	return last && prompt > 0 ? last.cacheRead / prompt : null;
}

export interface PreparedContext {
	systemPrompt: string;
	/** Leading system message plus the projected conversation, ready for `Agent.state.messages`. */
	messages: AgentMessage[];
	tools: AgentTool[];
	usage: ContextUsage;
}

export interface CompactionResult {
	summary: string;
	coveredUntil: number;
	retained: string[];
	tokensBefore: number;
	tokensAfter: number;
	method: 'summary' | 'truncate';
}

export interface CompactOptions {
	/** The prompt and tools of the next request, so the summary request starts the same way. */
	systemPrompt: string;
	tools: AgentTool[];
	reasoning?: PiThinkingLevel;
	/** Before a turn: the message that starts it stays out of the summary and follows it. */
	keepLastUser?: boolean;
	signal?: AbortSignal;
}

/**
 * The last message of the summary request (LIB-FEAT-256). After the idea of Codex's handoff
 * summary: the model writes for whoever continues the work without the messages it replaces.
 */
export const HANDOFF_PROMPT = `Context checkpoint: the messages above are about to be replaced by the summary you write now, and the conversation will continue from it, perhaps with another model. Write a handoff summary that lets the work go on without those messages. Cover:
- the user's goal, what has been done so far and the decisions made
- constraints, preferences and other context the user gave
- what is left, as concrete next steps; for a task in progress, exactly where it stopped
- what is needed to continue: note paths, file names, identifiers, numbers, quotes and tool results that matter
Keep it concise and structured, in the language of the conversation. Do not call tools; answer with the summary only.`;

/** Put before the summary in the request, so the model knows where it came from. */
export const SUMMARY_PREFIX =
	'[Context summary] The earlier part of this conversation was compacted. What follows is a handoff summary written by the model that did that work. Build on it instead of repeating finished work, and look things up with tools when you need details it leaves out.';

/** Tokens of the user's own messages kept word for word, at most, whatever the window. */
const RETAINED_MAX_TOKENS = 20_000;

/** Hangul, CJK ideographs and kana are about one token per character; everything else four chars. */
export function estimateText(s: string): number {
	let cjk = 0;
	for (const ch of s) if (/[ᄀ-ᇿ぀-ヿ㐀-鿿가-힯]/.test(ch)) cjk++;
	return cjk + Math.ceil((s.length - cjk) / 4);
}

const IMAGE_TOKENS = 1000;

function estimateEvent(event: SessionEvent): number {
	switch (event.type) {
		case 'user':
			return estimateText(event.content) + 4 + (event.images?.length ?? 0) * IMAGE_TOKENS;
		case 'assistant':
			return (
				estimateText(event.content) +
				4 +
				event.toolCalls.reduce(
					(n, c) => n + estimateText(c.name) + estimateText(JSON.stringify(c.args)),
					0,
				)
			);
		case 'tool_result':
			return estimateText(event.content) + 4;
		case 'compaction':
			return (event.retained ?? []).reduce(
				(n, t) => n + estimateText(t) + 4,
				estimateText(event.summary) + 4,
			);
		default:
			return 0;
	}
}

function readImageBase64(
	app: App,
	path: string,
): Promise<{ data: string; mimeType: string } | null> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return Promise.resolve(null);
	const ext = file.extension.toLowerCase();
	const mimeType =
		ext === 'jpg' || ext === 'jpeg'
			? 'image/jpeg'
			: ext === 'gif'
				? 'image/gif'
				: ext === 'webp'
					? 'image/webp'
					: 'image/png';
	return app.vault.readBinary(file).then((buffer) => {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		for (let i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		}
		return { data: btoa(binary), mimeType };
	});
}

export interface ProjectionInput {
	events: IndexedEvent[];
	model: PiModel;
	/** Leave out the trailing user event that `Agent.prompt()` will add itself. */
	excludeLastUser?: boolean;
}

/**
 * A call's id as the log replays it. Pi names a Responses API call `call_id|fc_id`, and OpenAI
 * refuses an fc_ item that comes without the reasoning item it was paired with, which the log
 * does not keep. Without the item id the call goes back as one from another model does.
 */
const replayedCallId = (id: string): string => id.split('|')[0]!;

export class ContextManager {
	constructor(
		private readonly app: App,
		private readonly settings: () => ContextSettings,
	) {}

	/** Events after the last valid compaction, plus that compaction. */
	static visible(events: IndexedEvent[]): {
		compaction: IndexedEvent | null;
		rest: IndexedEvent[];
	} {
		let compaction: IndexedEvent | null = null;
		for (const e of events) if (e.event.type === 'compaction') compaction = e;
		if (!compaction) return { compaction: null, rest: events };
		const until = (compaction.event as Extract<SessionEvent, { type: 'compaction' }>)
			.coveredUntil;
		return {
			compaction,
			rest: events.filter((e) => e.index >= until && e.event.type !== 'compaction'),
		};
	}

	async project(input: ProjectionInput): Promise<Message[]> {
		const { compaction, rest } = ContextManager.visible(input.events);
		const events = [...rest];
		if (input.excludeLastUser) {
			for (let i = events.length - 1; i >= 0; i--) {
				if (events[i]!.event.type === 'user') {
					events.splice(i, 1);
					break;
				}
			}
		}
		const messages: Message[] = [];
		if (compaction) {
			const c = compaction.event as Extract<SessionEvent, { type: 'compaction' }>;
			const timestamp = Date.parse(c.t) || Date.now();
			// The user's words, then the summary last, as Codex rebuilds its history.
			for (const text of c.retained ?? [])
				messages.push({ role: 'user', content: text, timestamp });
			messages.push({
				role: 'user',
				content: c.retained
					? `${SUMMARY_PREFIX}\n\n${c.summary}`
					: `[Summary of the earlier part of this conversation]\n${c.summary}`,
				timestamp,
			});
		}
		const pendingCalls = new Map<string, string>();
		for (const { event } of events) {
			const ts = Date.parse(event.t) || Date.now();
			if (event.type === 'user') {
				const content: (TextContent | ImageContent)[] = [
					{ type: 'text', text: event.content },
				];
				for (const path of event.images ?? []) {
					const image = await readImageBase64(this.app, path);
					if (image) content.push({ type: 'image', ...image });
					else content.push({ type: 'text', text: `[image missing: ${path}]` });
				}
				const msg: UserMessage = {
					role: 'user',
					content: content.length === 1 ? event.content : content,
					timestamp: ts,
				};
				messages.push(msg);
			} else if (event.type === 'assistant') {
				const content: AssistantMessage['content'] = [];
				// Chat Completions takes the text back under reasoning_content. The Responses API
				// wants its own reasoning item as the signature, which the log does not keep, and
				// Pi parses whatever is there as JSON: a turn with thinking broke every request
				// after it. It does without the earlier reasoning instead (see replayedCallId).
				if (event.thinking && input.model.api !== RESPONSES_API)
					content.push({
						type: 'thinking',
						thinking: event.thinking,
						thinkingSignature: 'reasoning_content',
					});
				if (event.content) content.push({ type: 'text', text: event.content });
				for (const call of event.toolCalls) {
					const tc: ToolCall = {
						type: 'toolCall',
						id: replayedCallId(call.id),
						name: call.name,
						arguments: call.args as ToolCall['arguments'],
						...(call.thoughtSignature
							? { thoughtSignature: call.thoughtSignature }
							: {}),
					};
					content.push(tc);
					pendingCalls.set(call.id, call.name);
				}
				messages.push({
					role: 'assistant',
					content,
					api: input.model.api,
					provider: input.model.provider,
					model: input.model.id,
					usage: toUsage(event.usage),
					stopReason: (event.stopReason as AssistantMessage['stopReason']) ?? 'stop',
					timestamp: ts,
				});
			} else if (event.type === 'tool_result') {
				if (!pendingCalls.has(event.toolCallId)) continue;
				pendingCalls.delete(event.toolCallId);
				const msg: ToolResultMessage = {
					role: 'toolResult',
					toolCallId: replayedCallId(event.toolCallId),
					toolName: event.name,
					content: [{ type: 'text', text: event.content }],
					isError: !event.ok,
					timestamp: ts,
				};
				messages.push(msg);
			}
		}
		// A call that never got a result (app closed mid-turn) would be rejected by the provider.
		for (const [id, name] of pendingCalls) {
			messages.push({
				role: 'toolResult',
				toolCallId: replayedCallId(id),
				toolName: name,
				content: [{ type: 'text', text: 'Approval expired' }],
				isError: true,
				timestamp: Date.now(),
			});
		}
		return messages;
	}

	async build(
		input: ProjectionInput & { systemPrompt: string; tools: AgentTool[] },
	): Promise<PreparedContext> {
		const history = await this.project(input);
		const leading = createInitialSystemMessage(
			input.systemPrompt,
			input.tools.map(toToolDeclaration),
		);
		const messages: AgentMessage[] = leading ? [leading, ...history] : history;
		return {
			systemPrompt: input.systemPrompt,
			messages,
			tools: input.tools,
			usage: this.usage(input.events, input.model),
		};
	}

	/**
	 * Tokens of the last response the provider reported: prompt plus completion. Nothing is
	 * estimated on top, so the value is 0 until the first response and stays put between responses.
	 */
	reportedUsed(events: IndexedEvent[]): number {
		const u = this.lastReported(events);
		return u ? u.totalTokens || u.input + u.cacheRead + u.output : 0;
	}

	/** The last assistant usage with any tokens in it, or null before the first response. */
	lastReported(events: IndexedEvent[]): StoredUsage | null {
		const { rest } = ContextManager.visible(events);
		for (let i = rest.length - 1; i >= 0; i--) {
			const e = rest[i]!.event;
			if (e.type !== 'assistant' || !e.usage) continue;
			const u = e.usage;
			if (u.totalTokens || u.input + u.cacheRead + u.output > 0) return u;
		}
		return null;
	}

	budget(model: Pick<ModelConfig, 'contextWindow' | 'maxTokens'>) {
		const s = this.settings();
		const reserved =
			s.reserveOutputTokens === 'model-max' ? model.maxTokens : s.reserveOutputTokens;
		const margin = Math.min(s.safetyMarginTokens, Math.floor(model.contextWindow * 0.1));
		const usable = Math.max(1, model.contextWindow - reserved - margin);
		return { reserved, margin, usable };
	}

	usage(events: IndexedEvent[], model: PiModel): ContextUsage {
		const u = this.lastReported(events);
		const last = u
			? {
					input: u.input,
					output: u.output,
					cacheRead: u.cacheRead,
					cacheWrite: u.cacheWrite ?? 0,
				}
			: null;
		return this.usageFor(this.reportedUsed(events), model, last);
	}

	usageFor(
		used: number,
		model: Pick<ModelConfig, 'contextWindow' | 'maxTokens'>,
		lastResponse: ContextUsage['lastResponse'] = null,
	): ContextUsage {
		const s = this.settings();
		const { reserved, margin, usable } = this.budget(model);
		const ratio = used / usable;
		return {
			usedTokens: used,
			maxTokens: model.contextWindow,
			reservedOutputTokens: reserved,
			safetyMarginTokens: margin,
			availableInputTokens: usable,
			usageRatio: ratio,
			lastResponse,
			state: ratio >= s.compactAt ? 'critical' : ratio >= s.warningAt ? 'warning' : 'normal',
		};
	}

	/**
	 * Whether the next request should go out compacted: the last reported usage plus an estimate
	 * of what was added after it (tool results, the new message), against the threshold. The ring
	 * shows only the reported part; this also sees a large result before the server does.
	 */
	needsCompaction(events: IndexedEvent[], model: PiModel): boolean {
		const { compaction, rest } = ContextManager.visible(events);
		let last = -1;
		for (let i = rest.length - 1; i >= 0 && last < 0; i--) {
			const e = rest[i]!.event;
			const u = e.type === 'assistant' ? e.usage : undefined;
			if (u && (u.totalTokens || u.input + u.cacheRead + u.output) > 0) last = i;
		}
		const added =
			rest.slice(last + 1).reduce((n, e) => n + estimateEvent(e.event), 0) +
			(last < 0 && compaction ? estimateEvent(compaction.event) : 0);
		const used = this.reportedUsed(events) + added;
		return used / this.budget(model).usable >= this.settings().compactAt;
	}

	/**
	 * Replaces the history up to now with a handoff summary (LIB-FEAT-256, after Codex). The
	 * model gets the same prompt, tools and messages as its next request, tools switched off, and
	 * a last message asking for the summary. The request then carries the user's own recent
	 * messages and the summary after them. Null when there is nothing to compact.
	 */
	async compact(
		events: IndexedEvent[],
		model: PiModel,
		streamFn: StreamFn,
		opts: CompactOptions,
	): Promise<CompactionResult | null> {
		const { compaction, rest } = ContextManager.visible(events);
		const lastUser = opts.keepLastUser
			? [...rest].reverse().find((e) => e.event.type === 'user')
			: undefined;
		const cut = lastUser?.index ?? (events[events.length - 1]?.index ?? -1) + 1;
		const covered = rest.filter((e) => e.index < cut);
		// Without a response since the last summary, a new one would not make the request smaller.
		if (!covered.some((e) => e.event.type === 'assistant')) return null;
		const retained = this.retainedUsers(
			(compaction?.event as Extract<SessionEvent, { type: 'compaction' }> | undefined)
				?.retained ?? [],
			covered,
			model,
		);
		// Throws when no summary comes back. Dropping history cannot be undone, so it then stays as
		// it is and a later request tries again, as Codex does.
		const summary = await this.summarize(
			events.filter((e) => e.index < cut),
			model,
			streamFn,
			opts,
		);
		const result: CompactionResult = {
			summary,
			coveredUntil: cut,
			retained,
			tokensBefore: this.reportedUsed(events),
			tokensAfter: 0,
			method: 'summary',
		};
		result.tokensAfter =
			retained.reduce((n, t) => n + estimateText(t) + 4, 0) +
			estimateText(`${SUMMARY_PREFIX}\n\n${result.summary}`) +
			4 +
			rest.filter((e) => e.index >= cut).reduce((n, e) => n + estimateEvent(e.event), 0);
		return result;
	}

	/**
	 * The user's messages kept word for word: the newest first until the budget runs out, the one
	 * that does not fit cut in the middle, then back in their order. Earlier kept ones count too.
	 */
	private retainedUsers(earlier: string[], covered: IndexedEvent[], model: PiModel): string[] {
		const texts = [
			...earlier,
			...covered.flatMap((e) => (e.event.type === 'user' ? [e.event.content] : [])),
		];
		let left = Math.min(RETAINED_MAX_TOKENS, Math.floor(this.budget(model).usable / 10));
		const kept: string[] = [];
		for (let i = texts.length - 1; i >= 0 && left > 0; i--) {
			const text = texts[i]!;
			const tokens = estimateText(text);
			if (tokens <= left) {
				kept.unshift(text);
				left -= tokens;
				continue;
			}
			kept.unshift(truncateMiddle(text, left));
			break;
		}
		return kept;
	}

	/**
	 * Asks for the handoff summary. When even that request is over the window, the oldest turn is
	 * left out and it is asked again, so the newest work is what the summary keeps.
	 */
	private async summarize(
		events: IndexedEvent[],
		model: PiModel,
		streamFn: StreamFn,
		opts: CompactOptions,
	): Promise<string> {
		let history = await this.project({ events, model });
		// The tools stay declared, switched off, so the request starts as the cached one did. A
		// server that refuses that is asked once more without tools, as Codex asks; a busy or
		// failing server (429, 5xx) is not.
		let withTools = true;
		for (;;) {
			const leading = createInitialSystemMessage(
				opts.systemPrompt,
				withTools ? opts.tools.map(toToolDeclaration) : [],
			);
			const ask: Message = { role: 'user', content: HANDOFF_PROMPT, timestamp: Date.now() };
			const context = normalizeContext({
				messages: leading ? [leading, ...history, ask] : [...history, ask],
			});
			const stream = await streamFn(model, context, {
				signal: opts.signal,
				maxTokens: Math.min(model.maxTokens, 16_384),
				reasoning: opts.reasoning,
				...(withTools ? { toolChoice: 'none' as const } : {}),
			});
			const result = await stream.result();
			if (result.stopReason === 'error' && isContextOverflow(result, model.contextWindow)) {
				history = withoutOldestTurn(history);
				if (history.length) continue;
			} else if (
				result.stopReason === 'error' &&
				withTools &&
				!opts.signal?.aborted &&
				!/^\D{0,10}(?:429|5\d\d)\b/.test(result.errorMessage ?? '')
			) {
				withTools = false;
				continue;
			}
			if (result.stopReason === 'error' || result.stopReason === 'aborted')
				throw new Error(result.errorMessage ?? 'The summary request failed.');
			const text = result.content
				.filter((c): c is TextContent => c.type === 'text')
				.map((c) => c.text)
				.join('')
				.trim();
			if (!text) throw new Error('The model returned no summary.');
			return text;
		}
	}
}

/** Leaves out the first message and whatever belongs to it, up to the next user message. */
function withoutOldestTurn(messages: Message[]): Message[] {
	let i = 1;
	while (i < messages.length && messages[i]!.role !== 'user') i++;
	return messages.slice(i);
}

/** Keeps the head and the tail of a long message, saying how much was cut from its middle. */
export function truncateMiddle(text: string, maxTokens: number): string {
	const tokens = estimateText(text);
	if (tokens <= maxTokens) return text;
	const keep = Math.floor((text.length * maxTokens) / tokens / 2);
	return `${text.slice(0, keep)}\n…${tokens - maxTokens} tokens truncated…\n${text.slice(text.length - keep)}`;
}

function toUsage(u: StoredUsage | undefined): AssistantMessage['usage'] {
	return {
		input: u?.input ?? 0,
		output: u?.output ?? 0,
		cacheRead: u?.cacheRead ?? 0,
		cacheWrite: u?.cacheWrite ?? 0,
		totalTokens: u?.totalTokens ?? 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
