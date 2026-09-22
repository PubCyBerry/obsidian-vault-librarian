import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

export const TOOL_SEARCH_NAME = 'tool_search';
const DEFAULT_LIMIT = 5;

/** Small BM25 over short English texts: ASCII-folded, lowercased, light suffix stripping. */
const STOP = new Set([
	'a',
	'an',
	'and',
	'are',
	'as',
	'at',
	'be',
	'by',
	'for',
	'from',
	'in',
	'is',
	'it',
	'of',
	'on',
	'or',
	'that',
	'the',
	'this',
	'to',
	'use',
	'when',
	'with',
]);

export function tokenize(text: string): string[] {
	return text
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 1 && !STOP.has(w))
		.map((w) => {
			if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
			if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
			if (w.length > 3 && (w.endsWith('ed') || w.endsWith('s')))
				return w.replace(/(ed|s)$/, '');
			return w;
		});
}

export class Bm25Index<T> {
	private readonly docs: { id: T; terms: Map<string, number>; length: number }[] = [];
	private readonly df = new Map<string, number>();
	private avgLength = 0;

	constructor(
		entries: { id: T; text: string }[],
		private readonly k1 = 1.2,
		private readonly b = 0.75,
	) {
		for (const { id, text } of entries) {
			const terms = new Map<string, number>();
			const tokens = tokenize(text);
			for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
			for (const t of terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
			this.docs.push({ id, terms, length: tokens.length });
		}
		this.avgLength = this.docs.reduce((n, d) => n + d.length, 0) / (this.docs.length || 1);
	}

	search(query: string, limit: number): { id: T; score: number }[] {
		const n = this.docs.length;
		const scored = this.docs.map((doc) => {
			let score = 0;
			for (const term of new Set(tokenize(query))) {
				const tf = doc.terms.get(term) ?? 0;
				if (!tf) continue;
				const df = this.df.get(term) ?? 0;
				const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
				const norm = 1 - this.b + (this.b * doc.length) / (this.avgLength || 1);
				score += (idf * tf * (this.k1 + 1)) / (tf + this.k1 * norm);
			}
			return { id: doc.id, score };
		});
		return scored
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}
}

export interface RegisteredTool {
	tool: AgentTool;
	/** Where the tool comes from: `vault` or an MCP server name. */
	source: string;
	/** Deferred tools stay out of the model's list until tool_search activates them. */
	deferred: boolean;
}

export interface ToolRegistryDeps {
	/** Everything registered, fresh on every call (MCP servers connect and disconnect). */
	registered: () => AgentTool[];
	sourceOf: (tool: AgentTool) => string;
	deferred: (tool: AgentTool) => boolean;
}

/**
 * Splits what is registered from what the model sees. Deferred tools are found through
 * `tool_search` (BM25 over name, label and description) and stay visible for the session.
 */
export class ToolRegistry {
	private readonly activated = new Set<string>();

	constructor(private readonly deps: ToolRegistryDeps) {}

	entries(): RegisteredTool[] {
		return this.deps.registered().map((tool) => ({
			tool,
			source: this.deps.sourceOf(tool),
			deferred: this.deps.deferred(tool),
		}));
	}

	deferredEntries(): RegisteredTool[] {
		return this.entries().filter((e) => e.deferred);
	}

	activatedNames(): string[] {
		return [...this.activated];
	}

	activate(names: string[]): void {
		for (const n of names) this.activated.add(n);
	}

	/** A new or reopened session starts with only the direct tools. */
	reset(): void {
		this.activated.clear();
	}

	/** Direct tools, activated deferred tools, and tool_search while any deferred tool exists. */
	visible(): AgentTool[] {
		const entries = this.entries();
		const out = entries
			.filter((e) => !e.deferred || this.activated.has(e.tool.name))
			.map((e) => e.tool);
		if (entries.some((e) => e.deferred)) out.push(this.searchTool(entries));
		return out;
	}

	search(
		query: string,
		limit = DEFAULT_LIMIT,
	): { name: string; description: string; source: string }[] {
		const deferred = this.deferredEntries();
		const index = new Bm25Index(
			deferred.map((e) => ({
				id: e.tool.name,
				text: `${e.tool.name.replace(/__/g, ' ')} ${e.tool.label ?? ''} ${e.tool.description} ${e.source}`,
			})),
		);
		const byName = new Map(deferred.map((e) => [e.tool.name, e]));
		return index.search(query, limit).map(({ id }) => {
			const e = byName.get(id)!;
			return { name: e.tool.name, description: e.tool.description, source: e.source };
		});
	}

	private searchTool(entries: RegisteredTool[]): AgentTool {
		const sources = new Map<string, number>();
		for (const e of entries)
			if (e.deferred) sources.set(e.source, (sources.get(e.source) ?? 0) + 1);
		const listing = [...sources]
			.map(([name, count]) => `- ${name}: ${count} ${count === 1 ? 'tool' : 'tools'}`)
			.join('\n');
		const description = `Searches deferred tool metadata with BM25 and exposes the matching tools on the next model call. Some tools were not listed upfront; search for them by what they do before saying a capability is missing. Write the query in English keywords, whatever language the user writes in.\n\nDeferred tools come from:\n${listing}`;
		const tool: AgentTool<ReturnType<typeof searchParameters>> = {
			name: TOOL_SEARCH_NAME,
			label: 'Find tools',
			description,
			parameters: searchParameters(),
			execute: async (_id, params) => {
				const query = params.query.trim();
				if (!query) throw new Error('query must not be empty');
				const limit = params.limit ?? DEFAULT_LIMIT;
				const matches = this.search(query, limit);
				this.activate(matches.map((m) => m.name));
				const result: Record<string, unknown> = { query, matches };
				if (!matches.length && /\P{ASCII}/u.test(query))
					result.hint = 'No match. Write the query in English keywords.';
				else if (matches.length)
					result.note = 'These tools are available from your next response on.';
				return ok(result);
			},
		};
		return tool as AgentTool;
	}
}

function searchParameters() {
	return Type.Object({
		query: Type.String({
			minLength: 1,
			description: 'English keywords for what the tool should do.',
		}),
		limit: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 20,
				description: `Maximum tools to return. Default ${DEFAULT_LIMIT}.`,
			}),
		),
	});
}

function ok(result: unknown): AgentToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result as never };
}
