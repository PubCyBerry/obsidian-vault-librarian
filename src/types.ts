export type ApiType = 'openai-completions' | (string & {});
export type TransportMode = 'auto' | 'requestUrl' | 'fetch';
export type InputModality = 'text' | 'image';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ToolPermission = 'always_allow' | 'approval_required' | 'blocked';
/** How a batch of tool calls runs; a batch with any sequential tool runs sequentially (Pi). */
export type ToolExecutionMode = 'parallel' | 'sequential';
export type ToolName =
	| 'ls'
	| 'find'
	| 'grep'
	| 'read'
	| 'get_active_note'
	| 'write'
	| 'edit'
	| 'tool_search'
	| 'skill_search';
export type McpAuthMode = 'oauth' | 'apiKey' | 'none';

/** A remote MCP server reached over Streamable HTTP. Credentials live in SecretStorage. */
export interface McpServerConfig {
	/** Lowercase letters, digits and hyphens; it prefixes every tool name and secret id. */
	id: string;
	name: string;
	url: string;
	auth: McpAuthMode;
	enabled: boolean;
	/** Fingerprint of each tool declaration as last seen, keyed by exposed tool name. */
	toolHashes: Record<string, string>;
}

/** One WebDAV storage such as a NAS. The password lives in SecretStorage, never here. */
export interface WebDavSettings {
	enabled: boolean;
	/** Storage root; tool paths are relative to it. */
	url: string;
	/** Empty means no authentication. */
	username: string;
}

export const TOOL_NAMES: readonly ToolName[] = [
	'ls',
	'find',
	'grep',
	'read',
	'get_active_note',
	'write',
	'edit',
	'tool_search',
	'skill_search',
];

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	'off',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
];

export interface ProviderCompat {
	supportsStore?: boolean;
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
	supportsUsageInStreaming?: boolean;
	supportsFinishReason?: boolean;
	supportsStrictMode?: boolean;
	maxTokensField?: 'max_tokens' | 'max_completion_tokens';
	requiresToolResultName?: boolean;
	requiresAssistantAfterToolResult?: boolean;
	requiresThinkingAsText?: boolean;
	requiresReasoningContentOnAssistantMessages?: boolean;
	thinkingFormat?: string;
	/** Prompt cache markers the endpoint needs. Anthropic-style `cache_control` is the only known format. */
	cacheControlFormat?: 'anthropic';
}

export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelConfig {
	id: string;
	name: string;
	api?: ApiType;
	toolCalling: boolean;
	reasoning: boolean;
	input: InputModality[];
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	cost: ModelCost;
	samplingParams?: Record<string, unknown>;
	compat?: ProviderCompat;
}

export interface RequestDefaults {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	maxTokens?: number;
	thinkingLevel?: ThinkingLevel;
	stream?: boolean;
	timeoutMs: number;
	maxRetries: number;
	extraBody?: Record<string, unknown>;
}

export interface ProviderConfig {
	id: string;
	name: string;
	baseUrl: string;
	api: ApiType;
	secretId: string;
	authHeader: boolean;
	transport: TransportMode;
	compat: ProviderCompat;
	models: ModelConfig[];
	requestDefaults: RequestDefaults;
}

export interface ContextSettings {
	warningAt: number;
	compactAt: number;
	preserveRecentTurns: number;
	reserveOutputTokens: 'model-max' | number;
	safetyMarginTokens: number;
}

export interface ToolPermissionSettings {
	/** Keyed by tool name; MCP tools use `<server id>__<tool>`. Unknown names ask first. */
	byTool: Record<string, ToolPermission>;
}

export interface LibrarianSettings {
	version: number;
	providers: ProviderConfig[];
	activeProviderId: string | null;
	activeModelId: string | null;
	toolPermissions: ToolPermissionSettings;
	/** Default for a batch of tool calls. */
	toolExecution: ToolExecutionMode;
	/** Per tool; a tool absent here keeps its own default (write, edit and MCP tools: sequential). */
	toolExecutionByTool: Record<string, ToolExecutionMode>;
	/**
	 * Per tool, and per skill under `skill:<name>`; absent means the default: DEFAULT_LISTED_TOOLS
	 * listed, every other tool and skill deferred (found through tool_search and skill_search).
	 */
	toolDeferredByTool: Record<string, boolean>;
	mcpServers: McpServerConfig[];
	webdav: WebDavSettings;
	/** Where "Open chat" puts the view when none is open yet. */
	chatLocation: 'sidebar' | 'tab';
	/** Vault folder whose notes become `/<name>` prompt commands. */
	commandsFolder: string;
	/** Turns with tool calls before a run stops and waits; 0 means no limit. */
	maxIterations: number;
	repeatedFailureLimit: number;
	useVaultAgentsMd: boolean;
	customSystemPrompt: string;
	context: ContextSettings;
	toolResultMaxChars: number;
	listLimit: number;
	grepLimit: number;
	readLineLimit: number;
}

/** A new install reads without asking and asks before anything that changes or runs (LIB-ADR-026). */
export const DEFAULT_TOOL_PERMISSIONS: ToolPermissionSettings = {
	byTool: {
		ls: 'always_allow',
		find: 'always_allow',
		grep: 'always_allow',
		read: 'always_allow',
		get_active_note: 'always_allow',
		tool_search: 'always_allow',
		skill_search: 'always_allow',
		write: 'approval_required',
		edit: 'approval_required',
		bash: 'approval_required',
	},
};

/** The tools a new install lists upfront; everything else waits for tool_search (LIB-ADR-026). */
export const DEFAULT_LISTED_TOOLS: ReadonlySet<string> = new Set([
	'ls',
	'find',
	'grep',
	'read',
	'write',
	'edit',
	'bash',
	'skill_search',
]);

export const DEFAULT_REQUEST_DEFAULTS: RequestDefaults = {
	stream: true,
	timeoutMs: 120000,
	maxRetries: 2,
};

export const DEFAULT_SETTINGS: LibrarianSettings = {
	version: 1,
	providers: [],
	activeProviderId: null,
	activeModelId: null,
	toolPermissions: DEFAULT_TOOL_PERMISSIONS,
	toolExecution: 'parallel',
	toolExecutionByTool: {},
	toolDeferredByTool: {},
	mcpServers: [],
	webdav: { enabled: false, url: '', username: '' },
	chatLocation: 'sidebar',
	commandsFolder: 'Librarian/commands',
	maxIterations: 0,
	repeatedFailureLimit: 3,
	useVaultAgentsMd: true,
	customSystemPrompt: '',
	context: {
		warningAt: 0.7,
		compactAt: 0.85,
		preserveRecentTurns: 6,
		reserveOutputTokens: 'model-max',
		safetyMarginTokens: 4096,
	},
	toolResultMaxChars: 8000,
	listLimit: 100,
	grepLimit: 20,
	readLineLimit: 200,
};

/** Deep-ish merge of stored data over the defaults so that new fields get their default. */
export function mergeSettings(stored: unknown): LibrarianSettings {
	const s = (stored ?? {}) as Partial<LibrarianSettings>;
	const byTool = { ...DEFAULT_TOOL_PERMISSIONS.byTool, ...(s.toolPermissions?.byTool ?? {}) };
	// Settings written before 1.8.0 kept this choice per provider as `parallelReadTools`.
	const legacySequential = (s.providers ?? []).some(
		(p) =>
			(p.requestDefaults as { parallelReadTools?: boolean } | undefined)
				?.parallelReadTools === false,
	);
	return {
		...DEFAULT_SETTINGS,
		...s,
		toolExecution: s.toolExecution ?? (legacySequential ? 'sequential' : 'parallel'),
		toolExecutionByTool: { ...(s.toolExecutionByTool ?? {}) },
		toolDeferredByTool: { ...(s.toolDeferredByTool ?? {}) },
		toolPermissions: { byTool },
		context: { ...DEFAULT_SETTINGS.context, ...(s.context ?? {}) },
		mcpServers: (s.mcpServers ?? []).map((m) => ({ ...m, toolHashes: m.toolHashes ?? {} })),
		webdav: { ...DEFAULT_SETTINGS.webdav, ...(s.webdav ?? {}) },
		providers: (s.providers ?? []).map((p) => ({
			...p,
			compat: p.compat ?? {},
			models: p.models ?? [],
			requestDefaults: { ...DEFAULT_REQUEST_DEFAULTS, ...(p.requestDefaults ?? {}) },
		})),
	};
}

export function newProvider(id: string): ProviderConfig {
	return {
		id,
		name: id,
		baseUrl: '',
		api: 'openai-completions',
		secretId: `vault-librarian-${id}`,
		authHeader: true,
		transport: 'auto',
		compat: {},
		models: [],
		requestDefaults: { ...DEFAULT_REQUEST_DEFAULTS },
	};
}

export function newModel(id: string): ModelConfig {
	return {
		id,
		name: id,
		toolCalling: true,
		reasoning: false,
		input: ['text'],
		contextWindow: 128000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

export const MCP_SERVER_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

export function newMcpServer(name: string): McpServerConfig {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 24);
	const suffix = Math.random().toString(36).slice(2, 6);
	return {
		id: slug ? `${slug}-${suffix}` : `mcp-${suffix}`,
		name,
		url: '',
		auth: 'oauth',
		enabled: true,
		toolHashes: {},
	};
}
