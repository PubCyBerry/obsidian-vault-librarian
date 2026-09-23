import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { throwIfAborted, tool } from '../tools/registry';
import { type HostTool, runSandboxed } from './sandbox';

export type NestedStatus = 'ok' | 'failed' | 'rejected' | 'blocked' | 'expired';

/** One tool call made by a script, run through the same permission path as a model's call. */
export interface NestedCall {
	text: string;
	status: NestedStatus;
}

export interface RunJsDeps {
	/** Tools the model sees this turn; the script gets the same ones except run_js and tool_search. */
	toolNames: () => string[];
	/** `onWaiting(true)` when an approval card goes up and `(false)` when it is answered. */
	callTool: (
		callId: string,
		name: string,
		args: unknown,
		signal: AbortSignal | undefined,
		onWaiting: (waiting: boolean) => void,
	) => Promise<NestedCall>;
}

const SLICE_MS = 2000;
const MEMORY_BYTES = 64 * 1024 * 1024;

function parsed(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** The script's return value is dumped from the sandbox, so it is plain data or nothing. */
function show(value: unknown): string {
	try {
		return JSON.stringify(value) ?? 'undefined';
	} catch {
		return '[a value that cannot be shown as JSON]';
	}
}

export function createRunJsTool(deps: RunJsDeps): AgentTool {
	return tool({
		name: 'run_js',
		label: 'Run script',
		description:
			'Run JavaScript in a sandbox to combine several tool calls with loops, conditions and data processing in one step. The code is the body of an async function: use await and return. Call any listed tool as `await tools.<name>(args)`; it returns the parsed result and throws on failure, and each call asks for approval like a normal tool call. console.log output and the returned value come back to you; intermediate results stay in the script. There is no fetch, file system or Obsidian API inside: use tools.http_request, tools.read, tools.run_command and the like.',
		parameters: Type.Object({
			code: Type.String({
				minLength: 1,
				description: 'Body of an async JavaScript function.',
			}),
			timeout: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 300,
					description:
						'Seconds, not counting time spent waiting for approval. Default 30.',
				}),
			),
		}),
		executionMode: 'sequential',
		async execute(id, params, signal) {
			throwIfAborted(signal);
			const calls: string[] = [];
			let n = 0;
			const tools: Record<string, HostTool> = {};
			for (const name of deps.toolNames()) {
				if (name === 'run_js' || name === 'tool_search') continue;
				tools[name] = async (args, clock) => {
					// The clock stops while an approval card waits: that time is the user's, not the script's.
					const result = await deps.callTool(
						`${id}/${++n}`,
						name,
						args,
						signal,
						(waiting) => (waiting ? clock.pause() : clock.resume()),
					);
					calls.push(`${name} ${result.status}`);
					if (result.status !== 'ok') throw new Error(result.text);
					return parsed(result.text);
				};
			}
			const result = await runSandboxed({
				code: params.code,
				tools,
				timeoutMs: (params.timeout ?? 30) * 1000,
				sliceMs: SLICE_MS,
				memoryBytes: MEMORY_BYTES,
				signal,
			});
			const lines = [...result.logs];
			lines.push(
				result.ok ? `Returned: ${show(result.value)}` : (result.error ?? 'Script failed'),
			);
			if (calls.length) lines.push(`Tool calls: ${calls.join(', ')}`);
			const text = lines.join('\n');
			if (!result.ok) throw new Error(text);
			return { content: [{ type: 'text', text }], details: undefined };
		},
	});
}
