import type { AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from '@earendil-works/pi-ai';
import {
	createInitialSystemMessage,
	normalizeContext,
	toToolDeclaration,
} from '@earendil-works/pi-ai/utils/transcript';
import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import type { PiModel } from '../provider/provider-manager';
import type { IndexedEvent, SessionEvent, StoredUsage } from '../session/session-types';
import type { ContextSettings, ModelConfig } from '../types';

export interface ContextUsage {
	usedTokens: number;
	maxTokens: number;
	reservedOutputTokens: number;
	safetyMarginTokens: number;
	availableInputTokens: number;
	usageRatio: number;
	/** Cached share of the last reported prompt, or null when the server reported no prompt tokens. */
	cacheHitRatio: number | null;
	state: 'normal' | 'warning' | 'critical';
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
	tokensBefore: number;
	tokensAfter: number;
	method: 'summary' | 'truncate';
}

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
			return estimateText(event.summary) + 4;
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
			messages.push({
				role: 'user',
				content: `[Summary of the earlier part of this conversation]\n${c.summary}`,
				timestamp: Date.parse(c.t) || Date.now(),
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
				if (event.thinking)
					content.push({
						type: 'thinking',
						thinking: event.thinking,
						thinkingSignature: 'reasoning_content',
					});
				if (event.content) content.push({ type: 'text', text: event.content });
				for (const call of event.toolCalls) {
					const tc: ToolCall = {
						type: 'toolCall',
						id: call.id,
						name: call.name,
						arguments: call.args as ToolCall['arguments'],
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
					toolCallId: event.toolCallId,
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
				toolCallId: id,
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
		const prompt = u ? u.input + u.cacheRead : 0;
		return this.usageFor(
			this.reportedUsed(events),
			model,
			prompt > 0 ? u!.cacheRead / prompt : null,
		);
	}

	usageFor(
		used: number,
		model: Pick<ModelConfig, 'contextWindow' | 'maxTokens'>,
		cacheHitRatio: number | null = null,
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
			cacheHitRatio,
			state: ratio >= s.compactAt ? 'critical' : ratio >= s.warningAt ? 'warning' : 'normal',
		};
	}

	/**
	 * Picks the cut: keep the last `preserveRecentTurns` user turns, never split a tool call from
	 * its result. Returns the event index that starts the kept part, or null when nothing to cut.
	 */
	findCut(events: IndexedEvent[]): number | null {
		const { rest } = ContextManager.visible(events);
		const userPositions = rest
			.map((e, i) => (e.event.type === 'user' ? i : -1))
			.filter((i) => i >= 0);
		const keep = this.settings().preserveRecentTurns;
		if (userPositions.length <= keep) return null;
		const pos = userPositions[userPositions.length - keep]!;
		if (pos === 0) return null;
		return rest[pos]!.index;
	}

	async compact(
		events: IndexedEvent[],
		model: PiModel,
		streamFn: StreamFn,
		signal?: AbortSignal,
	): Promise<CompactionResult | null> {
		const cut = this.findCut(events);
		if (cut === null) return null;
		const { compaction, rest } = ContextManager.visible(events);
		const before = rest.filter((e) => e.index < cut);
		const tokensBefore = this.reportedUsed(events);
		const transcript = (
			compaction
				? [
						`Earlier summary:\n${(compaction.event as Extract<SessionEvent, { type: 'compaction' }>).summary}`,
					]
				: []
		)
			.concat(before.map(({ event }) => serialize(event)).filter((s) => s.length > 0))
			.join('\n\n');
		let summary: string | null = null;
		try {
			const context = normalizeContext({
				systemPrompt:
					'Summarize the conversation below for an AI assistant that will continue it. Keep every decision, file path, note title and pending task. Write plain prose, no more than 600 words.',
				messages: [{ role: 'user', content: transcript, timestamp: Date.now() }],
			});
			const stream = await streamFn(model, context, { signal, maxTokens: 2048 });
			const result = await stream.result();
			if (result.stopReason === 'error' || result.stopReason === 'aborted')
				throw new Error(result.errorMessage);
			const text = result.content
				.filter((c): c is TextContent => c.type === 'text')
				.map((c) => c.text)
				.join('')
				.trim();
			if (text) summary = text;
		} catch {
			summary = null;
		}
		const result: CompactionResult = summary
			? { summary, coveredUntil: cut, tokensBefore, tokensAfter: 0, method: 'summary' }
			: {
					summary: `Older messages were dropped from the request (${before.length} events).`,
					coveredUntil: cut,
					tokensBefore,
					tokensAfter: 0,
					method: 'truncate',
				};
		const after = rest
			.filter((e) => e.index >= cut)
			.reduce((n, e) => n + estimateEvent(e.event), 0);
		result.tokensAfter = after + estimateText(result.summary) + 4;
		return result;
	}
}

function toUsage(u: StoredUsage | undefined): AssistantMessage['usage'] {
	return {
		input: u?.input ?? 0,
		output: u?.output ?? 0,
		cacheRead: u?.cacheRead ?? 0,
		cacheWrite: 0,
		totalTokens: u?.totalTokens ?? 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function serialize(event: SessionEvent): string {
	switch (event.type) {
		case 'user':
			return `User: ${event.content}`;
		case 'assistant': {
			const calls = event.toolCalls
				.map((c) => `[called ${c.name} ${JSON.stringify(c.args)}]`)
				.join(' ');
			return `Assistant: ${event.content} ${calls}`.trim();
		}
		case 'tool_result':
			return `Tool ${event.name} ${event.ok ? 'returned' : 'failed'}: ${event.content.slice(0, 1500)}`;
		default:
			return '';
	}
}
