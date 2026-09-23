import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { App } from 'obsidian';
import { Type } from 'typebox';
import { ok, throwIfAborted, tool } from './registry';

export const NO_COMMANDS = 'Obsidian commands are not available in this version.';
export const DID_NOT_RUN = 'The command did not run. It may need a note open in the editor.';

/** Obsidian's command registry. Not in the public API, so it is typed narrowly and checked at runtime. */
interface CommandRegistry {
	commands: Record<string, { id: string; name: string }>;
	executeCommandById(id: string): boolean;
}

function registryOf(app: App): CommandRegistry {
	const commands = (app as unknown as { commands?: Partial<CommandRegistry> }).commands;
	if (!commands?.commands || typeof commands.executeCommandById !== 'function')
		throw new Error(NO_COMMANDS);
	return commands as CommandRegistry;
}

/** `command:<id>`: one permission per command. */
export function commandPermissionKey(args: unknown): string | null {
	const id = (args as { id?: unknown } | null)?.id;
	return typeof id === 'string' && id ? `command:${id}` : null;
}

export function createCommandTools(app: App): AgentTool[] {
	return [
		tool({
			name: 'list_commands',
			label: 'List commands',
			description:
				'List the Obsidian commands on this device, the same ones the command palette shows, by id and name. Filter with a word from the id or the name.',
			parameters: Type.Object({
				query: Type.Optional(Type.String({ description: 'Part of the id or name.' })),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 200, description: 'Default 50.' }),
				),
			}),
			async execute(_id, params, signal) {
				throwIfAborted(signal);
				const q = (params.query ?? '').trim().toLowerCase();
				const all = Object.values(registryOf(app).commands)
					.filter(
						(c) =>
							!q ||
							c.id.toLowerCase().includes(q) ||
							c.name.toLowerCase().includes(q),
					)
					.sort((a, b) => a.name.localeCompare(b.name));
				return ok({
					query: params.query ?? '',
					commands: all
						.slice(0, params.limit ?? 50)
						.map((c) => ({ id: c.id, name: c.name })),
					total: all.length,
				});
			},
		}),
		tool({
			name: 'run_command',
			label: 'Run command',
			description:
				'Run an Obsidian command by its id, as if chosen from the command palette. Find ids with list_commands. Editor commands act on the note open in the editor. What a command changes is not undone by rewinding the chat.',
			parameters: Type.Object({
				id: Type.String({ minLength: 1, description: 'Command id from list_commands.' }),
			}),
			executionMode: 'sequential',
			async execute(_id, params, signal) {
				throwIfAborted(signal);
				const registry = registryOf(app);
				const command = registry.commands[params.id];
				if (!command) throw new Error(`Unknown command: ${params.id}`);
				const ran = registry.executeCommandById(params.id) !== false;
				return ok({
					id: command.id,
					name: command.name,
					ran,
					...(ran ? {} : { note: DID_NOT_RUN }),
				});
			},
		}),
	];
}
