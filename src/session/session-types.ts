import type { ThinkingLevel } from '../types';

export interface SessionMetadata {
	id: string;
	title: string;
	providerId: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
	createdAt: string;
	updatedAt: string;
}

export interface SessionSummary extends SessionMetadata {
	messageCount: number;
	path: string;
}

export interface StoredToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	/** Gemini's thought signature, which the next request must send back with the call (LIB-FEAT-250). */
	thoughtSignature?: string;
}

export interface StoredUsage {
	input: number;
	output: number;
	cacheRead: number;
	/** Absent in sessions written before 2.3.0. */
	cacheWrite?: number;
	totalTokens: number;
}

export type SessionEvent =
	| { t: string; type: 'meta'; session: SessionMetadata }
	| { t: string; type: 'user'; content: string; images?: string[] }
	| {
			t: string;
			type: 'assistant';
			content: string;
			thinking?: string;
			toolCalls: StoredToolCall[];
			usage?: StoredUsage;
			stopReason?: string;
	  }
	| {
			t: string;
			type: 'tool_call';
			toolCallId: string;
			name: string;
			args: Record<string, unknown>;
	  }
	| {
			t: string;
			type: 'approval';
			toolCallId: string;
			name: string;
			decision: 'approved' | 'rejected' | 'expired';
	  }
	| {
			t: string;
			type: 'tool_result';
			toolCallId: string;
			name: string;
			ok: boolean;
			content: string;
			truncated: boolean;
	  }
	| {
			t: string;
			type: 'compaction';
			summary: string;
			coveredUntil: number;
			/**
			 * The user's own messages from the covered part, the newest within a budget, sent before
			 * the summary (LIB-FEAT-256). Absent on compactions written before 2.13.0.
			 */
			retained?: string[];
			tokensBefore: number;
			tokensAfter: number;
			method: 'summary' | 'truncate';
	  }
	| {
			t: string;
			type: 'model_change';
			providerId: string;
			modelId: string;
			thinkingLevel?: ThinkingLevel;
	  }
	| { t: string; type: 'rename'; title: string }
	| {
			t: string;
			type: 'snapshot';
			toolCallId: string;
			path: string;
			ref: string | null;
			afterHash: string;
	  }
	| { t: string; type: 'rewind'; toEventIndex: number }
	| { t: string; type: 'error'; stage: 'provider' | 'tool' | 'context'; message: string };

export type SessionEventInput = SessionEvent extends infer E
	? E extends { t: string }
		? Omit<E, 't'>
		: never
	: never;

/** An event with its 0-based position in the file. Positions stay stable across rewinds. */
export interface IndexedEvent {
	index: number;
	event: SessionEvent;
}
