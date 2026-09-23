import { Notice, Plugin, type WorkspaceLeaf } from 'obsidian';
import { ACTIVE_TURN_KEY, AgentController, hasUnfinishedTurn } from './agent/agent-controller';
import { PromptManager } from './agent/prompt';
import { ContextManager } from './context/context-manager';
import { McpManager } from './mcp/mcp-manager';
import { OAUTH_PROTOCOL_ACTION, serverIdFromState } from './mcp/oauth-provider';
import { shellGroup, ToolPermissionManager } from './permissions/tool-permission-manager';
import { ProviderManager } from './provider/provider-manager';
import { TransportRouter } from './provider/transport';
import { replay, SessionManager } from './session/session-manager';
import { LibrarianSettingTab } from './settings/settings-tab';
import { shellPermissionKey } from './shell/commands';
import { createShellTool, ShellSession } from './shell/shell-tool';
import { catalogOf, SkillManager, skillGroups, skillKey } from './skills/skill-manager';
import { SecretStore } from './storage/secret-store';
import { createVaultTools, type ToolDeps } from './tools/registry';
import { ToolRegistry } from './tools/tool-registry';
import { type LibrarianSettings, mergeSettings } from './types';
import { LibrarianView, VIEW_TYPE_LIBRARIAN } from './ui/chat-view';
import { WEBDAV_SECRET_ID, WebDavClient } from './webdav/webdav-client';
import { createWebDavTools, WEBDAV_GROUP } from './webdav/webdav-tools';

export default class LibrarianPlugin extends Plugin {
	settings!: LibrarianSettings;
	secrets!: SecretStore;
	sessions!: SessionManager;
	permissions!: ToolPermissionManager;
	providers!: ProviderManager;
	transport!: TransportRouter;
	mcp!: McpManager;
	skills!: SkillManager;
	registry!: ToolRegistry;
	controller!: AgentController;
	shell!: ShellSession;
	/** Numbers each thing the shell asks about, so concurrent approvals keep separate cards. */
	private shellActions = 0;

	async onload() {
		this.settings = mergeSettings(await this.loadData());
		this.secrets = new SecretStore(this.app);
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
			open: (url) => window.open(url),
			notice: (message) => new Notice(message),
		});
		this.skills = new SkillManager(this.app);
		this.permissions.attachExtras(
			() => [
				shellGroup(this.settings),
				...this.mcp.groups(),
				...(this.webdavOn() ? [WEBDAV_GROUP] : []),
				...skillGroups(this.skills.skills),
			],
			() => this.mcp.destructiveTools(),
			(tool, args) => {
				// One key per site, verb and command, so Always allow covers exactly that target.
				const shellKey = shellPermissionKey(tool, args);
				if (shellKey) return shellKey;
				if (tool !== 'read') return null;
				const path = (args as { path?: unknown } | null)?.path;
				const skill = typeof path === 'string' ? this.skills.skillFor(path) : null;
				return skill ? skillKey(skill.name) : null;
			},
		);
		const mutation = {
			before: (id: string, path: string) => this.controller.beforeMutation(id, path),
			after: (id: string, path: string) => this.controller.afterMutation(id, path),
		};
		const vaultDeps: ToolDeps = {
			app: this.app,
			settings: () => this.settings,
			hidden: this.skills.hiddenReader(),
			mutation,
		};
		const webdavTools = () =>
			this.webdavOn()
				? createWebDavTools({
						...vaultDeps,
						// A fresh client per call picks up changed settings and this device's password.
						client: () =>
							new WebDavClient({
								url: this.settings.webdav.url,
								username: this.settings.webdav.username,
								password: this.secrets.get(WEBDAV_SECRET_ID),
							}),
					})
				: [];
		this.shell = new ShellSession({
			app: this.app,
			resultLimit: () => this.settings.toolResultMaxChars,
			gate: async (name, args, signal) => {
				const gate = await this.controller.gateShellAction(
					`${name}-${++this.shellActions}`,
					name,
					args,
					signal,
				);
				if (!gate.ok) throw new Error(gate.reason);
			},
			snapshot: mutation,
		});
		// Everything registered, with the execution policy from settings applied; the registry
		// decides which of these the model sees (deferred tools wait for tool_search).
		this.registry = new ToolRegistry({
			registered: () =>
				// Built fresh each time so descriptions carry the current default limits from settings.
				[
					...createVaultTools(vaultDeps),
					createShellTool(this.shell),
					...webdavTools(),
					...this.mcp.tools(),
				].map((t) => ({
					...t,
					executionMode:
						this.settings.toolExecutionByTool[t.name] ?? t.executionMode ?? 'parallel',
				})),
			sourceOf: (t) =>
				this.mcpServerNameOf(t.name) ?? (t.name.startsWith('webdav_') ? 'WebDAV' : 'vault'),
			deferred: (t) => this.toolDeferredOf(t.name),
		});
		const context = new ContextManager(this.app, () => this.settings.context);
		this.controller = new AgentController({
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
			tools: () => this.registry.visible(),
			// Blocked skills stay out of the catalog; without read the model could not open one anyway.
			skillCatalog: () =>
				this.permissions.get('read') === 'blocked'
					? ''
					: catalogOf(
							this.skills.skills.filter(
								(s) => this.permissions.get(skillKey(s.name)) !== 'blocked',
							),
						),
		});
		this.controller.subscribe((e) => {
			if (e.type !== 'session') return;
			this.registry.reset();
			// A new conversation starts with empty scratch space and no leftover shell variables.
			this.shell.reset();
		});
		// Leaving the app freezes the connection on a phone; the controller waits for the return.
		this.registerDomEvent(document, 'visibilitychange', () =>
			this.controller.onVisibilityChange(),
		);
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
			void this.mcp.connectAll();
			void this.skills.scan();
			void this.finishInterruptedTurn();
		});

		this.registerView(VIEW_TYPE_LIBRARIAN, (leaf) => new LibrarianView(leaf, this));
		this.addRibbonIcon('book-open', 'Open chat', () => void this.activateView());
		this.addCommand({
			id: 'open-in-main',
			name: 'Open chat in main area',
			callback: () => void this.activateView('tab'),
		});
		this.addSettingTab(new LibrarianSettingTab(this.app, this));

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
				if (!this.controller.session) {
					new Notice('Open a session first.');
					return;
				}
				const done = await this.controller.compactNow();
				new Notice(done ? 'Context compacted.' : 'Nothing to compact yet.');
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
		this.controller.stop();
		for (const server of this.settings.mcpServers) void this.mcp.disconnect(server.id);
	}

	async saveSettings() {
		await this.saveData(this.settings);
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

	/** Deferred tools are not listed to the model until tool_search finds them. MCP tools default to deferred. */
	toolDeferredOf(name: string): boolean {
		const stored = this.settings.toolDeferredByTool[name];
		if (stored !== undefined) return stored;
		return name.includes('__');
	}

	/** Effective execution mode of one tool: the setting, else the tool's own default. */
	toolExecutionOf(name: string): 'parallel' | 'sequential' {
		const stored = this.settings.toolExecutionByTool[name];
		if (stored) return stored;
		const tool = this.registry.entries().find((e) => e.tool.name === name)?.tool;
		return tool?.executionMode ?? 'parallel';
	}

	/**
	 * Reveals the chat and returns the view. Without `location` an open chat is reused wherever
	 * it is and a new one follows the setting; with it, a chat in the other place is moved.
	 */
	/**
	 * A phone may kill the app while the agent works. The session whose turn was running is noted
	 * on this device, so the next start opens it and lets the model finish what was asked.
	 */
	private async finishInterruptedTurn(): Promise<void> {
		const sessionId: unknown = this.app.loadLocalStorage(ACTIVE_TURN_KEY);
		if (typeof sessionId !== 'string' || !sessionId) return;
		this.app.saveLocalStorage(ACTIVE_TURN_KEY, null);
		if (this.controller.isRunning) return;
		// Peek before switching the chat: an interrupted turn is the only reason to reopen it.
		if (!hasUnfinishedTurn(replay(await this.sessions.load(sessionId)))) return;
		await this.activateView();
		await this.controller.openSession(sessionId);
		await this.controller.resumeTurn();
	}

	async activateView(location?: 'sidebar' | 'tab'): Promise<LibrarianView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_LIBRARIAN)[0] ?? null;
		if (leaf && location) {
			const inMain = leaf.getRoot() === workspace.rootSplit;
			if (inMain !== (location === 'tab')) {
				leaf.detach();
				leaf = null;
			}
		}
		if (!leaf) {
			const wanted = location ?? this.settings.chatLocation;
			leaf = wanted === 'tab' ? workspace.getLeaf('tab') : workspace.getRightLeaf(false);
			if (!leaf) return null;
			await leaf.setViewState({ type: VIEW_TYPE_LIBRARIAN, active: true });
		}
		await workspace.revealLeaf(leaf);
		const view = leaf.view instanceof LibrarianView ? leaf.view : null;
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
