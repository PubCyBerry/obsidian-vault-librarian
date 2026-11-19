import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { TITLE_PROMPT } from '../src/agent/session-title';

export interface ScriptedTurn {
	text?: string;
	toolCalls?: { name: string; args: Record<string, unknown>; id?: string }[];
	stopReason?: 'stop' | 'length' | 'toolUse' | 'error';
	errorMessage?: string;
	usage?: { input: number; output: number };
	/** The response waits for this before it arrives, or ends as aborted when the request stops. */
	hold?: Promise<void>;
}

/** The request that names a session (LIB-FEAT-325), which takes no turn of a script. */
export function isTitleRequest(context: TranscriptContext): boolean {
	return context.messages.some(
		(m) => m.role === 'system' && JSON.stringify(m.content).includes(TITLE_PROMPT.slice(0, 40)),
	);
}

/**
 * A `StreamFn` that plays back scripted assistant turns and records every request context. The
 * request that names a session is answered aside with `title`, by default none, so a session
 * keeps the start of its first message as its name; it lands in `titleRequests`.
 */
export function scriptedStream(turns: ScriptedTurn[], title = '') {
	const requests: TranscriptContext[] = [];
	const titleRequests: TranscriptContext[] = [];
	const sentOptions: Parameters<StreamFn>[2][] = [];
	let counter = 0;
	const streamFn: StreamFn = (model, context, options) => {
		const naming = isTitleRequest(context);
		if (naming) titleRequests.push(context);
		else {
			requests.push(context);
			sentOptions.push(options);
		}
		const turn = naming
			? { text: title }
			: (turns.shift() ?? { text: '(no more scripted turns)' });
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: 'assistant',
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: turn.usage?.input ?? 0,
				output: turn.usage?.output ?? 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: (turn.usage?.input ?? 0) + (turn.usage?.output ?? 0),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: 'pending',
			timestamp: Date.now(),
		};
		let played = false;
		const play = () => {
			if (played) return;
			played = true;
			if (options?.signal?.aborted || turn.stopReason === 'error') {
				message.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
				message.errorMessage = turn.errorMessage ?? 'scripted error';
				stream.push({ type: 'error', reason: message.stopReason, error: message });
				stream.end();
				return;
			}
			stream.push({ type: 'start', partial: message });
			if (turn.text) {
				message.content.push({ type: 'text', text: turn.text });
				stream.push({
					type: 'text_end',
					contentIndex: message.content.length - 1,
					content: turn.text,
					partial: message,
				});
			}
			for (const call of turn.toolCalls ?? []) {
				const block = {
					type: 'toolCall' as const,
					id: call.id ?? `call_${++counter}`,
					name: call.name,
					arguments: call.args as never,
				};
				message.content.push(block);
				stream.push({
					type: 'toolcall_end',
					contentIndex: message.content.length - 1,
					toolCall: block,
					partial: message,
				});
			}
			const reason = turn.stopReason ?? (turn.toolCalls?.length ? 'toolUse' : 'stop');
			message.stopReason = reason;
			stream.push({ type: 'done', reason, message });
			stream.end();
		};
		const hold = turn.hold;
		if (!hold) queueMicrotask(play);
		else {
			// Held until the test lets it go; a Stop meanwhile ends it as aborted.
			options?.signal?.addEventListener('abort', play, { once: true });
			void hold.then(play);
		}
		return stream;
	};
	return { streamFn, requests, titleRequests, sentOptions };
}
