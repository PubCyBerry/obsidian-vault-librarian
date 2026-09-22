import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ImageContent, TextContent } from '@earendil-works/pi-ai';
import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import type { ContextManager, ContextUsage } from '../context/context-manager';
import type { ToolPermissionManager } from '../permissions/tool-permission-manager';
import {
	type ActiveSelection,
	effectiveRequestOptions,
	type PiModel,
	type ProviderManager,
	toPiModel,
} from '../provider/provider-manager';
import type { TransportRouter } from '../provider/transport';
import { contentHash, replay, type SessionManager } from '../session/session-manager';
import type {
	IndexedEvent,
	SessionEvent,
	SessionMetadata,
	StoredUsage,
} from '../session/session-types';
import type { SecretStore } from '../storage/secret-store';
import type { LibrarianSettings, ThinkingLevel } from '../types';
import { BUILT_IN_SYSTEM_PROMPT, type PromptManager } from './prompt';

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

export type ToolCardStatus =
	| 'pending'
	| 'awaiting-approval'
	| 'running'
	| 'ok'
	| 'failed'
	| 'rejected'
	| 'blocked'
	| 'expired';

export type ApprovalDecision = 'approve' | 'reject' | 'always' | 'expired';

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
	resolve: (decision: ApprovalDecision) => void;
}

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
	| { type: 'error'; message: string };

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
	/** `<available_skills>` for the system prompt; empty when none is usable. */
	skillCatalog: () => string;
}

function textOf(content: readonly { type: string }[]): string {
	return content
		.filter((c): c is TextContent => c.type === 'text')
		.map((c) => c.text)
		.join('');
}

export class AgentController {
	state: AgentUiState = 'idle';
	session: SessionMetadata | null = null;
	events: IndexedEvent[] = [];
	usage: ContextUsage | null = null;
	pendingApproval: ApprovalRequest | null = null;
	/** Provider and model the current session runs on; may differ from the settings default. */
	selection: ActiveSelection | undefined;
	thinkingLevel: ThinkingLevel = 'off';

	private agent: Agent | null = null;
	private readonly listeners = new Set<(event: ControllerEvent) => void>();
	private readonly toolStatus = new Map<string, ToolCardStatus>();
	private readonly truncatedResults = new Set<string>();
	private readonly pendingSnapshots = new Map<string, { path: string; content: string | null }>();
	private failures = new Map<string, number>();
	private iterations = 0;
	private stopReason: string | null = null;

	constructor(private readonly deps: ControllerDeps) {}

	subscribe(listener: (event: ControllerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: ControllerEvent) {
		if (event.type === 'state') this.state = event.state;
		for (const l of this.listeners) l(event);
	}

	get isRunning(): boolean {
		return this.agent !== null;
	}

	toolStatusOf(id: string): ToolCardStatus | undefined {
		return this.toolStatus.get(id);
	}

	// Session lifecycle

	private defaultSelection(): ActiveSelection | undefined {
		return this.deps.providers.getActive();
	}

	async newSession(): Promise<void> {
		await this.abortAndWait();
		this.selection = this.defaultSelection();
		this.thinkingLevel = this.selection?.provider.requestDefaults.thinkingLevel ?? 'off';
		this.session = await this.deps.sessions.create({
			providerId: this.selection?.provider.id ?? '',
			modelId: this.selection?.model.id ?? '',
			thinkingLevel: this.thinkingLevel,
		});
		this.toolStatus.clear();
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
		await this.reloadEvents();
		for (const { event } of this.events) {
			if (event.type === 'tool_result' && !this.toolStatus.has(event.toolCallId)) {
				this.toolStatus.set(
					event.toolCallId,
					event.content === 'Approval expired' ? 'expired' : event.ok ? 'ok' : 'failed',
				);
			}
			if (event.type === 'approval' && event.decision === 'rejected')
				this.toolStatus.set(event.toolCallId, 'rejected');
		}
		this.emit({ type: 'session', session: this.session });
		await this.refreshReadiness();
	}

	async closeSession(): Promise<void> {
		await this.abortAndWait();
		this.session = null;
		this.events = [];
		this.usage = null;
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

	/** Recomputes the idle state (key missing, model missing) and the usage indicator. */
	async refreshReadiness(): Promise<void> {
		if (this.agent) return;
		if (!this.session && !this.selection) this.selection = this.defaultSelection();
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
			builtIn: BUILT_IN_SYSTEM_PROMPT,
			vaultAgentsMd: agentsMd,
			customSystemPrompt: s.customSystemPrompt,
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
		const sel = this.selection!;
		return this.deps.transport.createStreamFn(sel.provider, () => ({
			apiKey: this.deps.secrets.get(sel.provider.secretId),
			authHeader: sel.provider.authHeader,
			options: effectiveRequestOptions(sel.provider, sel.model, this.thinkingLevel),
		}));
	}

	// Sending

	async send(text: string, images: string[] = []): Promise<void> {
		if (this.agent) return;
		if (!this.session) await this.newSession();
		if (!this.selection) {
			this.emit({ type: 'state', state: 'model-unavailable' });
			return;
		}
		const key = this.deps.secrets.get(this.selection.provider.secretId);
		if (key === null) {
			this.emit({ type: 'state', state: 'no-key' });
			return;
		}
		const sessionId = this.session!.id;
		const model = this.piModel()!;
		await this.deps.sessions.append(sessionId, {
			type: 'user',
			content: text,
			images: images.length ? images : undefined,
		});
		await this.reloadEvents();

		const streamFn = this.streamFn();
		let prompt = await this.systemPrompt();
		let tools = this.exposedTools();
		const usage = this.deps.context.usage(this.events, model);
		if (usage.state === 'critical') await this.compactNow(streamFn);
		prompt = await this.systemPrompt();
		tools = this.exposedTools();
		const prepared = await this.deps.context.build({
			events: this.events,
			model,
			excludeLastUser: true,
			systemPrompt: prompt,
			tools,
		});
		this.usage = prepared.usage;
		this.emit({ type: 'usage', usage: this.usage });

		this.iterations = 0;
		this.failures = new Map();
		this.stopReason = null;
		const sel = this.selection;
		const agent = new Agent({
			initialState: {
				model,
				thinkingLevel: this.thinkingLevel,
				tools,
				messages: prepared.messages,
			},
			streamFn,
			toolExecution: sel.provider.requestDefaults.parallelReadTools
				? 'parallel'
				: 'sequential',
			beforeToolCall: (ctx, signal) =>
				this.beforeToolCall(ctx.toolCall.id, ctx.toolCall.name, ctx.args, signal),
			afterToolCall: (ctx) =>
				this.afterToolCall(
					ctx.toolCall.id,
					ctx.toolCall.name,
					ctx.args,
					ctx.result.content,
					ctx.isError,
				),
			shouldStopAfterTurn: (ctx, signal) =>
				signal?.aborted === true || this.shouldStopAfterTurn(ctx.toolResults.length),
			prepareNextTurnWithContext: (ctx, signal) =>
				this.prepareNextTurn(ctx.context.messages, model, streamFn, signal),
		});
		agent.subscribe((event) => this.onAgentEvent(event));
		this.agent = agent;
		this.emit({ type: 'state', state: 'requesting' });
		try {
			const imageContents: ImageContent[] = [];
			for (const path of images) {
				const file = this.deps.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) continue;
				const bytes = new Uint8Array(await this.deps.app.vault.readBinary(file));
				let binary = '';
				for (let i = 0; i < bytes.length; i += 0x8000)
					binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
				const ext = file.extension.toLowerCase();
				imageContents.push({
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
			await agent.prompt(text, imageContents);
		} finally {
			this.agent = null;
			this.pendingSnapshots.clear();
			await this.reloadEvents();
			await this.refreshReadiness();
			this.emit({ type: 'stream', message: null });
		}
	}

	stop(): void {
		this.agent?.abort();
		this.pendingApproval?.resolve('expired');
	}

	private async abortAndWait(): Promise<void> {
		if (!this.agent) return;
		const agent = this.agent;
		this.stop();
		await agent.waitForIdle();
	}

	async compactNow(streamFn?: StreamFn): Promise<boolean> {
		const model = this.piModel();
		if (!model || !this.session) return false;
		const previous = this.state;
		this.emit({ type: 'state', state: 'compacting' });
		try {
			const result = await this.deps.context.compact(
				this.events,
				model,
				streamFn ?? this.streamFn(),
				this.agent?.signal,
			);
			if (!result) return false;
			await this.deps.sessions.append(this.session.id, { type: 'compaction', ...result });
			if (result.method === 'truncate') {
				this.emit({
					type: 'notice',
					message: 'Summary failed. Older messages were dropped from the request.',
				});
			}
			await this.reloadEvents();
			await this.recalculateUsage();
			return true;
		} finally {
			if (!this.agent) await this.refreshReadiness();
			else
				this.emit({
					type: 'state',
					state: previous === 'compacting' ? 'requesting' : previous,
				});
		}
	}

	// Pi hooks

	private async beforeToolCall(
		toolCallId: string,
		name: string,
		args: unknown,
		signal?: AbortSignal,
	) {
		const perms = this.deps.permissions;
		if (!this.deps.tools().some((t) => t.name === name))
			return { block: true, reason: `Tool ${name} not found` };
		const permission = perms.resolve(name, args);
		if (permission === 'blocked') {
			this.setToolStatus(toolCallId, 'blocked');
			return { block: true, reason: 'Tool blocked by settings' };
		}
		const record = (args ?? {}) as Record<string, unknown>;
		if (permission === 'approval_required') {
			this.setToolStatus(toolCallId, 'awaiting-approval');
			const decision = await this.askApproval(toolCallId, name, record, signal);
			if (this.session) {
				await this.deps.sessions.append(this.session.id, {
					type: 'approval',
					toolCallId,
					name,
					decision:
						decision === 'reject'
							? 'rejected'
							: decision === 'expired'
								? 'expired'
								: 'approved',
				});
			}
			if (decision === 'reject') {
				this.setToolStatus(toolCallId, 'rejected');
				return {
					block: true,
					reason: 'The user rejected this tool call. Ask before retrying or choose another approach.',
				};
			}
			if (decision === 'expired') {
				this.setToolStatus(toolCallId, 'expired');
				return { block: true, reason: 'Approval expired' };
			}
			if (decision === 'always') {
				const key = perms.permissionKey(name, args);
				await perms.setTool(key, 'always_allow');
				this.emit({
					type: 'notice',
					message: `${key} is now always allowed. Change it in Settings.`,
				});
			}
		}
		try {
			perms.assertExecutable(name);
		} catch (error) {
			this.setToolStatus(toolCallId, 'blocked');
			return { block: true, reason: error instanceof Error ? error.message : String(error) };
		}
		if ((name === 'write' || name === 'edit') && typeof record.path === 'string') {
			const file = this.deps.app.vault.getFileByPath(record.path);
			const content = file ? await this.deps.app.vault.read(file) : null;
			this.pendingSnapshots.set(toolCallId, { path: file?.path ?? record.path, content });
		}
		this.setToolStatus(toolCallId, 'running');
		return undefined;
	}

	private askApproval(
		toolCallId: string,
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
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
			this.pendingApproval = {
				toolCallId,
				name,
				args,
				canAlways: this.deps.permissions.canAlwaysAllow(name),
				permissionKey: this.deps.permissions.permissionKey(name, args),
				existingLength: existing?.stat.size,
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
	) {
		let text = textOf(content);
		if (isError && !text.startsWith('Error:')) text = `Error: ${text}`;
		const max = this.deps.settings().toolResultMaxChars;
		if (text.length > max) {
			const dropped = text.length - max;
			text = `${text.slice(0, max)}\n[truncated ${dropped} characters; narrow the request to see more]`;
			this.truncatedResults.add(toolCallId);
		}
		const key = `${name}:${JSON.stringify(args ?? {})}`;
		if (isError) this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
		else this.failures.delete(key);

		const snapshot = this.pendingSnapshots.get(toolCallId);
		this.pendingSnapshots.delete(toolCallId);
		if (snapshot && !isError && this.session) {
			const file = this.deps.app.vault.getFileByPath(snapshot.path);
			if (file) {
				const after = await this.deps.app.vault.read(file);
				const index = this.events.length
					? this.events[this.events.length - 1]!.index + 1
					: 0;
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
		}
		return { content: [{ type: 'text' as const, text }], isError };
	}

	private shouldStopAfterTurn(toolResultCount: number): boolean {
		if (toolResultCount === 0) return false;
		this.iterations++;
		const limit = this.deps.settings().repeatedFailureLimit;
		for (const [, count] of this.failures) {
			if (count >= limit) {
				this.stopReason = `Stopped: the same tool call failed ${count} times`;
				return true;
			}
		}
		if (this.iterations >= this.deps.settings().maxIterations) {
			this.stopReason = `Stopped after ${this.iterations} tool iterations. Send a message to continue.`;
			return true;
		}
		return false;
	}

	private async prepareNextTurn(
		current: AgentMessage[],
		model: PiModel,
		streamFn: StreamFn,
		signal?: AbortSignal,
	) {
		const tools = this.exposedTools();
		const prompt = await this.systemPrompt();
		const usage = this.deps.context.usage(this.events, model);
		if (usage.state === 'critical' && !signal?.aborted) {
			const compacted = await this.compactNow(streamFn);
			if (compacted) {
				const prepared = await this.deps.context.build({
					events: this.events,
					model,
					systemPrompt: prompt,
					tools,
				});
				return { context: { messages: prepared.messages, tools } };
			}
		}
		return { context: { messages: current, tools } };
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
					const usage: StoredUsage | undefined =
						m.usage.totalTokens > 0
							? {
									input: m.usage.input,
									output: m.usage.output,
									cacheRead: m.usage.cacheRead,
									totalTokens: m.usage.totalTokens,
								}
							: undefined;
					const thinking = m.content
						.filter(
							(c): c is Extract<typeof c, { type: 'thinking' }> =>
								c.type === 'thinking',
						)
						.map((c) => c.thinking)
						.join('');
					const toolCalls = m.content
						.filter(
							(c): c is Extract<typeof c, { type: 'toolCall' }> =>
								c.type === 'toolCall',
						)
						.map((c) => ({
							id: c.id,
							name: c.name,
							args: c.arguments,
						}));
					await this.deps.sessions.append(sessionId, {
						type: 'assistant',
						content: textOf(m.content),
						thinking: thinking || undefined,
						toolCalls,
						usage,
						stopReason: m.stopReason,
					});
					for (const call of toolCalls) {
						await this.deps.sessions.append(sessionId, {
							type: 'tool_call',
							toolCallId: call.id,
							name: call.name,
							args: call.args,
						});
						if (!this.toolStatus.has(call.id)) this.toolStatus.set(call.id, 'pending');
					}
					if (m.stopReason === 'error' || m.stopReason === 'aborted') {
						if (m.stopReason === 'error') {
							const message = m.errorMessage ?? 'Request failed';
							await this.deps.sessions.append(sessionId, {
								type: 'error',
								stage: 'provider',
								message,
							});
							this.emit({ type: 'error', message: rewriteProviderError(message) });
						}
					}
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
					await this.deps.sessions.append(sessionId, {
						type: 'tool_result',
						toolCallId: m.toolCallId,
						name: m.toolName,
						ok: !m.isError,
						content: withErrorPrefix(textOf(m.content), m.isError),
						truncated: this.truncatedResults.delete(m.toolCallId),
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
				if (this.stopReason) {
					await this.deps.sessions.append(sessionId, {
						type: 'error',
						stage: 'tool',
						message: this.stopReason,
					});
					this.emit({ type: 'notice', message: this.stopReason });
					this.stopReason = null;
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
			const file = this.deps.app.vault.getFileByPath(event.path);
			if (!file) {
				if (event.ref !== null)
					unchanged.push({ path: event.path, reason: 'The note no longer exists.' });
				continue;
			}
			const current = await this.deps.app.vault.read(file);
			if (contentHash(current) !== event.afterHash) {
				unchanged.push({
					path: event.path,
					reason: 'The note was edited after the agent changed it.',
				});
				continue;
			}
			if (event.ref === null) {
				await this.deps.app.fileManager.trashFile(file);
				reverted.push(event.path);
				continue;
			}
			const previous = await this.deps.sessions.readSnapshot(sessionId, event.ref);
			if (previous === null) {
				unchanged.push({ path: event.path, reason: 'The snapshot is missing.' });
				continue;
			}
			let applied = false;
			await this.deps.app.vault.process(file, (data) => {
				if (contentHash(data) !== event.afterHash) return data;
				applied = true;
				return previous;
			});
			if (applied) {
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

export function rewriteProviderError(message: string): string {
	if (
		/tool(s|_choice)?\b.*(not supported|unsupported|does not support|invalid)/i.test(message) ||
		/does not support tools/i.test(message)
	) {
		return 'This endpoint rejected tool calling. Check the provider settings.';
	}
	return message;
}
