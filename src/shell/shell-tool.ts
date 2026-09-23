import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Bash } from 'just-bash/browser';
import type { App } from 'obsidian';
import { Type } from 'typebox';
import { ok, throwIfAborted, tool } from '../tools/registry';
import { createCurl, createObsidian, REFUSED } from './commands';
import { VAULT_ROOT, VaultFs } from './vault-fs';

/** stdout and stderr together; a shell's output matters most at the end. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_MEMORY_FILE_BYTES = 64 * 1024 * 1024;

export const STOPPED = 'The shell was stopped.';

export interface ShellDeps {
	app: App;
	/** Characters of tool result the model may receive, from the context settings. */
	resultLimit: () => number;
	/** Permission and approval for one thing a command is about to do. Throws to refuse. */
	gate: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<void>;
	/** Rewind snapshot around one vault write. */
	snapshot: {
		before: (id: string, path: string) => Promise<void>;
		after: (id: string, path: string) => Promise<void>;
	};
}

const DESCRIPTION = `Run a shell command. This is a POSIX shell inside Obsidian, not your operating system: there is no git, node, python or network except through the commands below, and nothing outside this vault is visible.

The vault is the working directory, so ls, cat, grep, sed, awk, find, rg, jq, sort and the usual text tools work on notes. /tmp is scratch space that lasts for this conversation; use it to hold a large response and pick through it over several calls.

Two commands are specific to Obsidian:
- curl sends an HTTP request to any URL and writes the response body to stdout exactly as the server sent it. Pipe it through grep, sed or jq to keep only what you need, or use -o to save it.
- obsidian runs an Obsidian command, such as \`obsidian search query=... limit=5\`, \`obsidian command id=<command id>\` or \`obsidian backlinks path=<note> format=json\`. Run \`obsidian help\` to see what this vault offers.

Prefer the read, write and edit tools for ordinary note work: they show sources with line numbers and can be undone. Use this when you need to combine steps, filter a large result, or reach the web.`;

/**
 * The shell for one conversation. The limits belong to the `Bash` instance, so each call builds
 * one with its own deadline, but the filesystem is kept: `/tmp` survives from call to call.
 */
export class ShellSession {
	private fs: VaultFs | null = null;
	/** The call being served, so the filesystem can reach the right approval and snapshot ids. */
	private call: { id: string; signal?: AbortSignal } = { id: 'shell' };
	private writes = 0;
	private saved = 0;
	/** Notes changed by the command now running, with the snapshot id opened for each. */
	private readonly pending = new Map<string, string>();

	constructor(private readonly deps: ShellDeps) {}

	/** Dropped when the conversation changes, so one session never sees another's scratch files. */
	reset(): void {
		this.fs = null;
		this.saved = 0;
	}

	private filesystem(): VaultFs {
		if (this.fs) return this.fs;
		this.fs = new VaultFs(this.deps.app, async (path, content) => {
			// A redirect reaches here before its text does, so the card shows the path alone
			// unless this first write already carries what the note will hold.
			const args =
				content === null ? { path, removed: true } : content ? { path, content } : { path };
			await this.deps.gate('write', args, this.call.signal);
			const id = `${this.call.id}/w${++this.writes}`;
			this.pending.set(path, id);
			await this.deps.snapshot.before(id, path);
		});
		return this.fs;
	}

	/**
	 * Closes each note's rewind snapshot once the command is over. A redirect writes twice, so
	 * closing at the first write would record the half-written note as what the user now has.
	 */
	private async closeSnapshots(): Promise<void> {
		const pending = [...this.pending];
		this.pending.clear();
		for (const [path, id] of pending) await this.deps.snapshot.after(id, path);
	}

	private shell(timeoutSeconds: number): Bash {
		const signal = this.call.signal;
		const deps = {
			app: this.deps.app,
			gate: (name: string, args: Record<string, unknown>) =>
				this.deps.gate(name, args, signal),
			signal,
		};
		return new Bash({
			fs: this.filesystem(),
			cwd: VAULT_ROOT,
			customCommands: [createCurl(deps), createObsidian(deps)],
			executionLimits: {
				maxExecutionTimeMs: timeoutSeconds * 1000,
				maxOutputSize: MAX_OUTPUT_BYTES,
				maxFileSystemBytes: MAX_MEMORY_FILE_BYTES,
			},
		});
	}

	async run(
		callId: string,
		command: string,
		timeoutSeconds: number,
		signal?: AbortSignal,
	): Promise<string> {
		this.call = { id: callId, signal };
		const bash = this.shell(timeoutSeconds);
		this.filesystem().beginCommand();
		let result: Awaited<ReturnType<Bash['exec']>>;
		try {
			result = await bash.exec(command, { signal });
		} catch (error) {
			if (signal?.aborted) throw new Error(STOPPED);
			// A refused or read-only vault write is reported by the filesystem, which the
			// interpreter passes straight out; the script has already stopped at that point.
			const message = error instanceof Error ? error.message : String(error);
			return `Exit code: ${REFUSED}\nbash: ${message}\n`;
		} finally {
			await this.closeSnapshots();
		}
		if (signal?.aborted) throw new Error(STOPPED);
		const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
		const head = result.exitCode === 0 ? '' : `Exit code: ${result.exitCode}\n`;
		return head + (await this.fit(bash, output));
	}

	/** Keeps the tail, which is where a pipeline's answer is, and parks the whole thing in /tmp. */
	private async fit(bash: Bash, output: string): Promise<string> {
		const limit = Math.max(1000, this.deps.resultLimit() - 200);
		if (output.length <= limit) return output;
		const path = `/tmp/bash-${++this.saved}.out`;
		try {
			await bash.exec(`cat > ${path}`, { stdin: output });
		} catch {
			// Saving is a convenience; a failure here must not lose the tail we can still show.
		}
		const cut = output.length - limit;
		return `[earlier ${cut} characters are in ${path}; read them with head, grep or sed]\n${output.slice(cut)}`;
	}
}

export function createShellTool(session: ShellSession): AgentTool {
	return tool({
		name: 'bash',
		label: 'Shell',
		description: DESCRIPTION,
		parameters: Type.Object({
			command: Type.String({ minLength: 1, description: 'The shell command to run.' }),
			timeout: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 300,
					description: 'Seconds to allow. Default 30.',
				}),
			),
		}),
		executionMode: 'sequential',
		execute: async (callId, params, signal) => {
			throwIfAborted(signal);
			return ok(await session.run(callId, params.command, params.timeout ?? 30, signal));
		},
	});
}
