import { debounce, Notice, Plugin, type WorkspaceLeaf } from 'obsidian';
import {
	AgentController,
	findModel,
	hasUnfinishedTurn,
	takeActiveTurns,
} from './agent/agent-controller';
import { AgentManager, agentGroup, agentKey } from './agent/agent-definitions';
import { NestedAgentsMd } from './agent/nested-agents-md';
import { PromptManager, vaultReferenceReader } from './agent/prompt';
import { expandReferences } from './agent/references';
import { SessionHub } from './agent/session-hub';
import { createSpawnAgentTool, Slots, SPAWN_AGENT_NAME } from './agent/subagent';
import { ContextManager } from './context/context-manager';
import { desktopHttp, openInBrowser } from './mcp/loopback';
import { apiKeySecretId, McpManager } from './mcp/mcp-manager';
import { clientSecretId, OAUTH_PROTOCOL_ACTION, serverIdFromState } from './mcp/oauth-provider';
import { adapterSignInFiles, SharedSignIns } from './mcp/shared-signin';
import {
	READ_ONLY_TOOL_NAMES,
	SHELL_GROUP,
	ToolPermissionManager,
} from './permissions/tool-permission-manager';
import { ProviderManager } from './provider/provider-manager';
import { TransportRouter } from './provider/transport';
import { replay, SessionManager } from './session/session-manager';
import { backupFileName, backupOf } from './settings/backup';
import { LibrarianSettingTab } from './settings/settings-tab';
import { createShellTool, ShellSession } from './shell/shell-tool';
import {
	createSkillSearchTool,
	SKILL_SEARCH_NAME,
	SkillManager,
	skillGroups,
	skillKey,
	skillsSection,
} from './skills/skill-manager';
import { SecretStore } from './storage/secret-store';
import { isAgentsPath, isSkillsPath } from './tools/path-policy';
import { createVaultTools, resultBudget, type ToolDeps } from './tools/registry';
import { ToolRegistry } from './tools/tool-registry';
import { DEFAULT_LISTED_TOOLS, type LibrarianSettings, mergeSettings } from './types';
import { LibrarianView, VIEW_TYPE_LIBRARIAN } from './ui/chat-view';
import { noteVisibility } from './visibility';
import { WEBDAV_SECRET_ID, WebDavClient } from './webdav/webdav-client';
import { createWebDavTools, WEBDAV_GROUP } from './webdav/webdav-tools';

/** Device-local: this device's id, and the hand-overs it already took (LIB-FEAT-234). */
const DEVICE_ID_KEY = 'librarian-device-id';
const TAKEN_HANDOFFS_KEY = 'librarian-taken-handoffs';

export default class LibrarianPlugin extends Plugin {
	settings!: LibrarianSettings;
	secrets!: SecretStore;
	sessions!: SessionManager;
	permissions!: ToolPermissionManager;
	providers!: ProviderManager;
	transport!: TransportRouter;
	mcp!: McpManager;
	skills!: SkillManager;
	/** Sub-agent definitions, built in and from `.agents/agents` (LIB-FEAT-268). */
	agentDefs!: AgentManager;
	/** Every session's runtime; each chat shows one of them (LIB-FEAT-274). */
	hub!: SessionHub;
	private settingTab!: LibrarianSettingTab;
	/** Each runtime's tools: what tool_search turned on belongs to that session. */
	private readonly registries = new WeakMap<AgentController, ToolRegistry>();
	/** Numbers each thing a shell asks about, so concurrent approvals keep separate cards. */
	private shellActions = 0;
	/** The chat used last, which Open chat and the commands go to (LIB-FEAT-277). */
	private lastView: LibrarianView | null = null;
	/** The Notice that sessions run with no chat open went out, until a chat opens again. */
	private toldRunningAlone = false;

	/** The runtime of the chat used last; the commands and the e2e scripts talk to it. */
	get controller(): AgentController {
		return this.hub.focused();
	}

	/** That runtime's tools, which the settings list and the e2e scripts read. */
	get registry(): ToolRegistry {
		return this.registries.get(this.controller)!;
	}

	async onload() {
		this.settings = mergeSettings(await this.loadData());
		// The fixed secrets also travel sealed in the settings, for every device with the same
		// sync passphrase (LIB-FEAT-233).
		this.secrets = new SecretStore(this.app, {
			read: () => this.settings.sealedSecrets,
			write: async (sealed) => {
				this.settings.sealedSecrets = sealed;
				await this.saveSettings();
			},
			ids: () => [
				...this.settings.providers.map((p) => p.secretId),
				...this.settings.mcpServers.flatMap((s) => [
					apiKeySecretId(s.id),
					clientSecretId(s.id),
				]),
				WEBDAV_SECRET_ID,
			],
		});
		this.sessions = new SessionManager(
			this.app,
			`${this.app.vault.configDir}/plugins/${this.manifest.id}`,
		);
		this.permissions = new ToolPermissionManager(
			() => this.settings,
			() => this.saveSettings(),
		);
		this.providers = new ProviderManager(() => this.settings);
		this.transport = new TransportRouter({
			onFallback: () =>
				new Notice(
					'Streaming is not available for this provider. Waiting for the full response.',
				),
		});
		this.mcp = new McpManager({
			settings: () => this.settings,
			save: () => this.saveSettings(),
			secrets: this.secrets,
			permissions: this.permissions,
			clientVersion: this.manifest.version,
			open: openInBrowser,
			notice: (message) => new Notice(message),
			loopback: desktopHttp,
			deviceId: () => this.deviceId(),
			taken: {
				has: (nonce) => this.takenHandoffs().includes(nonce),
				add: (nonce) =>
					this.app.saveLocalStorage(
						TAKEN_HANDOFFS_KEY,
						[...this.takenHandoffs(), nonce].slice(-50),
					),
			},
			// One sign-in for every device: each writes its copy in its own file (LIB-FEAT-289).
			shared: new SharedSignIns({
				files: adapterSignInFiles(
					this.app.vault.adapter,
					`${this.app.vault.configDir}/plugins/${this.manifest.id}/signins`,
				),
				seal: (text) => this.secrets.seal(text),
				unseal: (sealed) => this.secrets.unseal(sealed),
				deviceId: () => this.deviceId(),
			}),
		});
		this.skills = new SkillManager(this.app);
		this.agentDefs = new AgentManager(
			this.app,
			(ref) => !!findModel(this.providers.listSelectable(), ref),
		);
		this.permissions.attachExtras(
			() => [
				SHELL_GROUP,
				...this.mcp.groups(),
				...(this.webdavOn() ? [WEBDAV_GROUP] : []),
				...skillGroups(this.skills.skills),
				agentGroup(this.agentDefs.agents),
			],
			() => this.mcp.destructiveTools(),
			(tool, args) => {
				// Starting an agent is judged by that agent's own row (LIB-FEAT-268).
				if (tool === SPAWN_AGENT_NAME) return agentKey(this.hub.agentOfCall(args));
				if (tool !== 'read') return null;
				const path = (args as { path?: unknown } | null)?.path;
				const skill = typeof path === 'string' ? this.skills.skillFor(path) : null;
				return skill ? skillKey(skill.name) : null;
			},
			// Agents that only read start without asking, as the tools that only read do.
			() =>
				new Set([
					...this.mcp.readOnlyTools(),
					...this.agentDefs.agents
						.filter((a) => a.permissionMode === 'plan')
						.map((a) => agentKey(a.name)),
				]),
		);
		const hidden = this.skills.hiddenReader();
		// A fresh client per call picks up changed settings and this device's password, and the
		// call's signal, so Stop ends it.
		const webdavClient = (signal?: AbortSignal) =>
			new WebDavClient({
				url: this.settings.webdav.url,
				username: this.settings.webdav.username,
				password: this.secrets.get(WEBDAV_SECRET_ID),
				signal,
			});
		const nestedAgentsMdDeps: ConstructorParameters<typeof NestedAgentsMd>[0] = {
			vault: async (folder) => {
				const file = this.app.vault.getFileByPath(`${folder}/AGENTS.md`);
				if (!file) return null;
				const text = (await this.app.vault.cachedRead(file)).trim();
				if (!text) return null;
				// `@path` works here as it does in the root file.
				return (await expandReferences(text, file.path, vaultReferenceReader(this.app)))
					.text;
			},
			storage: () =>
				this.webdavOn()
					? async (folder, signal) => {
							const { data } = await webdavClient(signal).get(
								folder ? `${folder}/AGENTS.md` : 'AGENTS.md',
							);
							return new TextDecoder().decode(data);
						}
					: null,
			activePath: () => this.app.workspace.getActiveFile()?.path ?? null,
		};
		// Skills the model may reach: none while read is blocked, and never a blocked one.
		const usableSkills = () =>
			this.permissions.get('read') === 'blocked'
				? []
				: this.skills.skills.filter(
						(s) => this.permissions.get(skillKey(s.name)) !== 'blocked',
					);
		const deferredSkills = () =>
			usableSkills().filter((s) => this.toolDeferredOf(skillKey(s.name)));
		// The agents the model may start: not a blocked one, and none while spawn_agent is blocked.
		const usableAgents = () =>
			this.permissions.get(SPAWN_AGENT_NAME) === 'blocked'
				? []
				: this.agentDefs.agents.filter(
						(a) => this.permissions.get(agentKey(a.name)) !== 'blocked',
					);
		const context = new ContextManager(this.app, () => this.settings.context);
		// One set of places for every session's sub-agents: Max sub-agents counts the device.
		const agentSlots = new Slots(() => this.settings.maxSubagents);
		// Definitions and skills sit outside the vault index, so no vault event says one changed.
		const rescanHidden = async (paths: readonly string[]) => {
			if (paths.some(isAgentsPath)) await this.agentDefs.scan();
			if (paths.some(isSkillsPath)) await this.skills.scan();
		};

		/**
		 * One session's runtime (LIB-FEAT-274): its own shell, its own tools (what tool_search turns
		 * on stays in this session) and its own AGENTS.md deliveries, with every tool's hooks bound
		 * to it, so its snapshots and approvals land in its own conversation.
		 */
		const createRuntime = (): AgentController => {
			let controller!: AgentController;
			const mutation = {
				before: (id: string, path: string) => controller.beforeMutation(id, path),
				after: async (id: string, path: string) => {
					await controller.afterMutation(id, path);
					await rescanHidden([path]);
				},
			};
			const vaultDeps: ToolDeps = {
				app: this.app,
				settings: () => this.settings,
				hidden,
				mutation,
				describe: (path) => this.agentDefs.describe(path) ?? this.skills.describe(path),
			};
			const shell = new ShellSession({
				app: this.app,
				resultLimit: () => this.settings.toolResultMaxChars,
				gate: async (name, args, signal, bashCallId) => {
					const gate = await controller.gateShellAction(
						`${name}-${++this.shellActions}`,
						name,
						args,
						signal,
						undefined,
						bashCallId,
					);
					if (!gate.ok) throw new Error(gate.reason);
				},
				snapshot: mutation,
			});
			// Everything registered, with the execution policy from settings applied; the registry
			// decides which of these the model sees (deferred tools wait for tool_search).
			const registry = new ToolRegistry({
				registered: () => {
					const deferred = deferredSkills();
					const agents = usableAgents();
					// Built fresh each time so descriptions carry the current default limits from settings.
					return [
						...createVaultTools(vaultDeps),
						createShellTool(shell),
						// With the agents it can start listed in its description.
						...(agents.length
							? [
									createSpawnAgentTool(
										agents,
										(id, args, signal) =>
											controller.runSubagent(id, args, signal),
										resultBudget(this.settings),
									),
								]
							: []),
						...(this.webdavOn()
							? createWebDavTools({ ...vaultDeps, client: webdavClient })
							: []),
						...this.mcp.tools(),
						// Only while some skill waits to be found, as tool_search for deferred tools.
						...(deferred.length
							? [createSkillSearchTool(deferred, resultBudget(this.settings))]
							: []),
					].map((t) => ({
						...t,
						executionMode:
							this.settings.toolExecutionByTool[t.name] ??
							t.executionMode ??
							'parallel',
					}));
				},
				sourceOf: (t) =>
					this.mcpServerNameOf(t.name) ??
					(t.name.startsWith('webdav_') ? 'WebDAV' : 'vault'),
				deferred: (t) => this.toolDeferredOf(t.name),
				budget: () => resultBudget(this.settings),
			});
			controller = new AgentController({
				app: this.app,
				settings: () => this.settings,
				saveSettings: () => this.saveSettings(),
				sessions: this.sessions,
				context,
				permissions: this.permissions,
				providers: this.providers,
				transport: this.transport,
				prompt: new PromptManager(this.app),
				secrets: this.secrets,
				nestedAgentsMd: new NestedAgentsMd(nestedAgentsMdDeps),
				agentSlots,
				tools: () => registry.visible(),
				// Listed skills go in the catalog; deferred ones by name only, for skill_search to find.
				skillCatalog: () => {
					const usable = usableSkills();
					const listed = usable.filter((s) => !this.toolDeferredOf(skillKey(s.name)));
					const deferred =
						this.permissions.get(SKILL_SEARCH_NAME) === 'blocked'
							? []
							: usable.filter((s) => !listed.includes(s));
					return skillsSection(listed, deferred);
				},
				agentDefinition: (name) => this.agentDefs.get(name),
				hiddenFilesChanged: rescanHidden,
				registeredTools: () => registry.entries().map((e) => e.tool),
				readsOnly: (name) =>
					READ_ONLY_TOOL_NAMES.has(name) || this.mcp.readOnlyTools().has(name),
				skillActivation: async (name) => {
					const skill = usableSkills().find((s) => s.name === name);
					return skill ? this.skills.activation(skill) : null;
				},
			});
			controller.subscribe((e) => {
				if (e.type !== 'session') return;
				registry.reset();
				// A new conversation starts with empty scratch space and no leftover shell variables.
				shell.reset();
			});
			this.registries.set(controller, registry);
			return controller;
		};
		this.hub = new SessionHub({
			create: createRuntime,
			notify: (message) => new Notice(message),
		});

		// Leaving the app freezes the connection on a phone; each running session waits for the return.
		this.registerDomEvent(document, 'visibilitychange', () => {
			noteVisibility();
			for (const runtime of this.hub.runtimes) runtime.onVisibilityChange();
			// Back in the app, the sync may have brought a sign-in another device shared.
			if (document.visibilityState === 'visible') void this.mcp.retryShared();
		});
		// And while the app stays open, as the sync runs on its own schedule.
		this.registerInterval(window.setInterval(() => void this.mcp.retryShared(), 120_000));
		this.registerObsidianProtocolHandler(OAUTH_PROTOCOL_ACTION, (params) => {
			const id = serverIdFromState(params.state);
			if (!id) return;
			if (params.error) {
				new Notice(`Sign-in failed: ${params.error_description ?? params.error}`);
				return;
			}
			if (params.code) void this.mcp.finishAuth(id, params.code);
		});
		this.app.workspace.onLayoutReady(() => {
			// Servers connect with the keys and sign-ins the sealed settings bring to this device.
			void this.secrets
				.unlock()
				.then(() => this.mcp.claimHandoffs())
				.then(() => this.mcp.connectAll());
			void this.skills.scan();
			void this.agentDefs.scan();
			void this.finishInterruptedTurns();
		});

		this.registerView(VIEW_TYPE_LIBRARIAN, (leaf) => new LibrarianView(leaf, this));
		// Which chat is used last, and which sessions are on screen now (LIB-FEAT-276, LIB-FEAT-277).
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf?.view instanceof LibrarianView) {
					this.lastView = leaf.view;
					this.hub.focus(leaf.view.runtime);
				}
				this.hub.refresh();
			}),
		);
		// Closing the last chat leaves the sessions running; a chat moved from one side to the other
		// is back within the delay, so it says nothing.
		const noteRunningAlone = debounce(
			() => {
				if (this.app.workspace.getLeavesOfType(VIEW_TYPE_LIBRARIAN).length) {
					this.toldRunningAlone = false;
					return;
				}
				if (this.toldRunningAlone || !this.hub.runtimes.some((r) => r.isRunning)) return;
				this.toldRunningAlone = true;
				new Notice('Sessions keep running in the background. Open the chat to see them.');
			},
			500,
			true,
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.hub.refresh();
				noteRunningAlone();
			}),
		);
		this.addRibbonIcon('book-open', 'Open chat', () => void this.activateView());
		this.addCommand({
			id: 'open-in-main',
			name: 'Open chat in main area',
			callback: () => void this.activateView('tab'),
		});
		this.addCommand({
			id: 'open-in-sidebar',
			name: 'Open chat in right sidebar',
			callback: () => void this.activateView('sidebar'),
		});
		this.addCommand({
			id: 'open-in-new-tab',
			name: 'Open chat in new tab',
			callback: () => void this.openChatInNewTab(),
		});
		const settingTab = new LibrarianSettingTab(this.app, this);
		this.settingTab = settingTab;
		this.addSettingTab(settingTab);
		// Obsidian 1.13 draws the tab from its definitions and never calls display(), so the
		// tab is told here when a server's state or the skill list changes.
		this.register(this.mcp.subscribe(() => settingTab.refresh()));
		this.register(this.skills.subscribe(() => settingTab.refresh()));
		this.register(this.agentDefs.subscribe(() => settingTab.refresh()));
		// A key that arrives sealed may be the one a chat was waiting for.
		this.register(
			this.secrets.subscribe(() => {
				settingTab.refresh();
				void this.refreshReadiness();
				// A new passphrase may open the sign-ins the other devices shared.
				this.mcp.sharedChanged();
				void this.mcp.retryShared();
			}),
		);

		this.addCommand({
			id: 'open',
			name: 'Open chat',
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: 'new-session',
			name: 'New session',
			callback: async () => {
				const view = await this.activateView();
				await view?.newSession();
			},
		});
		this.addCommand({
			id: 'open-history',
			name: 'Open session history',
			callback: async () => {
				const view = await this.activateView();
				await view?.toggleHistory();
			},
		});
		this.addCommand({
			id: 'compact-context',
			name: 'Compact context',
			callback: async () => {
				const runtime = this.controller;
				if (!runtime.session) {
					new Notice('Open a session first.');
					return;
				}
				const outcome = await runtime.compactNow();
				new Notice(
					outcome === 'compacted'
						? 'Context compacted.'
						: outcome === 'failed'
							? 'Could not compact the context.'
							: 'Nothing to compact yet.',
				);
			},
		});
		this.addCommand({
			id: 'add-active-note',
			name: 'Add active note to prompt',
			callback: async () => {
				const view = await this.activateView();
				view?.includeActiveNoteInPrompt();
			},
		});
	}

	onunload() {
		this.hub.stopAll();
		this.mcp.stopSignIns();
		for (const server of this.settings.mcpServers) void this.mcp.disconnect(server.id);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Every session's idle state and usage ring again, after keys or settings changed. */
	async refreshReadiness(): Promise<void> {
		for (const runtime of this.hub.runtimes) await runtime.refreshReadiness();
	}

	/** Every session's usage again: a setting changed what the next request holds. */
	async recalculateUsage(): Promise<void> {
		for (const runtime of this.hub.runtimes) await runtime.recalculateUsage();
	}

	/**
	 * The vault's sync brought settings another device wrote. They replace this device's whole:
	 * keeping the old ones in memory would write them back over the other device's on the next
	 * save here (LIB-FEAT-254). A file that is missing or half written is left alone.
	 */
	async onExternalSettingsChange() {
		let stored: unknown;
		try {
			stored = await this.loadData();
		} catch {
			return;
		}
		if (!stored || typeof stored !== 'object') return;
		const before = this.settings;
		const fresh = mergeSettings(stored);
		if (JSON.stringify(fresh) === JSON.stringify(before)) return;
		this.settings = fresh;
		for (const runtime of this.hub.runtimes) runtime.reselect();
		if (fresh.sealedSecrets !== before.sealedSecrets) await this.secrets.unlock();
		await this.mcp.claimHandoffs();
		await this.mcp.reconcile(before.mcpServers);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_LIBRARIAN))
			if (leaf.view instanceof LibrarianView) leaf.view.renderModelSelect();
		this.settingTab.refresh();
		await this.refreshReadiness();
	}

	/** Writes every setting to a JSON file at the top of the vault and returns its path (LIB-FEAT-241). */
	async exportSettings(): Promise<string> {
		// A key typed a moment ago may still be on its way into the sealed bundle.
		await this.secrets.settled();
		const path = backupFileName();
		const text = JSON.stringify(backupOf(this.settings, this.manifest.version), null, '\t');
		const existing = this.app.vault.getFileByPath(path);
		if (existing) await this.app.vault.modify(existing, text);
		else await this.app.vault.create(path, text);
		return path;
	}

	/**
	 * Replaces every setting on this device with a backup's. Its keys come back when this device's
	 * sync passphrase opens the sealed bundle in it; sign-ins waiting for this device are kept.
	 */
	async importSettings(next: LibrarianSettings): Promise<void> {
		for (const server of this.settings.mcpServers) await this.mcp.disconnect(server.id);
		this.settings = { ...next, oauthHandoffs: this.settings.oauthHandoffs };
		await this.saveSettings();
		await this.secrets.unlock();
		await this.mcp.claimHandoffs();
		await this.mcp.connectAll();
		await this.refreshReadiness();
	}

	/** This device's id, made once and kept in its local storage, never synced. */
	private deviceId(): string {
		const stored: unknown = this.app.loadLocalStorage(DEVICE_ID_KEY);
		if (typeof stored === 'string' && stored) return stored;
		const id = crypto.randomUUID();
		this.app.saveLocalStorage(DEVICE_ID_KEY, id);
		return id;
	}

	private takenHandoffs(): string[] {
		const stored: unknown = this.app.loadLocalStorage(TAKEN_HANDOFFS_KEY);
		return Array.isArray(stored)
			? stored.filter((n): n is string => typeof n === 'string')
			: [];
	}

	/** The storage tools exist only while a WebDAV storage is switched on and has a URL. */
	webdavOn(): boolean {
		return this.settings.webdav.enabled && this.settings.webdav.url.trim() !== '';
	}

	/** The MCP server a `<server id>__<tool>` name belongs to, by display name. */
	mcpServerNameOf(toolName: string): string | null {
		const sep = toolName.indexOf('__');
		if (sep < 0) return null;
		const id = toolName.slice(0, sep);
		return this.settings.mcpServers.find((s) => s.id === id)?.name ?? id;
	}

	/**
	 * Deferred tools and skills are not listed to the model until tool_search or skill_search
	 * finds them. By default only the vault search and edit tools, bash and skill_search are listed.
	 */
	toolDeferredOf(name: string): boolean {
		return this.settings.toolDeferredByTool[name] ?? !DEFAULT_LISTED_TOOLS.has(name);
	}

	/** Effective execution mode of one tool: the setting, else the tool's own default. */
	toolExecutionOf(name: string): 'parallel' | 'sequential' {
		const stored = this.settings.toolExecutionByTool[name];
		if (stored) return stored;
		const tool = this.registry.entries().find((e) => e.tool.name === name)?.tool;
		return tool?.executionMode ?? 'parallel';
	}

	/**
	 * A phone may kill the app while agents work. The sessions whose turn was running are noted on
	 * this device, so the next start opens them and lets the model finish what was asked; the chat
	 * shows the last of them and the others run on in the session list.
	 */
	private async finishInterruptedTurns(): Promise<void> {
		const resumed: AgentController[] = [];
		for (const id of takeActiveTurns(this.app)) {
			if (this.hub.find(id)?.isRunning) continue;
			// Peek before opening: an interrupted turn is the only reason to reopen it.
			if (!hasUnfinishedTurn(replay(await this.sessions.load(id)))) continue;
			try {
				resumed.push(await this.hub.open(id));
			} catch {
				// Its file is gone; nothing to finish.
			}
		}
		const last = resumed[resumed.length - 1];
		if (!last) return;
		const view = await this.activateView();
		await view?.show(last);
		for (const runtime of resumed) void runtime.resumeTurn();
	}

	/**
	 * Reveals the chat and returns the view. Without `location` the chat used last is reused
	 * wherever it is and a new one follows the setting; with it, a chat in the other place is
	 * moved and keeps showing its session.
	 */
	async activateView(location?: 'sidebar' | 'tab'): Promise<LibrarianView | null> {
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_LIBRARIAN);
		let leaf: WorkspaceLeaf | null =
			(this.lastView && leaves.includes(this.lastView.leaf)
				? this.lastView.leaf
				: leaves[0]) ?? null;
		let session: string | undefined;
		if (leaf && location) {
			const inMain = leaf.getRoot() === workspace.rootSplit;
			if (inMain !== (location === 'tab')) {
				session =
					leaf.view instanceof LibrarianView ? leaf.view.runtime.session?.id : undefined;
				leaf.detach();
				leaf = null;
			}
		}
		if (!leaf) {
			const wanted = location ?? this.settings.chatLocation;
			leaf = wanted === 'tab' ? workspace.getLeaf('tab') : workspace.getRightLeaf(false);
			if (!leaf) return null;
			await leaf.setViewState({
				type: VIEW_TYPE_LIBRARIAN,
				active: true,
				state: session ? { session } : {},
			});
		}
		await workspace.revealLeaf(leaf);
		const view = leaf.view instanceof LibrarianView ? leaf.view : null;
		if (view) this.lastView = view;
		view?.focusInput();
		return view;
	}

	/** One more chat in the main area, on a new session; the chats open stay (LIB-FEAT-277). */
	async openChatInNewTab(): Promise<LibrarianView | null> {
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE_LIBRARIAN, active: true });
		await this.app.workspace.revealLeaf(leaf);
		const view = leaf.view instanceof LibrarianView ? leaf.view : null;
		if (view) this.lastView = view;
		view?.focusInput();
		return view;
	}

	openSettings() {
		const setting = (
			this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }
		).setting;
		setting.open();
		setting.openTabById(this.manifest.id);
	}
}
