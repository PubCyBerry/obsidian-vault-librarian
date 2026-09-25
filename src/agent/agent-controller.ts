import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ImageContent, TextContent } from '@earendil-works/pi-ai';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import {
	createInitialSystemMessage,
	toToolDeclaration,
} from '@earendil-works/pi-ai/utils/transcript';

import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import type { CompactionResult, ContextManager, ContextUsage } from '../context/context-manager';
import type { ToolPermissionManager } from '../permissions/tool-permission-manager';
import {
	type ActiveSelection,
	effectiveRequestOptions,
	type PiModel,
	type ProviderManager,
	selectableThinkingLevels,
	toPiModel,
} from '../provider/provider-manager';
import type { TransportRouter } from '../provider/transport';
import { contentHash, replay, type SessionManager } from '../session/session-manager';
import type {
	IndexedEvent,
	SessionEvent,
	SessionEventInput,
	SessionMetadata,
	StoredToolCall,
	StoredUsage,
} from '../session/session-types';
import type { SecretStore } from '../storage/secret-store';
import { isAgentsPath, isBinaryPath } from '../tools/path-policy';
import { cutAt } from '../tools/registry';
import type { LibrarianSettings, ThinkingLevel } from '../types';
import {
	appIsHidden,
	noteVisibility,
	releaseVisibilityWaiters,
	wasHiddenSince,
	whenVisible,
} from '../visibility';
import { type AgentDefinition, GENERAL_AGENT, toolsFor } from './agent-definitions';
import { type NestedAgentsMd, neutralizeTags } from './nested-agents-md';
import { type PromptManager, systemPromptOf } from './prompt';
import {
	forkMessages,
	runTitle,
	Slots,
	SPAWN_AGENT_NAME,
	type SpawnArgs,
	type SubagentState,
	subagentSection,
} from './subagent';

export type AgentUiState =
	| 'idle'
	| 'requesting'
	| 'streaming'
	| 'tool-running'
	| 'awaiting-approval'
	| 'compacting'
	| 'error'
	| 'no-key'
	| 'model-unavailable';

/** What a compaction did: replaced the history, found nothing to replace, or failed and left it. */
export type CompactOutcome = 'compacted' | 'nothing' | 'failed';

export type ToolCardStatus =
	| 'pending'
	| 'awaiting-approval'
	| 'running'
	| 'ok'
	| 'failed'
	| 'rejected'
	| 'blocked'
	| 'expired'
	| 'skipped';

/** `skip` withdraws the card because the user sent a message that goes before this call. */
export type ApprovalDecision = 'approve' | 'reject' | 'always' | 'expired' | 'skip';

/** A message sent while a turn runs. `now` puts it before the next tool call (LIB-FEAT-185). */
export interface QueuedMessage {
	id: number;
	text: string;
	images: string[];
	now: boolean;
}

/** The result a call gets when a Send now message goes first. */
export const SKIPPED_RESULT =
	'Skipped: the user sent a new message before this call ran. Read it, then call the tool again only if it still applies.';

export interface ApprovalRequest {
	toolCallId: string;
	name: string;
	args: Record<string, unknown>;
	/** False when settings never let this tool skip approval (destructive MCP tools). */
	canAlways: boolean;
	/** What "Always allow" stores: the tool name, or a skill's key for a read inside a skill folder. */
	permissionKey: string;
	/** For write on an existing note: its current length. */
	existingLength?: number;
	/** The tool this call came from, such as `bash` for something a shell command is about to do. */
	calledFrom?: string;
	/** The sub-agent run asking: its title, its agent and its spawn_agent call. Absent for the main agent. */
	agentTitle?: string;
	agentType?: string;
	agentCallId?: string;
	/** Other approvals queued behind this one. */
	waiting: number;
	resolve: (decision: ApprovalDecision) => void;
}

/** Where a call comes from, for the approval it may need. */
interface CallOrigin {
	calledFrom?: string;
	agent?: SubagentState;
}

/** What ends an agent's loop early: failures by call, turns that called tools, and why it ended. */
interface LoopLimits {
	failures: Map<string, number>;
	iterations: number;
	stopReason: string | null;
	/** Turns with tool calls allowed, when not the setting's: a sub-agent's maxTurns. */
	max?: number;
}

/**
 * A tool-calling model by `<provider id>/<model id>`, or by model ID or name alone. Model IDs may
 * hold a slash themselves, so the provider is only split off when one has that ID.
 */
export function findModel<
	T extends { provider: { id: string }; model: { id: string; name: string } },
>(options: readonly T[], ref: string): T | undefined {
	const slash = ref.indexOf('/');
	if (slash > 0) {
		const [provider, model] = [ref.slice(0, slash), ref.slice(slash + 1)];
		const exact = options.find((o) => o.provider.id === provider && o.model.id === model);
		if (exact) return exact;
	}
	const lower = ref.toLowerCase();
	return options.find(
		(o) => o.model.id.toLowerCase() === lower || o.model.name.toLowerCase() === lower,
	);
}

function freshLimits(): LoopLimits {
	return { failures: new Map(), iterations: 0, stopReason: null };
}

/** The outcome of the permission gate for one call. */
export type Gate = { ok: true } | { ok: false; reason: string; status: ToolCardStatus };

export interface RewindPreview {
	toEventIndex: number;
	turns: number;
	changes: { path: string; toolCallId: string }[];
	userText: string;
}

export interface RewindResult {
	reverted: string[];
	unchanged: { path: string; reason: string }[];
	userText: string;
}

export type ControllerEvent =
	| { type: 'state'; state: AgentUiState }
	| { type: 'session'; session: SessionMetadata | null }
	| { type: 'events'; events: IndexedEvent[] }
	| { type: 'stream'; message: AssistantMessage | null }
	| { type: 'tool-status'; toolCallId: string; status: ToolCardStatus }
	| { type: 'approval'; request: ApprovalRequest | null }
	| { type: 'usage'; usage: ContextUsage | null }
	| { type: 'notice'; message: string }
	| { type: 'error'; message: string }
	| { type: 'queue'; queue: readonly QueuedMessage[] }
	/** Queued messages the run did not send (Stop, an error, a session switch): back to the composer. */
	| { type: 'unsent'; messages: QueuedMessage[] }
	/** A sub-agent of this run started, moved on or ended (LIB-FEAT-140). */
	| { type: 'agent'; agent: SubagentState };

export interface ControllerDeps {
	app: App;
	settings: () => LibrarianSettings;
	saveSettings: () => Promise<void>;
	sessions: SessionManager;
	context: ContextManager;
	permissions: ToolPermissionManager;
	providers: ProviderManager;
	transport: TransportRouter;
	prompt: PromptManager;
	secrets: SecretStore;
	/** Vault tools plus whatever MCP servers currently offer; read fresh on every turn. */
	tools: () => AgentTool[];
	/** The `# Skills` section: listed skills and how to find the deferred ones; empty when none is usable. */
	skillCatalog: () => string;
	/** AGENTS.md files below the vault root and on the storage, delivered as tools reach them. */
	nestedAgentsMd?: NestedAgentsMd;
	/** A sub-agent definition by name, built in or from `.agents/agents` (LIB-FEAT-268). */
	agentDefinition?: (name: string) => AgentDefinition | undefined;
	/** Every registered tool, deferred ones too, for an agent that lists the tools it uses. */
	registeredTools?: () => AgentTool[];
	/** Whether a tool only reads, for an agent that may only read (permissionMode plan). */
	readsOnly?: (name: string) => boolean;
	/** The instructions of a skill an agent preloads, or null when it cannot be used. */
	skillActivation?: (name: string) => Promise<string | null>;
	/** A rewind changed a definition file: read the definitions again. */
	agentDefinitionsChanged?: () => Promise<unknown>;
}

const RETRY_DELAY_MS = 1500;

/**
 * Backstop for a request that keeps failing while the app is sent away and brought back. Each
 * resume needs the app to become visible again, so reaching this means the user retried by hand.
 */
const MAX_BACKGROUND_RESUMES = 10;

/** Device-local: the session whose turn was running, so a killed app can finish it on the next start. */
export const ACTIVE_TURN_KEY = 'librarian-active-turn';

export const BACKGROUND_RESUME_NOTICE =
	'The app was in the background. Continuing where it stopped.';
export const INTERRUPTED_RESUME_NOTICE = 'Continuing the request that was interrupted.';
export const STREAM_CUT_NOTICE = 'The connection dropped mid-response. Retrying once.';

/** The transport's parenthetical for a response the network cut after HTTP 200. */
function isStreamCut(message: string | undefined): boolean {
	return /HTTP 200 received, body cut after/.test(message ?? '');
}

/**
 * An unfinished turn: the last thing in the log is something the model still owes an answer for.
 * Events that carry no conversation (approvals, snapshots, renames) are skipped.
 */
export function hasUnfinishedTurn(events: IndexedEvent[]): boolean {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i]!.event;
		if (e.type === 'user' || e.type === 'tool_result') return true;
		// A response that stopped to call tools is only half a turn; anything else closed it.
		if (e.type === 'assistant') return e.stopReason === 'toolUse';
		if (e.type === 'compaction' || e.type === 'rewind') return false;
	}
	return false;
}

function textOf(content: readonly { type: string }[]): string {
	return content
		.filter((c): c is TextContent => c.type === 'text')
		.map((c) => c.text)
		.join('');
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class AgentController {
	state: AgentUiState = 'idle';
	session: SessionMetadata | null = null;
	events: IndexedEvent[] = [];
	usage: ContextUsage | null = null;
	pendingApproval: ApprovalRequest | null = null;
	/**
	 * One approval card at a time: sub-agents running side by side and the stages of a shell
	 * pipeline can all ask at once, and the rest wait here in order.
	 */
	private approvals: Promise<unknown> = Promise.resolve();
	private approvalsWaiting = 0;
	/** Sub-agents of the latest run, by the spawn_agent call that started each. */
	readonly agents = new Map<string, SubagentState>();
	private readonly agentSlots = new Slots(() => this.deps.settings().maxSubagents);
	/** Which sub-agent made a call, for the approvals its shell commands ask for. */
	private readonly callOwner = new Map<string, SubagentState>();
	/** Provider and model the current session runs on; may differ from the settings default. */
	selection: ActiveSelection | undefined;
	thinkingLevel: ThinkingLevel = 'off';

	private agent: Agent | null = null;
	private readonly listeners = new Set<(event: ControllerEvent) => void>();
	private readonly toolStatus = new Map<string, ToolCardStatus>();
	private readonly truncatedResults = new Set<string>();
	private readonly pendingSnapshots = new Map<string, { path: string; content: string | null }>();
	/** The main agent's limits for the turn now running; each sub-agent keeps its own. */
	private loop = freshLimits();
	/** Set when a response stream was cut by the network; `send` then repeats the request once. */
	private retryAfterCut = false;
	private cutRetries = 0;
	/** Set when a request did not fit the context window; it is asked again once, compacted. */
	private retryAfterOverflow = false;
	private overflowRetries = 0;
	private overflowMessage = '';
	private stopRequested = false;
	/** Set when the request now running failed after the app had been sent to the background. */
	private resumeWhenVisible = false;
	private hiddenDuringRequest = false;
	private backgroundResumes = 0;
	private wakeLock: WakeLockSentinel | null = null;
	/** Messages sent while a turn runs, oldest first. Memory only: they do not survive a restart. */
	queue: QueuedMessage[] = [];
	private queueSeq = 0;
	/** Send now messages handed to Pi for the next request, logged once Pi adds them. */
	private readonly steered = new Map<AgentMessage, QueuedMessage>();
	/** Set while a turn and the queued turns after it run; one run as far as the UI goes. */
	private driving: Promise<void> | null = null;
	/** The last request of the turn failed for good, so the queue goes back to the composer. */
	private runFailed = false;

	constructor(readonly deps: ControllerDeps) {}

	// Running while the app is away

	/** Fed by the plugin from the document's `visibilitychange`. */
	onVisibilityChange(): void {
		noteVisibility();
		if (appIsHidden()) {
			this.hiddenDuringRequest = true;
			// The screen lock is dropped by the browser whenever the page hides; forget ours.
			this.wakeLock = null;
			return;
		}
		void this.acquireWakeLock();
	}

	/** Keeps the screen awake while a turn runs, so the phone does not sleep the app mid-answer. */
	private async acquireWakeLock(): Promise<void> {
		// A desktop window that hides loses its lock without counting as away, so ask again then.
		if (!this.agent || (this.wakeLock && !this.wakeLock.released) || appIsHidden()) return;
		try {
			const lock = await navigator.wakeLock.request('screen');
			// The turn may have ended while the request was in flight.
			if (!this.agent) void lock.release().catch(() => {});
			else this.wakeLock = lock;
		} catch {
			// Older WebViews have no wake lock, and the platform may refuse one. The turn runs anyway.
		}
	}

	private releaseWakeLock(): void {
		const lock = this.wakeLock;
		this.wakeLock = null;
		void lock?.release().catch(() => {});
	}

	subscribe(listener: (event: ControllerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: ControllerEvent) {
		if (event.type === 'state') this.state = event.state;
		for (const l of this.listeners) l(event);
	}

	get isRunning(): boolean {
		return this.driving !== null;
	}

	toolStatusOf(id: string): ToolCardStatus | undefined {
		return this.toolStatus.get(id);
	}

	// Session lifecycle

	private defaultSelection(): ActiveSelection | undefined {
		return this.deps.providers.getActive();
	}

	/** The settings' active model with that provider's default effort, as one unit. */
	private applyDefaultSelection(): void {
		this.selection = this.defaultSelection();
		this.thinkingLevel = this.selection?.provider.requestDefaults.thinkingLevel ?? 'off';
	}

	/** Starts from the settings defaults, or keeps the model and effort picked before any session. */
	async newSession(keepSelection = false): Promise<void> {
		await this.abortAndWait();
		await this.startSession(keepSelection);
	}

	/** Creates the session without stopping anything, so the first send can call it mid-run. */
	private async startSession(keepSelection: boolean): Promise<void> {
		if (!keepSelection || !this.selection) this.applyDefaultSelection();
		this.session = await this.deps.sessions.create({
			providerId: this.selection?.provider.id ?? '',
			modelId: this.selection?.model.id ?? '',
			thinkingLevel: this.thinkingLevel,
		});
		this.toolStatus.clear();
		this.forgetAgents();
		this.deps.nestedAgentsMd?.reset();
		await this.reloadEvents();
		this.emit({ type: 'session', session: this.session });
		await this.refreshReadiness();
	}

	async openSession(id: string): Promise<void> {
		await this.abortAndWait();
		const expired = await this.deps.sessions.expirePendingApprovals(id);
		for (const toolCallId of expired) this.toolStatus.set(toolCallId, 'expired');
		const summary = await this.deps.sessions.summary(id);
		if (!summary) throw new Error(`Session not found: ${id}`);
		this.session = summary;
		this.selection = this.deps.providers.getModel(summary.providerId, summary.modelId);
		if (this.selection && !this.selection.model.toolCalling) this.selection = undefined;
		this.thinkingLevel = summary.thinkingLevel ?? 'off';
		this.forgetAgents();
		// A resumed conversation gets each folder's AGENTS.md again, as it now reads.
		this.deps.nestedAgentsMd?.reset();
		// The card states come from the log before the view draws it; drawn first, every card
		// whose result failed would read Failed instead of Skipped, Rejected or Approval expired.
		this.events = replay(await this.deps.sessions.load(id));
		for (const { event } of this.events) {
			if (event.type === 'tool_result' && !this.toolStatus.has(event.toolCallId)) {
				this.toolStatus.set(
					event.toolCallId,
					event.content === 'Approval expired'
						? 'expired'
						: event.content.includes(SKIPPED_RESULT)
							? 'skipped'
							: event.ok
								? 'ok'
								: 'failed',
				);
			}
			if (event.type === 'approval' && event.decision === 'rejected')
				this.toolStatus.set(event.toolCallId, 'rejected');
		}
		this.emit({ type: 'events', events: this.events });
		this.emit({ type: 'session', session: this.session });
		await this.refreshReadiness();
	}

	async closeSession(): Promise<void> {
		await this.abortAndWait();
		this.session = null;
		this.events = [];
		this.usage = null;
		this.forgetAgents();
		this.deps.nestedAgentsMd?.reset();
		this.emit({ type: 'session', session: null });
		this.emit({ type: 'events', events: [] });
		this.emit({ type: 'usage', usage: null });
	}

	async setModel(
		providerId: string,
		modelId: string,
		thinkingLevel?: ThinkingLevel,
	): Promise<void> {
		const found = this.deps.providers.getModel(providerId, modelId);
		if (!found?.model.toolCalling) return;
		this.selection = found;
		if (thinkingLevel !== undefined) this.thinkingLevel = thinkingLevel;
		const s = this.deps.settings();
		s.activeProviderId = providerId;
		s.activeModelId = modelId;
		await this.deps.saveSettings();
		if (this.session) {
			await this.deps.sessions.recordModelChange(
				this.session.id,
				providerId,
				modelId,
				this.thinkingLevel,
			);
			await this.reloadEvents();
		}
		await this.refreshReadiness();
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.thinkingLevel = level;
		if (this.session && this.selection) {
			await this.deps.sessions.recordModelChange(
				this.session.id,
				this.selection.provider.id,
				this.selection.model.id,
				level,
			);
			await this.reloadEvents();
		}
	}

	/**
	 * Settings from another device replaced this one's: the chat's model is looked up again in
	 * them, so it follows an edit there and goes when it was removed. A running turn keeps its own.
	 */
	reselect(): void {
		if (this.driving) return;
		const wanted = this.selection
			? { providerId: this.selection.provider.id, modelId: this.selection.model.id }
			: this.session;
		if (!wanted) return;
		const found = this.deps.providers.getModel(wanted.providerId, wanted.modelId);
		this.selection = found?.model.toolCalling ? found : undefined;
	}

	/** Recomputes the idle state (key missing, model missing) and the usage indicator. */
	async refreshReadiness(): Promise<void> {
		// Between queued turns too: the Stop button must not flicker off and on.
		if (this.driving) return;
		if (!this.session && !this.selection) this.applyDefaultSelection();
		if (!this.selection) {
			this.emit({ type: 'state', state: 'model-unavailable' });
		} else if (this.deps.secrets.get(this.selection.provider.secretId) === null) {
			this.emit({ type: 'state', state: 'no-key' });
		} else {
			this.emit({ type: 'state', state: 'idle' });
		}
		await this.recalculateUsage();
	}

	async reloadEvents(): Promise<void> {
		if (!this.session) return;
		this.events = replay(await this.deps.sessions.load(this.session.id));
		this.emit({ type: 'events', events: this.events });
	}

	private piModel(): PiModel | undefined {
		return this.selection
			? toPiModel(this.selection.provider, this.selection.model)
			: undefined;
	}

	private exposedTools(): AgentTool[] {
		return this.deps.permissions.getExposedTools(this.deps.tools());
	}

	async systemPrompt(): Promise<string> {
		const s = this.deps.settings();
		const agentsMd = await this.deps.prompt.loadVaultAgentsMd(s.useVaultAgentsMd);
		if (this.deps.prompt.lastStatus === 'error') {
			this.emit({
				type: 'notice',
				message: 'AGENTS.md could not be read. Continuing without it.',
			});
		}
		return this.deps.prompt.buildSystemPrompt({
			systemPrompt: systemPromptOf(s),
			vaultAgentsMd: agentsMd,
			skillCatalog: this.deps.skillCatalog(),
		});
	}

	async recalculateUsage(): Promise<ContextUsage | null> {
		const model = this.piModel();
		if (!model) {
			this.usage = null;
			this.emit({ type: 'usage', usage: null });
			return null;
		}
		this.usage = this.deps.context.usage(this.session ? this.events : [], model);
		this.emit({ type: 'usage', usage: this.usage });
		return this.usage;
	}

	private streamFn(): StreamFn {
		return this.streamFor(this.selection!, () => this.thinkingLevel);
	}

	private streamFor(
		sel: ActiveSelection,
		level: ThinkingLevel | (() => ThinkingLevel),
	): StreamFn {
		return this.deps.transport.createStreamFn(sel.provider, () => ({
			apiKey: this.deps.secrets.get(sel.provider.secretId),
			authHeader: sel.provider.authHeader,
			options: effectiveRequestOptions(
				sel.provider,
				sel.model,
				typeof level === 'function' ? level() : level,
			),
		}));
	}

	// Sending

	/** Sends the message, or queues it while a run is on; the queue follows when the run ends. */
	async send(text: string, images: string[] = []): Promise<void> {
		const message: QueuedMessage = { id: ++this.queueSeq, text, images, now: false };
		if (this.driving) {
			this.queue.push(message);
			this.emitQueue();
			return;
		}
		await this.drive(() => this.sendTurn([message]));
	}

	/**
	 * Finishes a turn that never got its answer, after the app was closed or killed while it ran.
	 * Every completed step is in the session log, so the model picks up from there.
	 */
	async resumeTurn(): Promise<boolean> {
		if (this.driving || !this.session || !this.selection) return false;
		if (this.deps.secrets.get(this.selection.provider.secretId) === null) return false;
		if (!hasUnfinishedTurn(this.events)) return false;
		this.emit({ type: 'notice', message: INTERRUPTED_RESUME_NOTICE });
		await this.drive(async () => {
			await this.runTurn({ start: (agent) => agent.continue() });
			return !this.stopRequested && !this.runFailed;
		});
		return true;
	}

	/** Puts a queued message before the next tool call; a model call waiting for approval yields. */
	sendNow(id: number): void {
		const item = this.queue.find((q) => q.id === id);
		if (!item || item.now) return;
		item.now = true;
		this.emitQueue();
		// A shell command or a sub-agent asking from inside its call has started already, so it
		// keeps its card.
		const card = this.pendingApproval;
		if (card && !card.calledFrom && !card.agentCallId) card.resolve('skip');
	}

	private emitQueue(): void {
		this.emit({ type: 'queue', queue: [...this.queue] });
	}

	/** The Send now messages if there are any, else the oldest message. */
	private takeNext(): QueuedMessage[] {
		const now = this.queue.filter((q) => q.now);
		const taken = now.length ? now : this.queue.slice(0, 1);
		this.queue = this.queue.filter((q) => !taken.includes(q));
		this.emitQueue();
		return taken;
	}

	/**
	 * One run as far as the UI goes: the turn `first` starts, then every queued message as a turn
	 * of its own while the turns end by themselves. Stop, an error or a session switch hands the
	 * rest back to the composer.
	 */
	private async drive(first: () => Promise<boolean>): Promise<void> {
		let finished = () => {};
		this.driving = new Promise<void>((resolve) => {
			finished = resolve;
		});
		this.stopRequested = false;
		// The agents of the run before are in the log now; the chat reads them from there.
		this.forgetAgents();
		try {
			let clean = await first();
			while (clean && this.queue.length) clean = await this.sendTurn(this.takeNext());
		} finally {
			const unsent = this.queue.splice(0);
			this.steered.clear();
			this.driving = null;
			if (unsent.length) {
				this.emitQueue();
				this.emit({ type: 'unsent', messages: unsent });
			}
			await this.refreshReadiness();
			finished();
		}
	}

	/** Sends messages as the next turn. True when the turn ended by itself, so the queue may go on. */
	private async sendTurn(messages: QueuedMessage[]): Promise<boolean> {
		if (!this.stopRequested && !this.session) await this.startSession(/*keepSelection*/ true);
		const provider = this.selection?.provider;
		if (this.stopRequested || !provider || this.deps.secrets.get(provider.secretId) === null) {
			// Not sent: they go back with the rest of the queue, and the state tells why.
			this.queue.unshift(...messages);
			return false;
		}
		for (const { text, images } of messages) {
			await this.deps.sessions.append(this.session!.id, {
				type: 'user',
				content: text,
				images: images.length ? images : undefined,
			});
		}
		await this.reloadEvents();
		const last = messages[messages.length - 1]!;
		const imageContents = await this.imageContents(last.images);
		await this.runTurn({
			excludeLastUser: true,
			start: (agent) => agent.prompt(last.text, imageContents),
		});
		return !this.stopRequested && !this.runFailed;
	}

	/** Takes the Send now messages out of the queue as user messages for the next request. */
	private async takeSteering(): Promise<AgentMessage[]> {
		const now = this.queue.filter((q) => q.now);
		if (!now.length) return [];
		this.queue = this.queue.filter((q) => !q.now);
		this.emitQueue();
		const out: AgentMessage[] = [];
		for (const item of now) {
			const images = await this.imageContents(item.images);
			const message: AgentMessage = {
				role: 'user',
				content: images.length ? [{ type: 'text', text: item.text }, ...images] : item.text,
				timestamp: Date.now(),
			};
			this.steered.set(message, item);
			out.push(message);
		}
		return out;
	}

	private async imageContents(images: string[]): Promise<ImageContent[]> {
		const out: ImageContent[] = [];
		for (const path of images) {
			const file = this.deps.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;
			const bytes = new Uint8Array(await this.deps.app.vault.readBinary(file));
			let binary = '';
			for (let i = 0; i < bytes.length; i += 0x8000)
				binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			const ext = file.extension.toLowerCase();
			out.push({
				type: 'image',
				data: btoa(binary),
				mimeType:
					ext === 'jpg' || ext === 'jpeg'
						? 'image/jpeg'
						: ext === 'gif'
							? 'image/gif'
							: ext === 'webp'
								? 'image/webp'
								: 'image/png',
			});
		}
		return out;
	}

	/**
	 * Runs one turn to its end, repeats included: a stream the network cut is asked again, and a
	 * request that died while the app was away waits for the app to come back before asking again.
	 */
	private async runTurn(opts: {
		excludeLastUser?: boolean;
		start: (agent: Agent) => Promise<void>;
	}): Promise<void> {
		// Stop pressed while a queued message was being logged: that message stays unanswered.
		if (this.stopRequested) return;
		const sessionId = this.session!.id;
		const model = this.piModel()!;
		const streamFn = this.streamFn();
		if (this.deps.context.needsCompaction(this.events, model))
			await this.compactNow(streamFn, { keepLastUser: opts.excludeLastUser });
		const prepared = await this.deps.context.build({
			events: this.events,
			model,
			excludeLastUser: opts.excludeLastUser,
			systemPrompt: await this.systemPrompt(),
			tools: this.exposedTools(),
		});
		this.usage = prepared.usage;
		this.emit({ type: 'usage', usage: this.usage });

		this.loop = freshLimits();
		this.cutRetries = 0;
		this.retryAfterCut = false;
		this.overflowRetries = 0;
		this.retryAfterOverflow = false;
		this.runFailed = false;
		this.resumeWhenVisible = false;
		this.backgroundResumes = 0;
		const createAgent = (messages: AgentMessage[], tools: AgentTool[]) => {
			const agent = new Agent({
				initialState: {
					model,
					thinkingLevel: this.thinkingLevel,
					tools,
					messages,
				},
				streamFn,
				toolExecution: this.deps.settings().toolExecution,
				beforeToolCall: (ctx, signal) =>
					this.beforeToolCall(ctx.toolCall.id, ctx.toolCall.name, ctx.args, signal),
				afterToolCall: (ctx, signal) =>
					this.afterToolCall(
						ctx.toolCall.id,
						ctx.toolCall.name,
						ctx.args,
						ctx.result.content,
						ctx.isError,
						signal,
					),
				finishTurn: (ctx, signal) =>
					signal?.aborted === true || this.shouldStopAfterTurn(ctx.toolResults.length)
						? { action: 'end' }
						: undefined,
				prepareNextTurnWithContext: (ctx, signal) =>
					this.prepareNextTurn(ctx.context.messages, model, streamFn, signal),
			});
			agent.subscribe((event) => this.onAgentEvent(event));
			return agent;
		};
		this.agent = createAgent(prepared.messages, prepared.tools);
		// A phone that kills the app mid-turn leaves this behind, and the next start finishes it.
		this.deps.app.saveLocalStorage(ACTIVE_TURN_KEY, sessionId);
		this.emit({ type: 'state', state: 'requesting' });
		void this.acquireWakeLock();
		try {
			await opts.start(this.agent);
			// The events hold every completed step, so a fresh agent continues from them.
			while (
				!this.stopRequested &&
				(this.resumeWhenVisible || this.retryAfterCut || this.retryAfterOverflow)
			) {
				if (this.resumeWhenVisible) {
					this.resumeWhenVisible = false;
					await whenVisible();
					if (this.stopRequested) break;
					this.emit({ type: 'notice', message: BACKGROUND_RESUME_NOTICE });
				} else if (this.retryAfterOverflow) {
					this.retryAfterOverflow = false;
					// Over the window although the estimate said it fit: compact, then ask again.
					const last = this.events[this.events.length - 1]?.event;
					const compacted = await this.compactNow(streamFn, {
						keepLastUser: last?.type === 'user',
					});
					if (compacted !== 'compacted' || this.stopRequested) {
						await this.failRequest(sessionId, this.overflowMessage);
						break;
					}
				} else {
					this.retryAfterCut = false;
					this.emit({ type: 'notice', message: STREAM_CUT_NOTICE });
					await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAY_MS));
					if (this.stopRequested) break;
				}
				const again = await this.deps.context.build({
					events: this.events,
					model,
					systemPrompt: await this.systemPrompt(),
					tools: this.exposedTools(),
				});
				this.agent = createAgent(again.messages, again.tools);
				this.emit({ type: 'state', state: 'requesting' });
				void this.acquireWakeLock();
				await this.agent.continue();
			}
		} finally {
			this.agent = null;
			this.releaseWakeLock();
			this.deps.app.saveLocalStorage(ACTIVE_TURN_KEY, null);
			this.pendingSnapshots.clear();
			await this.reloadEvents();
			await this.refreshReadiness();
			this.emit({ type: 'stream', message: null });
		}
	}

	stop(): void {
		this.stopRequested = true;
		this.agent?.abort();
		// A turn parked until the app comes back has nothing to abort; wake it so it can end.
		releaseVisibilityWaiters();
		this.pendingApproval?.resolve('expired');
	}

	/** Stops the run and waits until it has handed its queue back. */
	private async abortAndWait(): Promise<void> {
		const driving = this.driving;
		if (!driving) return;
		this.stop();
		await driving;
	}

	/**
	 * Replaces the history so far with a handoff summary (LIB-FEAT-256). Before a turn the message
	 * that starts it stays out of the summary and follows it.
	 */
	async compactNow(
		streamFn?: StreamFn,
		opts: { keepLastUser?: boolean } = {},
	): Promise<CompactOutcome> {
		const model = this.piModel();
		if (!model || !this.session) return 'nothing';
		const previous = this.state;
		this.emit({ type: 'state', state: 'compacting' });
		try {
			let result: CompactionResult | null;
			try {
				result = await this.deps.context.compact(
					this.events,
					model,
					streamFn ?? this.streamFn(),
					{
						systemPrompt: await this.systemPrompt(),
						tools: this.exposedTools(),
						reasoning: this.thinkingLevel === 'off' ? undefined : this.thinkingLevel,
						keepLastUser: opts.keepLastUser,
						signal: this.agent?.signal,
					},
				);
			} catch (error) {
				// The history stays as it was; the next request that needs it tries again.
				if (!this.stopRequested)
					this.emit({
						type: 'notice',
						message: `Could not compact the context: ${rewriteProviderError(messageOf(error))}`,
					});
				return 'failed';
			}
			if (!result) return 'nothing';
			await this.deps.sessions.append(this.session.id, { type: 'compaction', ...result });
			// The summary may have dropped the folders' AGENTS.md; the next visit delivers them again.
			this.deps.nestedAgentsMd?.reset();
			await this.reloadEvents();
			await this.recalculateUsage();
			return 'compacted';
		} finally {
			if (!this.agent) await this.refreshReadiness();
			else
				this.emit({
					type: 'state',
					state: previous === 'compacting' ? 'requesting' : previous,
				});
		}
	}

	/** The request failed for good: the error goes in the log and on screen, and the run ends. */
	private async failRequest(sessionId: string, message: string): Promise<void> {
		this.runFailed = true;
		await this.deps.sessions.append(sessionId, { type: 'error', stage: 'provider', message });
		this.emit({ type: 'error', message: rewriteProviderError(message) });
	}

	// Pi hooks

	private async beforeToolCall(
		toolCallId: string,
		name: string,
		args: unknown,
		signal?: AbortSignal,
	) {
		// Checked before every call: a Send now message goes ahead of anything not started yet.
		if (this.queue.some((q) => q.now)) {
			this.setToolStatus(toolCallId, 'skipped');
			return { block: true, reason: SKIPPED_RESULT };
		}
		if (!this.deps.tools().some((t) => t.name === name))
			return { block: true, reason: `Tool ${name} not found` };
		const gate = await this.authorize(toolCallId, name, args, signal, (status) =>
			this.setToolStatus(toolCallId, status),
		);
		if (!gate.ok) {
			this.setToolStatus(toolCallId, gate.status);
			return { block: true, reason: gate.reason };
		}
		this.setToolStatus(toolCallId, 'running');
		return undefined;
	}

	/**
	 * Permission and approval for a note a shell command is about to change, judged as a `write`.
	 * Requests and Obsidian commands do not come here: approving the `bash` call covered them. It
	 * leaves the same approval events as a call from the model, but no conversation events: the
	 * answer goes back to the shell, not into the model's context.
	 */
	async gateShellAction(
		callId: string,
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onWaiting: (waiting: boolean) => void = () => {},
		bashCallId?: string,
	): Promise<Gate> {
		let waited = false;
		try {
			return await this.authorize(
				callId,
				name,
				args,
				signal,
				(status) => {
					if (status !== 'awaiting-approval') return;
					waited = true;
					onWaiting(true);
				},
				{
					calledFrom: 'bash',
					agent: bashCallId ? this.callOwner.get(bashCallId) : undefined,
				},
			);
		} finally {
			if (waited) {
				onWaiting(false);
				if (this.agent) this.emit({ type: 'state', state: 'tool-running' });
			}
		}
	}

	/** Permission, approval and the executable check for one call, from the model or the shell. */
	private async authorize(
		toolCallId: string,
		name: string,
		args: unknown,
		signal: AbortSignal | undefined,
		onStatus: (status: ToolCardStatus) => void,
		origin: CallOrigin = {},
	): Promise<Gate> {
		const perms = this.deps.permissions;
		const permission = perms.resolve(name, args);
		if (permission === 'blocked')
			return { ok: false, reason: 'Tool blocked by settings', status: 'blocked' };
		const record = (args ?? {}) as Record<string, unknown>;
		if (permission === 'approval_required') {
			onStatus('awaiting-approval');
			const decision = await this.askApproval(toolCallId, name, record, signal, origin);
			// Not an answer to the card: the call yields to a Send now message, so nothing is logged.
			if (decision === 'skip')
				return { ok: false, reason: SKIPPED_RESULT, status: 'skipped' };
			// While it waited in line, an earlier card made it Always allow: it goes without a card
			// and without an approval to log, as an allowed call does.
			if (decision !== 'allowed') {
				const approval: SessionEventInput = {
					type: 'approval',
					toolCallId,
					name,
					decision:
						decision === 'reject'
							? 'rejected'
							: decision === 'expired'
								? 'expired'
								: 'approved',
				};
				if (origin.agent) await this.logAgent(origin.agent, approval);
				else if (this.session) await this.deps.sessions.append(this.session.id, approval);
			}
			if (decision === 'reject')
				return {
					ok: false,
					reason: 'The user rejected this tool call. Ask before retrying or choose another approach.',
					status: 'rejected',
				};
			if (decision === 'expired')
				return { ok: false, reason: 'Approval expired', status: 'expired' };
			// askApproval has stored it already, before the next card in line was judged.
			if (decision === 'always')
				this.emit({
					type: 'notice',
					message: `${perms.permissionKey(name, args)} is now always allowed. Change it in Settings.`,
				});
		}
		try {
			perms.assertExecutable(name);
		} catch (error) {
			return { ok: false, reason: messageOf(error), status: 'blocked' };
		}
		return { ok: true };
	}

	/**
	 * Waits for its turn, then shows the card. By then the call may have been stopped, or an
	 * earlier card may have made its key Always allow; either way no card is shown.
	 */
	private askApproval(
		toolCallId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
		origin: CallOrigin,
	): Promise<ApprovalDecision | 'allowed'> {
		this.approvalsWaiting++;
		const card = this.pendingApproval;
		if (card) {
			card.waiting = this.approvalsWaiting;
			this.emit({ type: 'approval', request: card });
		}
		const perms = this.deps.permissions;
		const turn = this.approvals.then(async () => {
			this.approvalsWaiting--;
			if (signal?.aborted) return 'expired' as const;
			if (perms.resolve(name, args) !== 'approval_required') return 'allowed' as const;
			const decision = await this.showApproval(toolCallId, name, args, signal, origin);
			// Stored before the line moves on, so a card behind it for the same key is not shown.
			if (decision === 'always')
				await perms.setTool(perms.permissionKey(name, args), 'always_allow');
			return decision;
		});
		this.approvals = turn.catch(() => undefined);
		return turn;
	}

	private showApproval(
		toolCallId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
		{ calledFrom, agent }: CallOrigin,
	) {
		return new Promise<ApprovalDecision>((resolve) => {
			const finish = (decision: ApprovalDecision) => {
				if (this.pendingApproval?.toolCallId !== toolCallId) return;
				this.pendingApproval = null;
				signal?.removeEventListener('abort', onAbort);
				this.emit({ type: 'approval', request: null });
				resolve(decision);
			};
			const onAbort = () => finish('expired');
			if (signal?.aborted) {
				resolve('expired');
				return;
			}
			signal?.addEventListener('abort', onAbort);
			const existing =
				name === 'write' && typeof args.path === 'string'
					? this.deps.app.vault.getFileByPath(args.path)
					: null;
			const key = this.deps.permissions.permissionKey(name, args);
			this.pendingApproval = {
				toolCallId,
				name,
				args,
				canAlways:
					this.deps.permissions.canAlwaysAllow(name) &&
					this.deps.permissions.canAlwaysAllow(key),
				permissionKey: key,
				existingLength: existing?.stat.size,
				...(calledFrom ? { calledFrom } : {}),
				...(agent
					? { agentTitle: agent.title, agentType: agent.agent, agentCallId: agent.callId }
					: {}),
				waiting: this.approvalsWaiting,
				resolve: finish,
			};
			this.emit({ type: 'state', state: 'awaiting-approval' });
			this.emit({ type: 'approval', request: this.pendingApproval });
		});
	}

	private async afterToolCall(
		toolCallId: string,
		name: string,
		args: unknown,
		content: readonly { type: string }[],
		isError: boolean,
		signal?: AbortSignal,
		limits = this.loop,
		nested = this.deps.nestedAgentsMd,
	) {
		// Only Librarian writes the AGENTS.md tag; one inside a note or a page must not pass for it.
		let text = neutralizeTags(textOf(content));
		if (isError && !text.startsWith('Error:')) text = `Error: ${text}`;
		const max = this.deps.settings().toolResultMaxChars;
		if (text.length > max) {
			// The vault tools fit their own results; this is for the rest, such as MCP tools.
			const kept = cutAt(text, max);
			text = `${kept}\n[truncated ${text.length - kept.length} characters; narrow the request to see more]`;
			this.truncatedResults.add(toolCallId);
		}
		// Appended after the cut, so a long result never pushes the folder's rules out.
		if (this.deps.settings().useVaultAgentsMd && nested)
			text += await nested.blockFor(name, args, signal);
		const key = `${name}:${JSON.stringify(args ?? {})}`;
		if (isError) limits.failures.set(key, (limits.failures.get(key) ?? 0) + 1);
		else limits.failures.delete(key);

		this.pendingSnapshots.delete(toolCallId);
		return { content: [{ type: 'text' as const, text }], isError };
	}

	// Rewind snapshots. Both run inside the tool's per-file mutation queue, so a parallel batch
	// cannot read a note between another call's snapshot and its change.

	/**
	 * A file as snapshots and rewind see it: through the vault index, or through the adapter for a
	 * sub-agent definition, which the index does not hold (LIB-FEAT-268). Null when there is none.
	 */
	private async noteAt(path: string): Promise<{
		path: string;
		read(): Promise<string>;
		trash(): Promise<void>;
		/** Puts `previous` back unless the file changed since `afterHash`; false when it had. */
		replace(previous: string, afterHash: string): Promise<boolean>;
	} | null> {
		const { vault, fileManager } = this.deps.app;
		const file = vault.getFileByPath(path);
		if (file)
			return {
				path: file.path,
				read: () => vault.read(file),
				trash: () => fileManager.trashFile(file),
				replace: async (previous, afterHash) => {
					let applied = false;
					await vault.process(file, (data) => {
						if (contentHash(data) !== afterHash) return data;
						applied = true;
						return previous;
					});
					return applied;
				},
			};
		const adapter = vault.adapter;
		if (!isAgentsPath(path) || (await adapter.stat(path))?.type !== 'file') return null;
		return {
			path,
			read: () => adapter.read(path),
			trash: async () => {
				if (!(await adapter.trashSystem(path))) await adapter.trashLocal(path);
			},
			// ponytail: read then write, not one step like Vault.process; fine for a definition file.
			replace: async (previous, afterHash) => {
				if (contentHash(await adapter.read(path)) !== afterHash) return false;
				await adapter.write(path, previous);
				return true;
			},
		};
	}

	async beforeMutation(toolCallId: string, path: string): Promise<void> {
		const note = await this.noteAt(path);
		const content = note ? await note.read() : null;
		this.pendingSnapshots.set(toolCallId, { path: note?.path ?? path, content });
	}

	async afterMutation(toolCallId: string, path: string): Promise<void> {
		const snapshot = this.pendingSnapshots.get(toolCallId);
		this.pendingSnapshots.delete(toolCallId);
		const file = await this.noteAt(path);
		if (!snapshot || !file || !this.session) return;
		const after = await file.read();
		const index = this.events.length ? this.events[this.events.length - 1]!.index + 1 : 0;
		const ref =
			snapshot.content === null
				? null
				: await this.deps.sessions.writeSnapshot(
						this.session.id,
						index,
						snapshot.path,
						snapshot.content,
					);
		await this.deps.sessions.append(this.session.id, {
			type: 'snapshot',
			toolCallId,
			path: file.path,
			ref,
			afterHash: contentHash(after),
		});
	}

	/** `forUser` says how to go on, which only the main agent's user can do. */
	private shouldStopAfterTurn(toolResultCount: number, limits = this.loop, forUser = true) {
		if (toolResultCount === 0) return false;
		limits.iterations++;
		const limit = this.deps.settings().repeatedFailureLimit;
		for (const [, count] of limits.failures) {
			if (count >= limit) {
				limits.stopReason = `Stopped: the same tool call failed ${count} times`;
				return true;
			}
		}
		// 0 is no limit: the failure limit above and Stop are what end a long run then.
		const max = limits.max ?? this.deps.settings().maxIterations;
		if (max > 0 && limits.iterations >= max) {
			limits.stopReason = `Stopped after ${limits.iterations} tool iterations${forUser ? '. Send a message to continue.' : ''}`;
			return true;
		}
		return false;
	}

	// Sub-agents (LIB-FEAT-139)

	private forgetAgents(): void {
		this.agents.clear();
		this.callOwner.clear();
	}

	private emitAgent(state: SubagentState): void {
		this.emit({ type: 'agent', agent: state });
	}

	/** One event of a sub-agent: into its session file, and into what the chat draws it from. */
	private async logAgent(state: SubagentState, event: SessionEventInput): Promise<void> {
		if (state.sessionId) await this.deps.sessions.append(state.sessionId, event);
		const stored: SessionEvent = { t: new Date().toISOString(), ...event };
		state.events.push({ index: state.events.length, event: stored });
		this.emitAgent(state);
	}

	/**
	 * The agent a spawn_agent call starts, which its permission is judged by: the one it names, or
	 * the one of the run it resumes, as this conversation's log recorded it.
	 */
	agentOfCall(args: unknown): string {
		const a = (args ?? {}) as { agent?: unknown; resume?: unknown };
		const resume = typeof a.resume === 'string' ? a.resume.trim() : '';
		if (!resume)
			return typeof a.agent === 'string' && a.agent.trim() ? a.agent.trim() : GENERAL_AGENT;
		for (const run of this.agents.values()) if (run.sessionId === resume) return run.agent;
		const result = this.events.find(
			(e) => e.event.type === 'tool_result' && e.event.agentSession === resume,
		)?.event as { toolCallId: string } | undefined;
		const call = this.events.find(
			(e) => e.event.type === 'tool_call' && e.event.toolCallId === result?.toolCallId,
		)?.event as { args?: { agent?: unknown } } | undefined;
		const agent = call?.args?.agent;
		return typeof agent === 'string' && agent.trim() ? agent.trim() : GENERAL_AGENT;
	}

	/**
	 * spawn_agent: runs one sub-agent to its end and returns its last message (LIB-FEAT-139). It
	 * runs as its definition says (LIB-FEAT-268), under the user's permissions, with its own loop
	 * limits, AGENTS.md deliveries and session; `resume` goes on in the session of an earlier run
	 * of this conversation. Past `maxSubagents` it waits for a place.
	 */
	async runSubagent(
		callId: string,
		args: SpawnArgs,
		signal?: AbortSignal,
	): Promise<{ text: string; sessionId: string | null }> {
		if (!this.selection || !this.session) throw new Error('No model is selected.');
		const task = typeof args.task === 'string' ? args.task.trim() : '';
		if (!task) throw new Error('task must not be empty');
		const type = this.agentOfCall(args);
		const def = this.deps.agentDefinition?.(type);
		if (!def)
			throw new Error(
				`No agent named ${type}. Start one that the spawn_agent description lists.`,
			);
		const resume =
			typeof args.resume === 'string' && args.resume.trim() ? args.resume.trim() : null;
		if (resume) await this.checkResume(resume);
		const state: SubagentState = {
			callId,
			title: runTitle(args.title, def.name),
			agent: def.name,
			...(def.color ? { color: def.color } : {}),
			task,
			status: 'waiting',
			events: [],
			stream: null,
			toolStatus: new Map(),
			sessionId: resume,
		};
		this.agents.set(callId, state);
		this.emitAgent(state);
		try {
			await this.agentSlots.take(signal);
		} catch (error) {
			state.status = 'failed';
			this.emitAgent(state);
			throw error;
		}
		try {
			return await this.driveSubagent(state, def, args.fork_context === true, signal);
		} catch (error) {
			state.status = 'failed';
			const message = signal?.aborted
				? 'Operation aborted'
				: rewriteProviderError(messageOf(error));
			await this.logAgent(state, { type: 'error', stage: 'provider', message });
			throw new Error(message);
		} finally {
			state.stream = null;
			this.agentSlots.release();
			this.emitAgent(state);
		}
	}

	/** Only an agent this conversation started, and not while that agent is still at work. */
	private async checkResume(id: string): Promise<void> {
		const summary = await this.deps.sessions.summary(id);
		if (!summary?.parentId || summary.parentId !== this.session?.id)
			throw new Error(`No agent with agent_id ${id} in this conversation.`);
		for (const run of this.agents.values())
			if (run.sessionId === id && (run.status === 'waiting' || run.status === 'running'))
				throw new Error(`The agent ${id} is still working. Wait for its answer first.`);
	}

	/** The model an agent runs on and its thinking level: its definition's, else the main ones. */
	private agentModel(def: AgentDefinition): { selection: ActiveSelection; level: ThinkingLevel } {
		// A model Settings lacks falls back to the main one, as the definition's scan warned.
		const selection =
			(def.model && findModel(this.deps.providers.listSelectable(), def.model)) ||
			this.selection!;
		if (this.deps.secrets.get(selection.provider.secretId) === null)
			throw new Error(`No API key for ${selection.provider.name} on this device.`);
		const levels = selectableThinkingLevels(selection.model);
		const level =
			[def.effort, this.thinkingLevel].find((l) => l && levels.includes(l)) ?? 'off';
		return { selection, level };
	}

	/**
	 * An agent's instructions: its own or the Custom system prompt, the vault root AGENTS.md, the
	 * skills when it can read them, the skills it preloads, and what a sub-agent is.
	 */
	private async agentPrompt(
		def: AgentDefinition,
		title: string,
		tools: AgentTool[],
	): Promise<string> {
		const s = this.deps.settings();
		const parts = [
			this.deps.prompt.buildSystemPrompt({
				systemPrompt: def.prompt ?? systemPromptOf(s),
				vaultAgentsMd: await this.deps.prompt.loadVaultAgentsMd(s.useVaultAgentsMd),
				skillCatalog: tools.some((t) => t.name === 'read') ? this.deps.skillCatalog() : '',
			}),
		];
		const preloaded: string[] = [];
		for (const name of def.skills ?? []) {
			const text = await this.deps.skillActivation?.(name);
			if (text) preloaded.push(text);
		}
		if (preloaded.length) parts.push(`# Preloaded skills\n\n${preloaded.join('\n\n')}`);
		parts.push(subagentSection(title, def.name));
		return parts.join('\n\n');
	}

	private async driveSubagent(
		state: SubagentState,
		def: AgentDefinition,
		fork: boolean,
		signal?: AbortSignal,
	): Promise<{ text: string; sessionId: string | null }> {
		const { selection, level } = this.agentModel(def);
		const model = toPiModel(selection.provider, selection.model);
		// A resumed agent goes on from its own log, which the chat shows whole.
		const prior = state.sessionId
			? replay(await this.deps.sessions.load(state.sessionId)).filter(
					(e) => e.event.type !== 'meta',
				)
			: [];
		state.events = [...prior];
		if (!state.sessionId) {
			const session = await this.deps.sessions.create({
				providerId: selection.provider.id,
				modelId: selection.model.id,
				thinkingLevel: level,
				parentId: this.session!.id,
				parentCallId: state.callId,
				agentType: def.name,
				agentTitle: state.title,
			});
			state.sessionId = session.id;
		}
		const sessionId = state.sessionId;
		state.status = 'running';
		await this.logAgent(state, { type: 'user', content: state.task });
		// Its definition's tools, bar spawn_agent: one level of agents only. A tool it may not
		// have is not in its list, so the model never sees it.
		const tools = () =>
			toolsFor(
				def,
				this.exposedTools(),
				this.deps.permissions.getExposedTools(
					this.deps.registeredTools?.() ?? this.deps.tools(),
				),
				this.deps.readsOnly ?? (() => false),
			).filter((t) => t.name !== SPAWN_AGENT_NAME);
		const prompt = await this.agentPrompt(def, state.title, tools());
		const leading = createInitialSystemMessage(prompt, tools().map(toToolDeclaration));
		const history = prior.length
			? await this.deps.context.project({ events: prior, model })
			: fork
				? forkMessages(this.agent?.state.messages ?? [])
				: [];
		const limits: LoopLimits = { ...freshLimits(), max: def.maxTurns };
		const nested = this.deps.nestedAgentsMd?.fork(fork);
		let requestStart = Date.now();
		const agent = new Agent({
			initialState: {
				model,
				thinkingLevel: level,
				tools: tools(),
				messages: leading ? [leading, ...history] : history,
			},
			streamFn: this.streamFor(selection, level),
			toolExecution: this.deps.settings().toolExecution,
			beforeToolCall: (ctx, sig) =>
				this.beforeAgentToolCall(
					state,
					def,
					ctx.toolCall.id,
					ctx.toolCall.name,
					ctx.args,
					sig,
				),
			afterToolCall: (ctx, sig) =>
				this.afterToolCall(
					ctx.toolCall.id,
					ctx.toolCall.name,
					ctx.args,
					ctx.result.content,
					ctx.isError,
					sig,
					limits,
					nested,
				),
			// No compaction here: an agent whose context fills up stops and answers with the rest.
			finishTurn: (ctx, sig) =>
				sig?.aborted === true ||
				this.shouldStopAfterTurn(ctx.toolResults.length, limits, false) ||
				(ctx.toolResults.length > 0 && this.agentContextFull(ctx.message, model, limits))
					? { action: 'end' }
					: undefined,
			prepareNextTurnWithContext: (ctx) => ({
				context: { messages: ctx.context.messages, tools: tools() },
			}),
		});
		agent.subscribe(async (event) => {
			if (event.type === 'turn_start') requestStart = Date.now();
			else if (
				(event.type === 'message_start' || event.type === 'message_update') &&
				event.message.role === 'assistant'
			) {
				state.stream = event.message;
				this.emitAgent(state);
			} else if (event.type === 'message_end')
				await this.logAgentMessage(state, event.message);
		});
		const onAbort = () => agent.abort();
		signal?.addEventListener('abort', onAbort);
		try {
			// Stop may have come while the agent was being set up, before anyone listened.
			if (signal?.aborted) throw new Error('Operation aborted');
			await agent.prompt(state.task);
			// A request that died while the app was away, or whose stream the network cut, is asked
			// again as the main agent's would be.
			let resumes = 0;
			let cutRetries = 0;
			for (;;) {
				const last = agent.state.messages[agent.state.messages.length - 1];
				if (signal?.aborted || last?.role !== 'assistant' || last.stopReason !== 'error')
					break;
				if (wasHiddenSince(requestStart) && resumes < MAX_BACKGROUND_RESUMES) {
					resumes++;
					await whenVisible(signal);
				} else if (isStreamCut(last.errorMessage) && cutRetries < 1) {
					cutRetries++;
					await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAY_MS));
				} else break;
				if (signal?.aborted) break;
				agent.state.messages = agent.state.messages.slice(0, -1);
				await agent.continue();
			}
		} finally {
			signal?.removeEventListener('abort', onAbort);
		}
		if (signal?.aborted) throw new Error('Operation aborted');
		const last = [...agent.state.messages]
			.reverse()
			.find((m): m is AssistantMessage => m.role === 'assistant');
		if (last?.stopReason === 'error') throw new Error(last.errorMessage ?? 'Request failed');
		const text = textOf(last?.content ?? []).trim();
		if (limits.stopReason) {
			state.status = 'stopped';
			await this.logAgent(state, {
				type: 'error',
				stage: 'tool',
				message: limits.stopReason,
			});
			return {
				text: `${text || 'The agent stopped before it wrote an answer.'}\n\n[${limits.stopReason}]`,
				sessionId,
			};
		}
		state.status = 'done';
		return { text: text || 'The agent finished without an answer.', sessionId };
	}

	/**
	 * A sub-agent's call: the user's permission for it, and an approval card that says who asks.
	 * An agent defined with permissionMode dontAsk is refused instead of asking.
	 */
	private async beforeAgentToolCall(
		state: SubagentState,
		def: AgentDefinition,
		toolCallId: string,
		name: string,
		args: unknown,
		signal?: AbortSignal,
	) {
		this.callOwner.set(toolCallId, state);
		const set = (status: ToolCardStatus) => {
			state.toolStatus.set(toolCallId, status);
			this.emitAgent(state);
		};
		if (
			def.permissionMode === 'dontAsk' &&
			this.deps.permissions.resolve(name, args) === 'approval_required'
		) {
			set('rejected');
			return {
				block: true,
				reason: `The ${def.name} agent may not ask for approval, and this call needs it. Do the task without it.`,
			};
		}
		const gate = await this.authorize(toolCallId, name, args, signal, set, { agent: state });
		// The main agent is still running its tools, whatever the card that came and went.
		if (this.agent && !this.pendingApproval)
			this.emit({ type: 'state', state: 'tool-running' });
		if (!gate.ok) {
			set(gate.status);
			return { block: true, reason: gate.reason };
		}
		set('running');
		return undefined;
	}

	/** The context is as full as the main agent's would be before it compacted. */
	private agentContextFull(message: AssistantMessage, model: PiModel, limits: LoopLimits) {
		const u = message.usage;
		const used = u.totalTokens || u.input + u.cacheRead + u.output;
		if (this.deps.context.usageFor(used, model).state !== 'critical') return false;
		limits.stopReason = 'Stopped: the context of this agent is full';
		return true;
	}

	private async logAgentMessage(state: SubagentState, m: AgentMessage): Promise<void> {
		if (m.role === 'assistant') {
			state.stream = null;
			// A failed response is asked again or ends the agent; runSubagent logs why.
			if (m.stopReason === 'error') {
				this.emitAgent(state);
				return;
			}
			const entry = assistantEvent(m);
			await this.logAgent(state, entry);
			for (const call of entry.toolCalls) {
				if (!state.toolStatus.has(call.id)) state.toolStatus.set(call.id, 'pending');
				await this.logAgent(state, {
					type: 'tool_call',
					toolCallId: call.id,
					name: call.name,
					args: call.args,
				});
			}
		} else if (m.role === 'toolResult') {
			const current = state.toolStatus.get(m.toolCallId);
			if (!current || ['pending', 'running', 'awaiting-approval'].includes(current))
				state.toolStatus.set(m.toolCallId, m.isError ? 'failed' : 'ok');
			await this.logAgent(state, {
				type: 'tool_result',
				toolCallId: m.toolCallId,
				name: m.toolName,
				ok: !m.isError,
				content: withErrorPrefix(textOf(m.content), m.isError),
				truncated: this.truncatedResults.delete(m.toolCallId),
			});
		}
	}

	private async prepareNextTurn(
		current: AgentMessage[],
		model: PiModel,
		streamFn: StreamFn,
		signal?: AbortSignal,
	) {
		const tools = this.exposedTools();
		const prompt = await this.systemPrompt();
		let messages = current;
		if (!signal?.aborted && this.deps.context.needsCompaction(this.events, model)) {
			const compacted = await this.compactNow(streamFn);
			if (compacted === 'compacted') {
				const prepared = await this.deps.context.build({
					events: this.events,
					model,
					systemPrompt: prompt,
					tools,
				});
				messages = prepared.messages;
			}
		}
		// Send now messages go in right after this response's tool results, before the next request.
		const steering = signal?.aborted ? [] : await this.takeSteering();
		return { context: { messages, tools }, messages: steering };
	}

	// Agent events -> session log and UI

	private setToolStatus(toolCallId: string, status: ToolCardStatus) {
		this.toolStatus.set(toolCallId, status);
		this.emit({ type: 'tool-status', toolCallId, status });
		if (status === 'running') this.emit({ type: 'state', state: 'tool-running' });
	}

	private async onAgentEvent(event: Parameters<Parameters<Agent['subscribe']>[0]>[0]) {
		const sessionId = this.session?.id;
		if (!sessionId) return;
		switch (event.type) {
			case 'agent_start':
				this.emit({ type: 'state', state: 'requesting' });
				break;
			case 'turn_start':
				// Each request tracks its own backgrounding, so only the one that was away resumes.
				this.hiddenDuringRequest = appIsHidden();
				this.emit({ type: 'state', state: 'requesting' });
				break;
			case 'message_start':
			case 'message_update':
				if (event.message.role === 'assistant') {
					if (this.state !== 'streaming')
						this.emit({ type: 'state', state: 'streaming' });
					this.emit({ type: 'stream', message: event.message });
				}
				break;
			case 'message_end': {
				const m = event.message;
				if (m.role === 'assistant') {
					this.emit({ type: 'stream', message: null });
					// A response that did not arrive is not kept: runTurn asks the model again.
					// Being sent to the background takes priority, because a phone freezes the
					// connection there and the request would fail again right away.
					if (m.stopReason === 'error') {
						if (
							this.hiddenDuringRequest &&
							this.backgroundResumes < MAX_BACKGROUND_RESUMES
						) {
							this.backgroundResumes++;
							this.resumeWhenVisible = true;
							break;
						}
						if (isStreamCut(m.errorMessage) && this.cutRetries < 1) {
							this.cutRetries++;
							this.retryAfterCut = true;
							break;
						}
						if (
							isContextOverflow(m, this.selection?.model.contextWindow) &&
							this.overflowRetries < 1
						) {
							this.overflowRetries++;
							this.overflowMessage = m.errorMessage ?? 'Context window exceeded';
							this.retryAfterOverflow = true;
							break;
						}
					} else this.overflowRetries = 0;
					const entry = assistantEvent(m);
					const toolCalls = entry.toolCalls;
					await this.deps.sessions.append(sessionId, entry);
					for (const call of toolCalls) {
						await this.deps.sessions.append(sessionId, {
							type: 'tool_call',
							toolCallId: call.id,
							name: call.name,
							args: call.args,
						});
						if (!this.toolStatus.has(call.id)) this.toolStatus.set(call.id, 'pending');
					}
					if (m.stopReason === 'error')
						await this.failRequest(sessionId, m.errorMessage ?? 'Request failed');
					if (m.stopReason === 'length' && toolCalls.length > 0) {
						this.emit({
							type: 'notice',
							message: 'Tool call was cut off by the output limit and was not run.',
						});
					}
					await this.reloadEvents();
					// The ring shows what the provider reported for this response, updated as each stream ends.
					await this.recalculateUsage();
				} else if (m.role === 'toolResult') {
					const agentSession = (m.details as { agentSession?: unknown } | undefined)
						?.agentSession;
					await this.deps.sessions.append(sessionId, {
						type: 'tool_result',
						toolCallId: m.toolCallId,
						name: m.toolName,
						ok: !m.isError,
						content: withErrorPrefix(textOf(m.content), m.isError),
						truncated: this.truncatedResults.delete(m.toolCallId),
						...(typeof agentSession === 'string' ? { agentSession } : {}),
					});
					const current = this.toolStatus.get(m.toolCallId);
					if (
						!current ||
						current === 'pending' ||
						current === 'running' ||
						current === 'awaiting-approval'
					) {
						this.setToolStatus(m.toolCallId, m.isError ? 'failed' : 'ok');
					}
					await this.reloadEvents();
				} else if (m.role === 'user') {
					// Pi just added a Send now message; the prompt that started the turn is logged by send.
					const item = this.steered.get(m);
					if (item) {
						this.steered.delete(m);
						await this.deps.sessions.append(sessionId, {
							type: 'user',
							content: item.text,
							images: item.images.length ? item.images : undefined,
						});
						await this.reloadEvents();
					}
				}
				break;
			}
			case 'tool_execution_start':
				if (!this.toolStatus.has(event.toolCallId))
					this.toolStatus.set(event.toolCallId, 'pending');
				break;
			case 'turn_end':
				await this.recalculateUsage();
				break;
			case 'agent_end':
				if (this.loop.stopReason) {
					await this.deps.sessions.append(sessionId, {
						type: 'error',
						stage: 'tool',
						message: this.loop.stopReason,
					});
					this.emit({ type: 'notice', message: this.loop.stopReason });
					this.loop.stopReason = null;
					await this.reloadEvents();
				}
				break;
		}
	}

	// Rewind

	previewRewind(toEventIndex: number): RewindPreview | null {
		const target = this.events.find((e) => e.index === toEventIndex);
		if (target?.event.type !== 'user') return null;
		const after = this.events.filter((e) => e.index >= toEventIndex);
		const turns = after.filter((e) => e.event.type === 'user').length;
		const changes = after
			.filter(
				(e): e is IndexedEvent & { event: Extract<SessionEvent, { type: 'snapshot' }> } =>
					e.event.type === 'snapshot',
			)
			.map((e) => ({ path: e.event.path, toolCallId: e.event.toolCallId }));
		return { toEventIndex, turns, changes, userText: target.event.content };
	}

	async rewind(toEventIndex: number): Promise<RewindResult | null> {
		const preview = this.previewRewind(toEventIndex);
		if (!preview || !this.session) return null;
		await this.abortAndWait();
		const sessionId = this.session.id;
		const snapshots = this.events
			.filter(
				(e): e is IndexedEvent & { event: Extract<SessionEvent, { type: 'snapshot' }> } =>
					e.event.type === 'snapshot' && e.index >= toEventIndex,
			)
			.reverse();
		const reverted: string[] = [];
		const unchanged: { path: string; reason: string }[] = [];
		for (const { event } of snapshots) {
			const file = await this.noteAt(event.path);
			if (!file) {
				if (event.ref !== null)
					unchanged.push({ path: event.path, reason: 'The note no longer exists.' });
				continue;
			}
			const current = await file.read();
			if (contentHash(current) !== event.afterHash) {
				unchanged.push({
					path: event.path,
					reason: 'The note was edited after the agent changed it.',
				});
				continue;
			}
			if (event.ref === null) {
				await file.trash();
				reverted.push(event.path);
				continue;
			}
			// Snapshots are text, so a picture the shell overwrote would come back with other bytes.
			if (isBinaryPath(event.path)) {
				unchanged.push({
					path: event.path,
					reason: 'Rewind does not restore binary files.',
				});
				continue;
			}
			const previous = await this.deps.sessions.readSnapshot(sessionId, event.ref);
			if (previous === null) {
				unchanged.push({ path: event.path, reason: 'The snapshot is missing.' });
				continue;
			}
			if (await file.replace(previous, event.afterHash)) {
				reverted.push(event.path);
				await this.deps.sessions.deleteSnapshot(sessionId, event.ref);
			} else {
				unchanged.push({
					path: event.path,
					reason: 'The note was edited after the agent changed it.',
				});
			}
		}
		await this.deps.sessions.append(sessionId, { type: 'rewind', toEventIndex });
		await this.reloadEvents();
		await this.recalculateUsage();
		// A definition the rewind put back or removed changes the agents that can be started.
		if (reverted.some((p) => isAgentsPath(p))) await this.deps.agentDefinitionsChanged?.();
		return { reverted, unchanged, userText: preview.userText };
	}

	/** Text the agent actually read at a line, from the most recent `read` result for that note. */
	findReadLine(path: string, line: number): string | null {
		for (let i = this.events.length - 1; i >= 0; i--) {
			const e = this.events[i]!.event;
			if (e.type !== 'tool_result' || e.name !== 'read' || !e.ok) continue;
			try {
				const parsed = JSON.parse(e.content) as {
					path?: string;
					lines?: { line: number; text: string }[];
				};
				if (parsed.path !== path) continue;
				const hit = parsed.lines?.find((l) => l.line === line);
				if (hit) return hit.text;
			} catch {
				// truncated JSON, keep looking
			}
		}
		return null;
	}
}

function withErrorPrefix(text: string, isError: boolean): string {
	return isError && !text.startsWith('Error:') ? `Error: ${text}` : text;
}

/** A response as the session log keeps it. */
function assistantEvent(m: AssistantMessage) {
	const usage: StoredUsage | undefined =
		m.usage.totalTokens > 0
			? {
					input: m.usage.input,
					output: m.usage.output,
					cacheRead: m.usage.cacheRead,
					cacheWrite: m.usage.cacheWrite,
					totalTokens: m.usage.totalTokens,
				}
			: undefined;
	const thinking = m.content
		.filter((c): c is Extract<typeof c, { type: 'thinking' }> => c.type === 'thinking')
		.map((c) => c.thinking)
		.join('');
	const toolCalls: StoredToolCall[] = m.content
		.filter((c): c is Extract<typeof c, { type: 'toolCall' }> => c.type === 'toolCall')
		.map((c) => ({
			id: c.id,
			name: c.name,
			args: c.arguments,
			...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
		}));
	return {
		type: 'assistant' as const,
		content: textOf(m.content),
		thinking: thinking || undefined,
		toolCalls,
		usage,
		stopReason: m.stopReason,
	};
}

export function rewriteProviderError(message: string): string {
	if (
		/tool(s|_choice)?\b.*(not supported|unsupported|does not support|invalid)/i.test(message) ||
		/does not support tools/i.test(message)
	) {
		return 'This endpoint rejected tool calling. Check the provider settings.';
	}
	return message;
}
