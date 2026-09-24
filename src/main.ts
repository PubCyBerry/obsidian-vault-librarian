import { Notice, Plugin, type WorkspaceLeaf } from 'obsidian';
import { ACTIVE_TURN_KEY, AgentController, hasUnfinishedTurn } from './agent/agent-controller';
import { NestedAgentsMd } from './agent/nested-agents-md';
import { PromptManager, vaultReferenceReader } from './agent/prompt';
import { expandReferences } from './agent/references';
import { ContextManager } from './context/context-manager';
import { desktopHttp, openInBrowser } from './mcp/loopback';
import { apiKeySecretId, McpManager } from './mcp/mcp-manager';
import { clientSecretId, OAUTH_PROTOCOL_ACTION, serverIdFromState } from './mcp/oauth-provider';
import { SHELL_GROUP, ToolPermissionManager } from './permissions/tool-permission-manager';
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
import { createVaultTools, type ToolDeps } from './tools/registry';
import { ToolRegistry } from './tools/tool-registry';
import { DEFAULT_LISTED_TOOLS, type LibrarianSettings, mergeSettings } from './types';
import { LibrarianView, VIEW_TYPE_LIBRARIAN } from './ui/chat-view';
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
	registry!: ToolRegistry;
	controller!: AgentController;
	shell!: ShellSession;
	/** Numbers each thing the shell asks about, so concurrent approvals keep separate cards. */
	private shellActions = 0;

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
		});
		this.skills = new SkillManager(this.app);
		this.permissions.attachExtras(
			() => [
				SHELL_GROUP,
				...this.mcp.groups(),
				...(this.webdavOn() ? [WEBDAV_GROUP] : []),
				...skillGroups(this.skills.skills),
			],
			() => this.mcp.destructiveTools(),
			(tool, args) => {
				if (tool !== 'read') return null;
				const path = (args as { path?: unknown } | null)?.path;
				const skill = typeof path === 'string' ? this.skills.skillFor(path) : null;
				return skill ? skillKey(skill.name) : null;
			},
			() => this.mcp.readOnlyTools(),
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
		// A fresh client per call picks up changed settings and this device's password, and the
		// call's signal, so Stop ends it.
		const webdavClient = (signal?: AbortSignal) =>
			new WebDavClient({
				url: this.settings.webdav.url,
				username: this.settings.webdav.username,
				password: this.secrets.get(WEBDAV_SECRET_ID),
				signal,
			});
		const webdavTools = () =>
			this.webdavOn() ? createWebDavTools({ ...vaultDeps, client: webdavClient }) : [];
		const nestedAgentsMd = new NestedAgentsMd({
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
		});
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
		// Skills the model may reach: none while read is blocked, and never a blocked one.
		const usableSkills = () =>
			this.permissions.get('read') === 'blocked'
				? []
				: this.skills.skills.filter(
						(s) => this.permissions.get(skillKey(s.name)) !== 'blocked',
					);
		const deferredSkills = () =>
			usableSkills().filter((s) => this.toolDeferredOf(skillKey(s.name)));
		// Everything registered, with the execution policy from settings applied; the registry
		// decides which of these the model sees (deferred tools wait for tool_search).
		this.registry = new ToolRegistry({
			registered: () => {
				const hidden = deferredSkills();
				// Built fresh each time so descriptions carry the current default limits from settings.
				return [
					...createVaultTools(vaultDeps),
					createShellTool(this.shell),
					...webdavTools(),
					...this.mcp.tools(),
					// Only while some skill waits to be found, as tool_search for deferred tools.
					...(hidden.length ? [createSkillSearchTool(hidden)] : []),
				].map((t) => ({
					...t,
					executionMode:
						this.settings.toolExecutionByTool[t.name] ?? t.executionMode ?? 'parallel',
				}));
			},
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
			nestedAgentsMd,
			tools: () => this.registry.visible(),
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
			// Servers connect with the keys and sign-ins the sealed settings bring to this device.
			void this.secrets
				.unlock()
				.then(() => this.mcp.claimHandoffs())
				.then(() => this.mcp.connectAll());
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
		const settingTab = new LibrarianSettingTab(this.app, this);
		this.addSettingTab(settingTab);
		// Obsidian 1.13 draws the tab from its definitions and never calls display(), so the
		// tab is told here when a server's state or the skill list changes.
		this.register(this.mcp.subscribe(() => settingTab.refresh()));
		this.register(this.skills.subscribe(() => settingTab.refresh()));
		// A key that arrives sealed may be the one the chat was waiting for.
		this.register(
			this.secrets.subscribe(() => {
				settingTab.refresh();
				void this.controller.refreshReadiness();
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
		this.mcp.stopSignIns();
		for (const server of this.settings.mcpServers) void this.mcp.disconnect(server.id);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * The vault's sync brought settings another device wrote. Only what devices write for each
	 * other is taken now, the sealed secrets and the sign-ins handed over; the rest waits for the
	 * next start, as before.
	 */
	async onExternalSettingsChange() {
		const fresh = mergeSettings(await this.loadData());
		const sealedChanged = fresh.sealedSecrets !== this.settings.sealedSecrets;
		this.settings.sealedSecrets = fresh.sealedSecrets;
		this.settings.oauthHandoffs = fresh.oauthHandoffs;
		if (sealedChanged) await this.secrets.unlock();
		await this.mcp.claimHandoffs();
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
		await this.controller.refreshReadiness();
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
