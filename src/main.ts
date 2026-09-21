import { Notice, Plugin, type WorkspaceLeaf } from 'obsidian';
import { AgentController } from './agent/agent-controller';
import { PromptManager } from './agent/prompt';
import { ContextManager } from './context/context-manager';
import { McpManager } from './mcp/mcp-manager';
import { OAUTH_PROTOCOL_ACTION, serverIdFromState } from './mcp/oauth-provider';
import { ToolPermissionManager } from './permissions/tool-permission-manager';
import { ProviderManager } from './provider/provider-manager';
import { TransportRouter } from './provider/transport';
import { SessionManager } from './session/session-manager';
import { LibrarianSettingTab } from './settings/settings-tab';
import { SecretStore } from './storage/secret-store';
import { createVaultTools } from './tools/registry';
import { type LibrarianSettings, mergeSettings } from './types';
import { LibrarianView, VIEW_TYPE_LIBRARIAN } from './ui/chat-view';

export default class LibrarianPlugin extends Plugin {
	settings!: LibrarianSettings;
	secrets!: SecretStore;
	sessions!: SessionManager;
	permissions!: ToolPermissionManager;
	providers!: ProviderManager;
	transport!: TransportRouter;
	mcp!: McpManager;
	controller!: AgentController;

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
		this.permissions.attachExtras(
			() => this.mcp.groups(),
			() => this.mcp.destructiveTools(),
		);
		const vaultTools = createVaultTools({ app: this.app, settings: () => this.settings });
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
			tools: () => [...vaultTools, ...this.mcp.tools()],
		});
		this.registerObsidianProtocolHandler(OAUTH_PROTOCOL_ACTION, (params) => {
			const id = serverIdFromState(params.state);
			if (!id) return;
			if (params.error) {
				new Notice(`Sign-in failed: ${params.error_description ?? params.error}`);
				return;
			}
			if (params.code) void this.mcp.finishAuth(id, params.code);
		});
		this.app.workspace.onLayoutReady(() => void this.mcp.connectAll());

		this.registerView(VIEW_TYPE_LIBRARIAN, (leaf) => new LibrarianView(leaf, this));
		this.addRibbonIcon('book-open', 'Open chat', () => void this.activateView());
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

	/** Reveals the chat in the right sidebar (a full-screen leaf on phones) and returns the view. */
	async activateView(): Promise<LibrarianView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_LIBRARIAN)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
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
