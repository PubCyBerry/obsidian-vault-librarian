import type { AgentTool } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { Bm25Index, TOOL_SEARCH_NAME, ToolRegistry, tokenize } from '../src/tools/tool-registry';
import { mergeSettings } from '../src/types';

function fakeTool(name: string, description: string, label?: string): AgentTool {
	return {
		name,
		label,
		description,
		parameters: { type: 'object', properties: {} } as never,
		execute: async () => ({ content: [{ type: 'text', text: '{}' }] }),
	} as AgentTool;
}

const tools = [
	fakeTool('read', 'Read a range of lines from a text file.'),
	fakeTool(
		'outline__list_documents',
		'List documents in a collection of the Outline wiki.',
		'Outline: List documents',
	),
	fakeTool('outline__create_document', 'Create a new document in Outline with a title and text.'),
	fakeTool('calendar__list_events', 'List calendar events between two dates.'),
];

function registry() {
	return new ToolRegistry({
		registered: () => tools,
		sourceOf: (t) => (t.name.includes('__') ? t.name.split('__')[0]! : 'vault'),
		deferred: (t) => t.name.includes('__'),
	});
}

describe('deferred tools (LIB-TEST-137)', () => {
	it('tokenizes English with light stemming and folds accents', () => {
		expect(tokenize('Lists the Documents of a Collection; créate events')).toEqual([
			'list',
			'document',
			'collection',
			'create',
			'event',
		]);
	});

	it('ranks BM25 matches by relevance and drops non-matching documents', () => {
		const index = new Bm25Index([
			{ id: 'a', text: 'list documents in a collection' },
			{ id: 'b', text: 'create a document with a title' },
			{ id: 'c', text: 'list calendar events' },
		]);
		const ranked = index.search('list documents', 5);
		expect(ranked[0]!.id).toBe('a');
		expect(ranked).toHaveLength(3);
		expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
		expect(index.search('weather', 5)).toEqual([]);
	});

	it('shows direct tools and tool_search, then the deferred tools a search activated', async () => {
		const r = registry();
		expect(r.visible().map((t) => t.name)).toEqual(['read', TOOL_SEARCH_NAME]);
		const search = r.visible().find((t) => t.name === TOOL_SEARCH_NAME)!;
		expect(search.description).toContain(
			'- outline: outline__list_documents, outline__create_document',
		);
		expect(search.description).toContain('- calendar: calendar__list_events');
		const result = await search.execute(
			'id',
			{ query: 'outline wiki documents' } as never,
			undefined,
		);
		const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
			matches: { name: string; source: string }[];
			note?: string;
		};
		expect(parsed.matches[0]).toMatchObject({
			name: 'outline__list_documents',
			source: 'outline',
		});
		expect(parsed.note).toContain('next response');
		const visible = r.visible().map((t) => t.name);
		expect(visible).toContain('outline__list_documents');
		expect(visible).not.toContain('calendar__list_events');
		r.reset();
		expect(r.visible().map((t) => t.name)).toEqual(['read', TOOL_SEARCH_NAME]);
	});

	it('hints at English when a non-ASCII query finds nothing', async () => {
		const search = registry()
			.visible()
			.find((t) => t.name === TOOL_SEARCH_NAME)!;
		const result = await search.execute('id', { query: '문서 목록' } as never, undefined);
		const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
			hint?: string;
		};
		expect(parsed.hint).toContain('English');
	});

	it('leaves tool_search out when nothing is deferred', () => {
		const r = new ToolRegistry({
			registered: () => tools,
			sourceOf: () => 'vault',
			deferred: () => false,
		});
		expect(r.visible().map((t) => t.name)).not.toContain(TOOL_SEARCH_NAME);
		expect(mergeSettings({}).toolDeferredByTool).toEqual({});
	});
});
