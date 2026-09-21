export interface SlashCommand {
	name: string;
	description: string;
	/** Runs with the text after the command name. */
	run: (args: string) => void | Promise<void>;
}

export interface ParsedSlash {
	name: string;
	args: string;
}

/** `/name rest of line` at the very start of the input; anything else is a normal message. */
export function parseSlash(text: string): ParsedSlash | null {
	const m = /^\/([\p{L}\p{N}_-]+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
	if (!m) return null;
	return { name: m[1]!.toLowerCase(), args: (m[2] ?? '').trim() };
}

/** Commands whose name starts with what was typed after `/`; empty query lists them all. */
export function matchCommands(commands: SlashCommand[], text: string): SlashCommand[] {
	if (!text.startsWith('/') || /\s/.test(text)) return [];
	const query = text.slice(1).toLowerCase();
	return commands.filter((c) => c.name.startsWith(query));
}

/** Fills `$ARGUMENTS` in a prompt template; without the placeholder the arguments are appended. */
export function fillTemplate(template: string, args: string): string {
	if (template.includes('$ARGUMENTS')) return template.replaceAll('$ARGUMENTS', args);
	return args ? `${template.trimEnd()}\n\n${args}` : template;
}
