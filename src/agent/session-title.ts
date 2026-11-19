import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import {
	createInitialSystemMessage,
	normalizeContext,
} from '@earendil-works/pi-ai/utils/transcript';
import type { PiModel } from '../provider/provider-manager';
import { ATTACHED_BLOCK } from '../ui/mentions';

export const TITLE_PROMPT =
	"You name chat sessions. Reply with a title for the conversation that the user's message starts: at most six words, in the language of the message, naming its subject. Reply with the title alone, without quotes, Markdown or a period.";

/** Enough of the first message to tell its subject; an attached note goes by its path. */
const ASKED_CHARS = 2000;

/** Quotes, emphasis and a closing period around a title. */
const WRAP = /^["'“‘`*_]+|["'”’`*_.。]+$/g;

/** A title fit to show: its first line, without the quotes or Markdown a model may wrap it in. */
export function cleanTitle(raw: string): string {
	const line = raw.trim().split('\n', 1)[0] ?? '';
	return line
		.replace(WRAP, '')
		.replace(/^(?:#+\s*|title:\s*)/i, '')
		.replace(WRAP, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 60);
}

/**
 * Names a session from its first message, as Claude Code does (LIB-FEAT-325): one short request
 * to the session's own model, which has already been sent that message. Null when the model gave
 * no usable title, so the start of the message stays the name.
 */
export async function generateTitle(
	streamFn: StreamFn,
	model: PiModel,
	message: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const asked = message
		.replace(ATTACHED_BLOCK, (_m, _tag: string, id: string) => ` ${id}`)
		.trim()
		.slice(0, ASKED_CHARS);
	if (!asked) return null;
	const leading = createInitialSystemMessage(TITLE_PROMPT, []);
	const context = normalizeContext({
		messages: [
			...(leading ? [leading] : []),
			{ role: 'user', content: asked, timestamp: Date.now() },
		],
	});
	const result = await (await streamFn(model, context, { signal })).result();
	if (result.stopReason === 'error' || result.stopReason === 'aborted') return null;
	const text = result.content
		.filter((c): c is TextContent => c.type === 'text')
		.map((c) => c.text)
		.join('');
	return cleanTitle(text) || null;
}
