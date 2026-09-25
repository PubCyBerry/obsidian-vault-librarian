/**
 * Sub-agent definitions (LIB-FEAT-268): Markdown files under `.agents/agents/` at the vault root,
 * in Claude Code's format. The frontmatter names the agent, says when to use it and narrows what
 * it may do; the body is its instructions. Two agents are built in, and a file of the same name
 * takes their place.
 */

import type { App } from 'obsidian';
import { readFrontmatter } from '../skills/skill-manager';
import { AGENTS_DIR } from '../tools/path-policy';
import { THINKING_LEVELS, type ThinkingLevel } from '../types';

export const AGENT_KEY_PREFIX = 'agent:';
export const GENERAL_AGENT = 'general-purpose';
export const EXPLORE_AGENT = 'explore';

/** Settings key of an agent's permission, next to the tool names. */
export function agentKey(name: string): string {
	return `${AGENT_KEY_PREFIX}${name}`;
}

/** Permission group of the agents. The Sub-agents settings page shows it; Tool permissions does not. */
export const AGENTS_GROUP_ID = 'agents';

export function agentGroup(agents: readonly AgentDefinition[]) {
	return { id: AGENTS_GROUP_ID, label: 'Sub-agents', tools: agents.map((a) => agentKey(a.name)) };
}

/**
 * How the agent's calls meet the permission settings. None of them lets a call through that the
 * settings would stop: `plan` gives it only tools that read, and `dontAsk` refuses a call that
 * would need approval instead of asking.
 */
export type PermissionMode = 'default' | 'plan' | 'dontAsk';

export const AGENT_COLORS = [
	'red',
	'orange',
	'yellow',
	'green',
	'cyan',
	'blue',
	'purple',
	'pink',
] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

export interface AgentDefinition {
	name: string;
	description: string;
	/** Its instructions, which take the place of the Custom system prompt; null keeps that one. */
	prompt: string | null;
	/** Tools it may use, as names or `prefix*` patterns; absent means those of the main agent. */
	tools?: string[];
	/** Tools taken away first, in the same form. */
	disallowedTools?: string[];
	/** `<provider id>/<model id>`, or a model id or name; absent means the main agent's. */
	model?: string;
	effort?: ThinkingLevel;
	/** Turns with tool calls before it stops; absent means the setting's. */
	maxTurns?: number;
	permissionMode: PermissionMode;
	/** Skills whose SKILL.md goes into its instructions from the start. */
	skills?: string[];
	color?: AgentColor;
	/** Vault path of its file; null for a built-in one. */
	location: string | null;
	warnings: string[];
}

export interface AgentDiagnostic {
	location: string;
	message: string;
}

export const BUILT_IN_AGENTS: readonly AgentDefinition[] = [
	{
		name: GENERAL_AGENT,
		description:
			'For a self-contained task that needs both finding and changing notes, with the tools and instructions of the main agent.',
		prompt: null,
		permissionMode: 'default',
		location: null,
		warnings: [],
	},
	{
		name: EXPLORE_AGENT,
		description:
			'Finds and reads notes to answer one specific question, and changes nothing. Run several side by side for independent questions.',
		prompt: null,
		permissionMode: 'plan',
		location: null,
		warnings: [],
	},
];

/** Claude Code's tool names, so its agent files work here; anything else is taken as written. */
const TOOL_ALIASES: Record<string, string> = {
	glob: 'find',
	multiedit: 'edit',
};

function list(value: unknown): string[] | undefined {
	const items =
		typeof value === 'string'
			? value.split(',')
			: Array.isArray(value)
				? value.filter((v): v is string => typeof v === 'string')
				: null;
	if (!items) return undefined;
	return items.map((s) => s.trim()).filter(Boolean);
}

/** Tool names are lowercase here, so `Read` and `read` are one tool. */
function toolList(value: unknown): string[] | undefined {
	return list(value)?.map((t) => {
		const lower = t.toLowerCase();
		return TOOL_ALIASES[lower] ?? lower;
	});
}

/**
 * One definition file. A missing name or description skips it; a value it cannot use only warns,
 * and the rest of the file still counts. Keys it does not know are left alone.
 */
export function parseAgentMd(
	text: string,
	location: string,
): { agent?: AgentDefinition; error?: string } {
	const read = readFrontmatter(text);
	if ('error' in read) return { error: read.error };
	const { fm, body } = read;
	const name = typeof fm.name === 'string' ? fm.name.trim() : '';
	if (!name) return { error: 'Missing name' };
	if (name.startsWith('-') || name.includes(':'))
		return { error: `Name "${name}" may not start with - or hold :` };
	const description = typeof fm.description === 'string' ? fm.description.trim() : '';
	if (!description) return { error: 'Missing description' };
	const warnings: string[] = [];
	const agent: AgentDefinition = {
		name,
		description,
		prompt: body.trim() || null,
		permissionMode: 'default',
		location,
		warnings,
	};
	const tools = toolList(fm.tools);
	if (tools) agent.tools = tools;
	const denied = toolList(fm.disallowedTools);
	if (denied) agent.disallowedTools = denied;
	if (typeof fm.model === 'string' && fm.model.trim() && fm.model.trim() !== 'inherit')
		agent.model = fm.model.trim();
	if (fm.effort !== undefined) {
		if (THINKING_LEVELS.includes(fm.effort as ThinkingLevel))
			agent.effort = fm.effort as ThinkingLevel;
		else warnings.push(`effort "${String(fm.effort)}" is not a thinking level`);
	}
	if (fm.maxTurns !== undefined) {
		const n = Number(fm.maxTurns);
		if (Number.isInteger(n) && n > 0) agent.maxTurns = n;
		else warnings.push('maxTurns is not a positive whole number');
	}
	const mode = fm.permissionMode;
	if (mode === 'plan' || mode === 'dontAsk') agent.permissionMode = mode;
	else if (mode !== undefined && mode !== 'default' && mode !== 'manual')
		warnings.push(
			`permissionMode "${String(mode)}" cannot raise what Settings allow; it asks as they say`,
		);
	const skills = list(fm.skills);
	if (skills) agent.skills = skills;
	if (fm.color !== undefined) {
		if (AGENT_COLORS.includes(fm.color as AgentColor)) agent.color = fm.color as AgentColor;
		else warnings.push(`color "${String(fm.color)}" is not one of ${AGENT_COLORS.join(', ')}`);
	}
	return { agent };
}

/** `name` as a pattern list matches it: exactly, or by the part before a trailing `*`. */
export function matchesTool(name: string, patterns: readonly string[]): boolean {
	return patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : p === name));
}

/**
 * The tools an agent gets. Without its own list it gets `visible`, what the main agent sees; with
 * one it chooses from `registered`, deferred tools included. The denied ones go first, as in
 * Claude Code; `plan` keeps only tools that read.
 */
export function toolsFor<T extends { name: string }>(
	agent: AgentDefinition,
	visible: readonly T[],
	registered: readonly T[],
	readsOnly: (name: string) => boolean,
): T[] {
	let pool = agent.tools ? [...registered] : [...visible];
	if (agent.disallowedTools)
		pool = pool.filter((t) => !matchesTool(t.name, agent.disallowedTools!));
	if (agent.tools) pool = pool.filter((t) => matchesTool(t.name, agent.tools!));
	if (agent.permissionMode === 'plan') pool = pool.filter((t) => readsOnly(t.name));
	return pool;
}

export class AgentManager {
	/** Built-in agents and those found, a file taking the place of a built-in of its name. */
	agents: AgentDefinition[] = [...BUILT_IN_AGENTS];
	diagnostics: AgentDiagnostic[] = [];
	private readonly listeners = new Set<() => void>();

	constructor(private readonly app: App) {}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get(name: string): AgentDefinition | undefined {
		return this.agents.find((a) => a.name === name);
	}

	/** Every `.md` under `.agents/agents`, subfolders too, the first of a name winning. */
	async scan(): Promise<AgentDefinition[]> {
		const adapter = this.app.vault.adapter;
		const files: string[] = [];
		const pending = (await adapter.exists(AGENTS_DIR)) ? [AGENTS_DIR] : [];
		while (pending.length) {
			const listed = await adapter.list(pending.pop()!);
			files.push(...listed.files.filter((f) => f.toLowerCase().endsWith('.md')));
			pending.push(...listed.folders);
		}
		const found: AgentDefinition[] = [];
		const diagnostics: AgentDiagnostic[] = [];
		for (const location of files.sort()) {
			let text: string;
			try {
				text = await adapter.read(location);
			} catch (e) {
				diagnostics.push({ location, message: e instanceof Error ? e.message : String(e) });
				continue;
			}
			const parsed = parseAgentMd(text, location);
			if (!parsed.agent) {
				diagnostics.push({ location, message: parsed.error ?? 'Unreadable' });
				continue;
			}
			const clash = found.find((a) => a.name === parsed.agent!.name);
			if (clash) {
				diagnostics.push({ location, message: `Shadowed by ${clash.location}` });
				continue;
			}
			for (const w of parsed.agent.warnings) diagnostics.push({ location, message: w });
			found.push(parsed.agent);
		}
		this.agents = [
			...BUILT_IN_AGENTS.filter((b) => !found.some((a) => a.name === b.name)),
			...found,
		];
		this.diagnostics = diagnostics;
		for (const l of this.listeners) l();
		return this.agents;
	}

	/**
	 * What a file in the definitions folder now defines, or why it defines nothing, for the result
	 * of the write or edit that changed it. The change's own hook has scanned again by then.
	 */
	describe(path: string): Record<string, unknown> | null {
		if (!path.startsWith(`${AGENTS_DIR}/`) || !path.toLowerCase().endsWith('.md')) return null;
		const agent = this.agents.find((a) => a.location === path);
		if (agent)
			return {
				agent: {
					name: agent.name,
					...(agent.tools ? { tools: agent.tools } : {}),
					...(agent.warnings.length ? { warnings: agent.warnings } : {}),
				},
			};
		const problem = this.diagnostics.find((d) => d.location === path);
		return problem ? { agentProblem: problem.message } : null;
	}
}
