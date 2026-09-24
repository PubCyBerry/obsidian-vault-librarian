import {
	type App,
	FuzzySuggestModal,
	Modal,
	Notice,
	Platform,
	PluginSettingTab,
	requireApiVersion,
	Setting,
	type SettingDefinitionGroup,
	type SettingDefinitionItem,
	type SettingDefinitionList,
	type SettingDefinitionRender,
	SettingGroup,
	setIcon,
	setTooltip,
	type TFile,
} from 'obsidian';
import type LibrarianPlugin from '../main';
import { apiKeySecretId, type McpStatus } from '../mcp/mcp-manager';
import { clientSecretId } from '../mcp/oauth-provider';
import {
	PERMISSION_DESCRIPTIONS,
	PERMISSION_ICONS,
	PERMISSION_LABELS,
} from '../permissions/tool-permission-manager';
import { modelFromServer } from '../provider/model-catalog';
import { type ServerModel, testConnection } from '../provider/transport';
import type { SessionSummary } from '../session/session-types';
import { SKILL_SEARCH_NAME, SKILLS_GROUP_ID, type Skill, skillKey } from '../skills/skill-manager';
import { isValidSecretId, PASSPHRASE_ID, type SecretStore } from '../storage/secret-store';
import { TOOL_SEARCH_NAME } from '../tools/tool-registry';
import {
	COMPLETIONS_API,
	MCP_SERVER_ID_PATTERN,
	type McpServerConfig,
	type ModelConfig,
	newMcpServer,
	newModel,
	newProvider,
	type ProviderCompat,
	type ProviderConfig,
	RESPONSES_API,
	THINKING_LEVELS,
	type ThinkingLevel,
	type ToolPermission,
} from '../types';
import { segment, setChecked, steadyLabel } from '../ui/segmented';
import {
	ConfirmModal,
	confirmDeleteSession,
	modalButtons,
	renameSession,
} from '../ui/session-list';
import { WEBDAV_SECRET_ID, WebDavClient } from '../webdav/webdav-client';
import { settingsFromBackup } from './backup';

const PERMISSIONS: ToolPermission[] = ['always_allow', 'approval_required', 'blocked'];

/** Every label a server row's button can show; the button is as wide as the longest. */
const MCP_BUTTON_LABELS = ['Sign in', 'Sign out', 'Add key', 'Reconnect'] as const;

/** Where a typed secret goes: this device, and the sealed settings while Device sync is on. */
function keptWhere(secrets: SecretStore): string {
	return secrets.state === 'on'
		? 'Kept on this device and sealed for your other devices.'
		: 'Kept on this device only.';
}

/** How a server holds its credentials on this device, shown beside the button that changes it. */
const MCP_BADGES = {
	signedIn: { text: 'Signed in', icon: 'user-round-check', tone: 'on' },
	signedOut: { text: 'Signed out', icon: 'user-round', tone: 'off' },
	keySaved: { text: 'Key saved', icon: 'key-round', tone: 'on' },
	noKey: { text: 'No key', icon: 'key-round', tone: 'missing' },
} as const;

const MCP_STATUS_LABELS: Record<McpStatus, string> = {
	disabled: 'Disabled',
	disconnected: 'Not connected',
	connecting: 'Connecting',
	ready: 'Connected',
	'needs-sign-in': 'Sign-in needed',
	error: 'Error',
};

/** The line under the Set all row of each tool group. */
function groupNote(groupId: string): string {
	if (groupId === 'read')
		return 'They only read the vault. A new install runs them without asking.';
	if (groupId === 'write') return 'They change notes in the vault. A new install asks first.';
	if (groupId === 'shell')
		return 'bash runs commands inside the plugin, curl and obsidian among them. A new install asks first.';
	if (groupId === 'webdav')
		return 'They reach the WebDAV storage. A new install lists and reads without asking and asks before any change.';
	return 'Tools of this server, their results marked untrusted. A new install runs the ones that only read without asking.';
}

type Row = SettingDefinitionRender;
type Section = SettingDefinitionGroup | SettingDefinitionList;

/** One navigable page of the Librarian tab, in Obsidian's declarative settings format. */
interface Page {
	name: string;
	desc: string;
	displayValue?: string;
	status?: 'warning' | null;
	items: Section[];
}

/** Lets the rows of one permission list and its Set all choice keep each other up to date. */
interface ListHooks {
	fill: () => void;
	rows: (() => void)[];
}

const listHooks = (): ListHooks => ({ fill: () => {}, rows: [] });

/** A validation message under the row on Obsidian 1.13 and later, a notice before that. */
function invalid(setting: Setting, message: string): void {
	if (requireApiVersion('1.13.0')) setting.setErrorMessage(message);
	else new Notice(message);
}

function clearError(setting: Setting): void {
	if (requireApiVersion('1.13.0')) setting.setErrorMessage(null);
}

/** Matches a list's search box against the row name and a plain-text description. */
function rowMatches(def: { name: string; desc?: unknown }, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	const desc = typeof def.desc === 'string' ? def.desc : '';
	return `${def.name}\n${desc}`.toLowerCase().includes(q);
}

/** What the editor hands back beside the server: secrets typed into it, empty when unchanged. */
interface McpSecretsTyped {
	key: string;
	clientSecret: string;
}

class McpServerEditorModal extends Modal {
	private draft: McpServerConfig;
	private readonly typed: McpSecretsTyped = { key: '', clientSecret: '' };

	constructor(
		app: App,
		private readonly plugin: LibrarianPlugin,
		private readonly existing: McpServerConfig | null,
		private readonly onSaved: (
			server: McpServerConfig,
			typed: McpSecretsTyped,
		) => Promise<void>,
	) {
		super(app);
		this.draft = existing ? { ...existing } : newMcpServer('');
	}

	onOpen() {
		const el = this.contentEl;
		el.empty();
		this.modalEl.addClass('librarian-modal');
		this.titleEl.setText(this.existing ? 'Edit MCP server' : 'Add MCP server');
		const name: Setting = new Setting(el).setName('Name').addText((t) =>
			t
				.setPlaceholder('My server')
				.setValue(this.draft.name)
				.onChange((v) => {
					this.draft.name = v;
					if (!this.existing) this.draft.id = newMcpServer(v).id;
					clearError(name);
				}),
		);
		const url: Setting = new Setting(el)
			.setName('URL')
			.setDesc('Streamable HTTP endpoint of the server, usually ending in /mcp.')
			.addText((t) =>
				t
					.setPlaceholder('https://example.com/mcp')
					.setValue(this.draft.url)
					.onChange((v) => {
						this.draft.url = v.trim();
						clearError(url);
					}),
			);
		url.settingEl.addClass('librarian-wide-input');
		const saved =
			!!this.existing && !!this.plugin.secrets.get(apiKeySecretId(this.existing.id));
		const key = new Setting(el)
			.setName('API key')
			.setDesc(keptWhere(this.plugin.secrets))
			.addText((t) => {
				t.inputEl.type = 'password';
				t.setPlaceholder(saved ? 'Saved on this device' : 'Paste the key');
				t.onChange((v) => {
					this.typed.key = v.trim();
				});
			});
		// Servers that register no apps on their own (Google) take a client made in their console.
		const clientId: Setting = new Setting(el)
			.setName('Client ID')
			.setDesc(
				"For servers that do not let apps register, such as Google's: a desktop app client from the server's console. Desktop only.",
			)
			.addText((t) =>
				t
					.setPlaceholder('Optional')
					.setValue(this.draft.oauthClientId ?? '')
					.onChange((v) => {
						this.draft.oauthClientId = v.trim() || undefined;
						clearError(clientId);
					}),
			);
		clientId.settingEl.addClass('librarian-wide-input');
		const secretSaved =
			!!this.existing && !!this.plugin.secrets.get(clientSecretId(this.existing.id));
		const clientSecret = new Setting(el)
			.setName('Client secret')
			.setDesc(keptWhere(this.plugin.secrets))
			.addText((t) => {
				t.inputEl.type = 'password';
				t.setPlaceholder(secretSaved ? 'Saved on this device' : 'Paste the secret');
				t.onChange((v) => {
					this.typed.clientSecret = v.trim();
				});
			});
		const showFor = (auth: string) => {
			key.settingEl.toggle(auth === 'apiKey');
			clientId.settingEl.toggle(auth === 'oauth');
			clientSecret.settingEl.toggle(auth === 'oauth');
		};
		new Setting(el)
			.setName('Authentication')
			.setDesc('Sign in through the browser, or paste an API key once per device.')
			.addDropdown((d) =>
				d
					.addOptions({ oauth: 'OAuth (sign in)', apiKey: 'API key', none: 'None' })
					.setValue(this.draft.auth)
					.onChange((v) => {
						this.draft.auth = v as McpServerConfig['auth'];
						showFor(v);
					}),
			);
		// The rows a choice shows belong after that choice.
		el.append(key.settingEl, clientId.settingEl, clientSecret.settingEl);
		showFor(this.draft.auth);
		const buttons = modalButtons(el, () => this.close());
		buttons
			.createEl('button', { cls: 'mod-cta', text: 'Save' })
			.addEventListener('click', () => void this.save(name, url, clientId));
	}

	private async save(name: Setting, url: Setting, clientId: Setting) {
		const trimmed = this.draft.name.trim();
		if (!trimmed) return invalid(name, 'Name is required.');
		if (!MCP_SERVER_ID_PATTERN.test(this.draft.id))
			return invalid(name, 'Name must contain a letter or digit.');
		const taken = this.plugin.settings.mcpServers.some(
			(s) => s.id === this.draft.id && s !== this.existing,
		);
		if (taken) return invalid(name, 'This name is already used.');
		if (!/^https?:\/\//.test(this.draft.url))
			return invalid(url, 'The URL must start with http or https.');
		if (this.draft.auth === 'oauth' && this.typed.clientSecret && !this.draft.oauthClientId)
			return invalid(clientId, 'A client secret needs its client ID.');
		await this.onSaved({ ...this.draft, name: trimmed }, this.typed);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

const COMPAT_FIELDS: { key: keyof ProviderCompat; label: string }[] = [
	{ key: 'supportsStore', label: 'Supports store' },
	{ key: 'supportsDeveloperRole', label: 'Supports developer role' },
	{ key: 'supportsReasoningEffort', label: 'Supports reasoning effort' },
	{ key: 'supportsUsageInStreaming', label: 'Supports usage in streaming' },
	{ key: 'supportsFinishReason', label: 'Supports finish reason' },
	{ key: 'supportsStrictMode', label: 'Supports strict mode' },
	{ key: 'requiresToolResultName', label: 'Requires tool result name' },
	{ key: 'requiresAssistantAfterToolResult', label: 'Requires assistant after tool result' },
	{ key: 'requiresThinkingAsText', label: 'Requires thinking as text' },
	{
		key: 'requiresReasoningContentOnAssistantMessages',
		label: 'Requires reasoning content on assistant messages',
	},
];

const THINKING_FORMATS = [
	'openai',
	'openrouter',
	'deepseek',
	'together',
	'baseten',
	'zai',
	'qwen',
	'chat-template',
	'qwen-chat-template',
	'string-thinking',
	'ant-ling',
];

/** The request formats Librarian speaks (LIB-FEAT-247). */
const API_LABELS: Record<string, string> = {
	[COMPLETIONS_API]: 'Chat Completions',
	[RESPONSES_API]: 'Responses',
};

function slug(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
}

function numberInput(
	setting: Setting,
	value: number | undefined,
	onChange: (v: number | undefined) => unknown,
	placeholder = '',
) {
	setting.addText((t) => {
		t.inputEl.type = 'number';
		t.setPlaceholder(placeholder);
		t.setValue(value === undefined ? '' : String(value));
		t.onChange((raw) => {
			const trimmed = raw.trim();
			if (!trimmed) return void onChange(undefined);
			const n = Number(trimmed);
			if (!Number.isNaN(n)) void onChange(n);
		});
	});
}

/** Three-state dropdown for a boolean compat flag: default, on, off. */
function triState(
	setting: Setting,
	value: boolean | undefined,
	onChange: (v: boolean | undefined) => void,
) {
	setting.addDropdown((d) => {
		d.addOption('default', 'Default');
		d.addOption('true', 'Yes');
		d.addOption('false', 'No');
		d.setValue(value === undefined ? 'default' : String(value));
		d.onChange((v) => onChange(v === 'default' ? undefined : v === 'true'));
	});
}

function renderCompat(container: HTMLElement, compat: ProviderCompat, title: string) {
	const details = container.createEl('details', { cls: 'librarian-settings-details' });
	details.createEl('summary', { text: title });
	for (const field of COMPAT_FIELDS) {
		triState(
			new Setting(details).setName(field.label),
			compat[field.key] as boolean | undefined,
			(v) => {
				if (v === undefined) delete compat[field.key];
				else (compat as Record<string, unknown>)[field.key] = v;
			},
		);
	}
	new Setting(details).setName('Max tokens field').addDropdown((d) => {
		d.addOption('default', 'Default');
		d.addOption('max_tokens', 'Legacy token limit');
		d.addOption('max_completion_tokens', 'Completion token limit');
		d.setValue(compat.maxTokensField ?? 'default');
		d.onChange((v) => {
			if (v === 'default') delete compat.maxTokensField;
			else compat.maxTokensField = v as ProviderCompat['maxTokensField'];
		});
	});
	new Setting(details).setName('Thinking format').addDropdown((d) => {
		d.addOption('default', 'Default');
		for (const f of THINKING_FORMATS) d.addOption(f, f);
		d.setValue(compat.thinkingFormat ?? 'default');
		d.onChange((v) => {
			if (v === 'default') delete compat.thinkingFormat;
			else compat.thinkingFormat = v;
		});
	});
	new Setting(details)
		.setName('Prompt cache markers')
		.setDesc(
			'Only for endpoints that need explicit cache_control markers. Leave off for local servers.',
		)
		.addDropdown((d) => {
			d.addOption('none', 'None');
			d.addOption('anthropic', 'Anthropic-style cache_control');
			d.setValue(compat.cacheControlFormat ?? 'none');
			d.onChange((v) => {
				if (v === 'none') delete compat.cacheControlFormat;
				else compat.cacheControlFormat = 'anthropic';
			});
		});
}

/** Parses a JSON object typed into a text area; empty is undefined, anything else is null. */
function jsonObject(text: string): Record<string, unknown> | undefined | null {
	if (!text.trim()) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

class ModelEditorModal extends Modal {
	private readonly draft: ModelConfig;

	constructor(
		app: App,
		model: ModelConfig | null,
		private readonly onSave: (model: ModelConfig) => void,
	) {
		super(app);
		this.draft = model ? (JSON.parse(JSON.stringify(model)) as ModelConfig) : newModel('');
	}

	onOpen() {
		this.modalEl.addClass('librarian-modal');
		this.titleEl.setText(this.draft.id ? `Edit model ${this.draft.id}` : 'Add model');
		const el = this.contentEl;
		const d = this.draft;
		const idSetting: Setting = new Setting(el)
			.setName('ID')
			.setDesc('The model ID sent to the API.')
			.addText((t) =>
				t
					.setPlaceholder('qwen3-32b')
					.setValue(d.id)
					.onChange((v) => {
						d.id = v.trim();
						clearError(idSetting);
					}),
			);
		new Setting(el).setName('Display name').addText((t) =>
			t
				.setPlaceholder('Same as the ID')
				.setValue(d.name === d.id ? '' : d.name)
				.onChange((v) => (d.name = v.trim())),
		);
		new Setting(el)
			.setName('API override')
			.setDesc('Request format for this model when it differs from the provider.')
			.addDropdown((dd) =>
				dd
					.addOption('', 'Same as the provider')
					.addOptions(API_LABELS)
					.setValue(d.api ?? '')
					.onChange((v) => (d.api = v || undefined)),
			);
		new Setting(el)
			.setName('Tool calling')
			.setDesc('Librarian only lists models that can call tools.')
			.addToggle((t) => t.setValue(d.toolCalling).onChange((v) => (d.toolCalling = v)));
		new Setting(el)
			.setName('Reasoning')
			.setDesc('Lets you pick an effort level in the chat.')
			.addToggle((t) => t.setValue(d.reasoning).onChange((v) => (d.reasoning = v)));
		new Setting(el).setName('Accepts images').addToggle((t) =>
			t.setValue(d.input.includes('image')).onChange((v) => {
				d.input = v ? ['text', 'image'] : ['text'];
			}),
		);
		numberInput(
			new Setting(el).setName('Context window').setDesc('Tokens the model can take in.'),
			d.contextWindow,
			(v) => (d.contextWindow = v ?? d.contextWindow),
		);
		numberInput(
			new Setting(el).setName('Max output tokens'),
			d.maxTokens,
			(v) => (d.maxTokens = v ?? d.maxTokens),
		);

		const thinking = el.createEl('details', { cls: 'librarian-settings-details' });
		thinking.createEl('summary', { text: 'Thinking level map' });
		thinking.createEl('p', {
			cls: 'setting-item-description',
			text: 'Provider value for each level. Empty keeps the default, "-" hides the level.',
		});
		for (const level of THINKING_LEVELS) {
			const current = d.thinkingLevelMap?.[level];
			new Setting(thinking).setName(level).addText((t) => {
				t.setPlaceholder('Default');
				t.setValue(current === null ? '-' : (current ?? ''));
				t.onChange((v) => {
					d.thinkingLevelMap = d.thinkingLevelMap ?? {};
					const trimmed = v.trim();
					if (!trimmed) delete d.thinkingLevelMap[level];
					else d.thinkingLevelMap[level] = trimmed === '-' ? null : trimmed;
				});
			});
		}

		const cost = el.createEl('details', { cls: 'librarian-settings-details' });
		cost.createEl('summary', { text: 'Cost per million tokens' });
		for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
			numberInput(new Setting(cost).setName(key), d.cost[key], (v) => (d.cost[key] = v ?? 0));
		}

		let samplingText = d.samplingParams ? JSON.stringify(d.samplingParams) : '';
		const sampling: Setting = new Setting(el)
			.setName('Sampling parameters')
			.setDesc('JSON object merged into the request body.')
			.addTextArea((t) =>
				t
					.setPlaceholder('{"top_k": 20}')
					.setValue(samplingText)
					.onChange((v) => {
						samplingText = v;
						clearError(sampling);
					}),
			);

		d.compat = d.compat ?? {};
		const compat = d.compat;
		renderCompat(el, compat, 'Compatibility override');

		// Outside the scrolling content, so Save stays in view on a long form.
		const buttons = modalButtons(this.modalEl, () => this.close());
		buttons
			.createEl('button', { cls: 'mod-cta', text: 'Save' })
			.addEventListener('click', () => {
				if (!d.id) return invalid(idSetting, 'The model needs an ID.');
				if (!d.name) d.name = d.id;
				const params = jsonObject(samplingText);
				if (params === null)
					return invalid(sampling, 'Sampling parameters must be a JSON object.');
				if (params) d.samplingParams = params;
				else delete d.samplingParams;
				if (Object.keys(compat).length === 0) delete d.compat;
				this.onSave(d);
				this.close();
			});
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** One of the models the server lists, picked by typing part of its name. */
class ServerModelModal extends FuzzySuggestModal<ServerModel> {
	constructor(
		app: App,
		private readonly models: ServerModel[],
		private readonly onPick: (model: ServerModel) => void,
	) {
		super(app);
		this.setPlaceholder('Pick a model the server lists');
	}

	getItems(): ServerModel[] {
		return this.models;
	}

	getItemText(model: ServerModel): string {
		return model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id;
	}

	onChooseItem(model: ServerModel): void {
		this.onPick(model);
	}
}

/** A JSON file in the vault to import settings from, the newest first (LIB-FEAT-241). */
class BackupFileModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly onPick: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder('Pick a settings backup');
		this.emptyStateText =
			'No JSON files in the vault. Export settings on another device first.';
	}

	getItems(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter((f) => f.extension === 'json')
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}

class ProviderEditorModal extends Modal {
	private readonly draft: ProviderConfig;
	private readonly isNew: boolean;
	private apiKeyInput = '';
	private apiKeyTouched = false;
	private modelsEl!: HTMLElement;

	constructor(
		app: App,
		private readonly plugin: LibrarianPlugin,
		provider: ProviderConfig | null,
		private readonly onSave: (provider: ProviderConfig) => Promise<void>,
	) {
		super(app);
		this.isNew = provider === null;
		this.draft = provider
			? (JSON.parse(JSON.stringify(provider)) as ProviderConfig)
			: newProvider('');
	}

	onOpen() {
		this.modalEl.addClass('librarian-modal');
		this.titleEl.setText(this.isNew ? 'Add provider' : `Edit provider ${this.draft.name}`);
		const el = this.contentEl;
		const d = this.draft;
		// A new provider's ID follows its name until the ID is typed.
		let typedId = '';
		let idText: { setPlaceholder(p: string): unknown } | null = null;
		const nameSetting: Setting = new Setting(el).setName('Name').addText((t) =>
			t
				.setPlaceholder('My server')
				.setValue(d.name)
				.onChange((v) => {
					d.name = v.trim();
					clearError(nameSetting);
					if (this.isNew && !typedId) {
						d.id = slug(d.name);
						idText?.setPlaceholder(d.id || 'my-server');
					}
				}),
		);
		if (!this.isNew) nameSetting.setDesc(`ID ${d.id}`);
		const idSetting: Setting | null = this.isNew
			? new Setting(el)
					.setName('ID')
					.setDesc(
						'Lowercase letters, digits and dashes. Sessions and the keychain name the provider by it.',
					)
					.addText((t) => {
						idText = t;
						t.setPlaceholder(d.id || 'my-server').onChange((v) => {
							typedId = v.trim();
							d.id = slug(typedId || d.name);
							if (idSetting) clearError(idSetting);
						});
					})
			: null;
		const baseUrl = new Setting(el)
			.setName('Base URL')
			.setDesc('The root of an OpenAI-compatible API, such as its /v1 address.')
			.addText((t) =>
				t
					.setPlaceholder('https://api.example.com/v1')
					.setValue(d.baseUrl)
					.onChange((v) => (d.baseUrl = v.trim())),
			);
		baseUrl.settingEl.addClass('librarian-wide-input');
		new Setting(el)
			.setName('API')
			.setDesc(
				"Request format of the endpoint. OpenAI's reasoning models call tools while they reason only through /responses.",
			)
			.addDropdown((dd) =>
				dd
					.addOptions(API_LABELS)
					.setValue(d.api === RESPONSES_API ? RESPONSES_API : COMPLETIONS_API)
					.onChange((v) => (d.api = v)),
			);
		const stored = this.plugin.secrets.get(d.secretId);
		new Setting(el)
			.setName('API key')
			.setDesc(
				stored === null
					? keptWhere(this.plugin.secrets)
					: 'Saved on this device. Type a new key to replace it.',
			)
			.addText((t) => {
				t.inputEl.type = 'password';
				t.setPlaceholder(stored === null ? 'Paste the key' : 'Saved on this device');
				t.onChange((v) => {
					this.apiKeyInput = v;
					this.apiKeyTouched = true;
				});
			});
		new Setting(el)
			.setName('Auth header')
			.setDesc('Send the key as a bearer token.')
			.addToggle((t) => t.setValue(d.authHeader).onChange((v) => (d.authHeader = v)));
		new Setting(el)
			.setName('Transport')
			.setDesc(
				'Auto streams, and waits for the whole answer when the server blocks streaming.',
			)
			.addDropdown((dd) => {
				dd.addOption('auto', 'Auto');
				dd.addOption('requestUrl', 'Non-streaming (Obsidian)');
				dd.addOption('fetch', 'Streaming (browser)');
				dd.setValue(d.transport);
				dd.onChange((v) => (d.transport = v as ProviderConfig['transport']));
			});
		new Setting(el)
			.setName('Connection')
			.setDesc('Asks the server for its models with this key.')
			.addButton((b) =>
				b.setButtonText('Test').onClick(async () => {
					const key = this.apiKeyTouched ? this.apiKeyInput.trim() : stored;
					b.setDisabled(true);
					const result = await testConnection(d, key);
					b.setDisabled(false);
					new Notice(
						result.ok
							? `Connection OK. ${result.models.length} models available.`
							: `Connection failed: ${result.message}`,
					);
				}),
			);

		renderCompat(el, d.compat, 'Compatibility');

		const req = el.createEl('details', { cls: 'librarian-settings-details' });
		req.createEl('summary', { text: 'Request defaults' });
		const r = d.requestDefaults;
		numberInput(
			new Setting(req).setName('Temperature'),
			r.temperature,
			(v) => (r.temperature = v),
			'Default',
		);
		numberInput(new Setting(req).setName('Top p'), r.topP, (v) => (r.topP = v), 'Default');
		numberInput(new Setting(req).setName('Top k'), r.topK, (v) => (r.topK = v), 'Default');
		numberInput(new Setting(req).setName('Min p'), r.minP, (v) => (r.minP = v), 'Default');
		numberInput(
			new Setting(req).setName('Max output tokens'),
			r.maxTokens,
			(v) => (r.maxTokens = v),
			'Model maximum',
		);
		new Setting(req).setName('Default thinking level').addDropdown((dd) => {
			for (const level of THINKING_LEVELS) dd.addOption(level, level);
			dd.setValue(r.thinkingLevel ?? 'off');
			dd.onChange((v) => (r.thinkingLevel = v as ThinkingLevel));
		});
		new Setting(req)
			.setName('Streaming')
			.addToggle((t) => t.setValue(r.stream !== false).onChange((v) => (r.stream = v)));
		numberInput(
			new Setting(req).setName('Timeout (ms)'),
			r.timeoutMs,
			(v) => (r.timeoutMs = v ?? 120000),
			'120000',
		);
		numberInput(
			new Setting(req).setName('Max retries'),
			r.maxRetries,
			(v) => (r.maxRetries = v ?? 2),
			'2',
		);
		let extraText = r.extraBody ? JSON.stringify(r.extraBody) : '';
		const extra: Setting = new Setting(req)
			.setName('Extra request body')
			.setDesc(
				'JSON object merged into every request. It cannot override model, messages, tools, tool_choice or stream.',
			)
			.addTextArea((t) =>
				t
					.setPlaceholder('{"chat_template_kwargs": {}}')
					.setValue(extraText)
					.onChange((v) => {
						extraText = v;
						clearError(extra);
					}),
			);

		new Setting(el)
			.setName('Models')
			.setHeading()
			.addButton((b) =>
				b.setButtonText('Add from server').onClick(async () => {
					const key = this.apiKeyTouched ? this.apiKeyInput.trim() : stored;
					b.setDisabled(true);
					const result = await testConnection(d, key);
					b.setDisabled(false);
					if (!result.ok) {
						new Notice(`Connection failed: ${result.message}`);
						return;
					}
					const added = new Set(d.models.map((m) => m.id));
					const fresh = result.models.filter((m) => !added.has(m.id));
					if (!fresh.length) {
						new Notice(
							result.models.length
								? 'Every model on the server is already added.'
								: 'The server lists no models.',
						);
						return;
					}
					new ServerModelModal(this.app, fresh, (m) => {
						d.models.push(modelFromServer(d.baseUrl, m));
						this.renderModels();
					}).open();
				}),
			)
			.addButton((b) =>
				b.setButtonText('Add model').onClick(() => {
					new ModelEditorModal(this.app, null, (model) => {
						d.models.push(model);
						this.renderModels();
					}).open();
				}),
			);
		this.modelsEl = el.createDiv({ cls: 'librarian-model-list' });
		this.renderModels();

		// Outside the scrolling content, so Save stays in view on a long form.
		const buttons = modalButtons(this.modalEl, () => this.close());
		buttons.createEl('button', { cls: 'mod-cta', text: 'Save' }).addEventListener(
			'click',
			() =>
				void (async () => {
					const idRow = idSetting ?? nameSetting;
					if (!d.name || !d.id) return invalid(nameSetting, 'The provider needs a name.');
					if (this.isNew) d.secretId = `vault-librarian-${d.id}`;
					// The id prefixes the secret id, so both follow SecretStorage's character rule.
					if (!isValidSecretId(d.id) || !isValidSecretId(d.secretId))
						return invalid(
							idRow,
							'The provider ID may only use lowercase letters, digits and dashes.',
						);
					if (this.isNew && this.plugin.settings.providers.some((p) => p.id === d.id))
						return invalid(idRow, `A provider with id ${d.id} already exists.`);
					const body = jsonObject(extraText);
					if (body === null) {
						req.open = true;
						return invalid(extra, 'Extra request body must be a JSON object.');
					}
					if (body) r.extraBody = body;
					else delete r.extraBody;
					if (this.apiKeyTouched)
						this.plugin.secrets.set(d.secretId, this.apiKeyInput.trim());
					await this.onSave(d);
					this.close();
				})(),
		);
	}

	private renderModels() {
		this.modelsEl.empty();
		if (!this.draft.models.length)
			new Setting(this.modelsEl).setDesc(
				'No models yet. Add them from the list the server gives, or by ID.',
			);
		this.draft.models.forEach((model, i) => {
			new Setting(this.modelsEl)
				.setName(model.name || model.id)
				.setDesc(
					`${model.id}, ${model.contextWindow.toLocaleString('en-US')} context, ${model.toolCalling ? 'tools' : 'no tools'}${model.input.includes('image') ? ', images' : ''}`,
				)
				.addExtraButton((b) =>
					b
						.setIcon('pencil')
						.setTooltip('Edit')
						.onClick(() => {
							new ModelEditorModal(this.app, model, (updated) => {
								this.draft.models[i] = updated;
								this.renderModels();
							}).open();
						}),
				)
				.addExtraButton((b) =>
					b
						.setIcon('trash-2')
						.setTooltip('Delete')
						.onClick(() => {
							this.draft.models.splice(i, 1);
							this.renderModels();
						}),
				);
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * The Librarian tab. On Obsidian 1.13 and later it is a set of pages in the declarative settings
 * format, so every row, group and list looks and behaves like Obsidian's own settings, on a phone
 * too. Earlier versions draw the same definitions into one scrolling tab.
 */
export class LibrarianSettingTab extends PluginSettingTab {
	/** Whether rows show their execution and listing choices. Not saved: off after a restart. */
	private showAdvanced = false;
	/** Sessions for the Sessions page, read when that page is drawn; null until then. */
	private sessionList: SessionSummary[] | null = null;

	constructor(
		app: App,
		private readonly plugin: LibrarianPlugin,
	) {
		super(app, plugin);
		this.icon = 'book-open';
	}

	/** Only Obsidian before 1.13 calls this; later versions draw getSettingDefinitions(). */
	display(): void {
		this.renderLegacy();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		// Each page is one navigable entry; eight of them stacked on one page ran past 7,000 px.
		return this.pages().map((page) => ({ type: 'page' as const, ...page }));
	}

	/** Redraws after a change that adds or removes rows, or that a page entry summarizes. */
	refresh(): void {
		if (requireApiVersion('1.13.0')) this.update();
		else if (this.containerEl.isConnected) this.renderLegacy();
	}

	private pages(): Page[] {
		return [
			this.providersPage(),
			this.agentPage(),
			this.mcpPage(),
			this.webdavPage(),
			this.deviceSyncPage(),
			this.skillsPage(),
			this.permissionsPage(),
			this.contextPage(),
			this.sessionsPage(),
		];
	}

	/** The same definitions as the pages, drawn in one tab with SettingGroup (Obsidian 1.11). */
	private renderLegacy(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const page of this.pages()) {
			new Setting(containerEl).setName(page.name).setHeading();
			for (const section of page.items) {
				const shown =
					typeof section.visible === 'function' ? section.visible() : section.visible;
				if (shown === false) continue;
				const group = new SettingGroup(containerEl);
				if (section.heading) group.setHeading(section.heading);
				for (const button of section.extraButtons ?? []) group.addExtraButton(button);
				const list = section.type === 'list' ? (section as SettingDefinitionList) : null;
				const add = list?.addItem;
				if (add)
					group.addExtraButton((b) =>
						b
							.setIcon('plus')
							.setTooltip(add.name)
							.onClick(() => add.action(b.extraSettingsEl)),
					);
				const rows = (section.items ?? []) as Row[];
				const empty = list?.emptyState;
				if (!rows.length && empty)
					group.addSetting((s) => {
						s.setDesc(empty);
					});
				for (const row of rows)
					group.addSetting((s) => {
						s.setName(row.name);
						if (row.desc) s.setDesc(row.desc);
						row.render(s, group);
					});
			}
		}
	}

	private async save() {
		await this.plugin.saveSettings();
		await this.plugin.controller.recalculateUsage();
	}

	// Providers

	private providersPage(): Page {
		const s = this.plugin.settings;
		const selectable = this.plugin.providers.listSelectable();
		const active = selectable.find(
			({ provider, model }) =>
				provider.id === s.activeProviderId && model.id === s.activeModelId,
		);
		const keyMissing = (p: ProviderConfig) =>
			p.authHeader && this.plugin.secrets.get(p.secretId) === null;
		const many = new Set(selectable.map((o) => o.provider.id)).size > 1;
		const defaultModel: Row = {
			name: 'Default model',
			desc: selectable.length
				? 'Used for new sessions.'
				: 'Add a model that can call tools to a provider first.',
			aliases: ['Model'],
			render: (setting) => {
				if (!selectable.length) return;
				setting.addDropdown((d) => {
					if (!active) d.addOption('', 'Choose a model');
					for (const { provider, model } of selectable)
						d.addOption(
							`${provider.id}\u0000${model.id}`,
							many ? `${model.name} (${provider.name})` : model.name,
						);
					d.setValue(active ? `${active.provider.id}\u0000${active.model.id}` : '');
					d.onChange(async (v) => {
						const [providerId, modelId] = v.split('\u0000');
						if (!providerId || !modelId) return;
						s.activeProviderId = providerId;
						s.activeModelId = modelId;
						await this.save();
						this.refresh();
					});
				});
			},
		};
		return {
			name: 'Providers',
			desc: 'Endpoints, API keys and the models Librarian may use.',
			displayValue: active?.model.name ?? '',
			status:
				s.providers.length && (!active || keyMissing(active.provider)) ? 'warning' : null,
			items: [
				{ type: 'group', visible: s.providers.length > 0, items: [defaultModel] },
				{
					type: 'list',
					heading: 'Providers',
					addItem: { name: 'Add provider', action: () => this.editProvider(null) },
					emptyState: 'Add an OpenAI-compatible server to start.',
					items: s.providers.map(
						(provider): Row => ({
							name: provider.name,
							desc: `${provider.baseUrl || 'No base URL'}, ${provider.models.length} ${provider.models.length === 1 ? 'model' : 'models'}`,
							aliases: ['API key', 'Base URL', 'Transport', 'Compatibility'],
							render: (setting) => {
								if (keyMissing(provider))
									setting.descEl.createDiv({
										cls: 'librarian-setting-warning',
										text: 'No API key on this device',
									});
								setting
									.addExtraButton((b) =>
										b
											.setIcon('pencil')
											.setTooltip('Edit')
											.onClick(() => this.editProvider(provider)),
									)
									.addExtraButton((b) =>
										b
											.setIcon('trash-2')
											.setTooltip('Delete')
											.onClick(() => this.deleteProvider(provider)),
									);
							},
						}),
					),
				},
			],
		};
	}

	private editProvider(provider: ProviderConfig | null) {
		const s = this.plugin.settings;
		new ProviderEditorModal(this.app, this.plugin, provider, async (saved) => {
			const i = provider ? s.providers.indexOf(provider) : -1;
			if (i >= 0) s.providers[i] = saved;
			else s.providers.push(saved);
			const firstModel = saved.models.find((m) => m.toolCalling);
			if (!s.activeProviderId && firstModel) {
				s.activeProviderId = saved.id;
				s.activeModelId = firstModel.id;
			}
			await this.save();
			this.refresh();
		}).open();
	}

	private deleteProvider(provider: ProviderConfig) {
		const s = this.plugin.settings;
		new ConfirmModal(
			this.app,
			`Delete provider ${provider.name}?`,
			(el) =>
				el.createEl('p', {
					text: 'Its API key on this device is cleared. Sessions that used it are kept.',
				}),
			'Delete',
			async () => {
				this.plugin.secrets.clear(provider.secretId);
				s.providers.splice(s.providers.indexOf(provider), 1);
				if (s.activeProviderId === provider.id) {
					s.activeProviderId = null;
					s.activeModelId = null;
				}
				await this.save();
				this.refresh();
			},
		).open();
	}

	// Agent

	private agentPage(): Page {
		const s = this.plugin.settings;
		const agentsMdDesc =
			'Follow AGENTS.md at the vault root, and the AGENTS.md of each folder the agent reaches in the vault or on the WebDAV storage.';
		return {
			name: 'Agent',
			desc: 'Tool iterations, vault instructions and where the chat opens.',
			items: [
				{
					type: 'group',
					heading: 'Agent loop',
					items: [
						{
							name: 'Max tool iterations',
							desc: 'Turns with tool calls before the agent stops and waits for you.',
							render: (setting) =>
								numberInput(
									setting,
									s.maxIterations > 0 ? s.maxIterations : undefined,
									async (v) => {
										s.maxIterations =
											v !== undefined && v > 0 ? Math.floor(v) : 0;
										await this.save();
									},
									'No limit',
								),
						},
						{
							name: 'Repeated failure limit',
							desc: 'Stop when the same tool call fails this many times.',
							render: (setting) =>
								numberInput(
									setting,
									s.repeatedFailureLimit,
									async (v) => {
										s.repeatedFailureLimit = v ?? 3;
										await this.save();
									},
									'3',
								),
						},
						{
							name: 'Tool execution',
							desc: 'How the calls in one response run. A batch with a sequential tool in it runs one call at a time; each tool can be set under Tool permissions.',
							render: (setting) =>
								void setting.addDropdown((d) =>
									d
										.addOptions({
											parallel: 'Parallel',
											sequential: 'Sequential',
										})
										.setValue(s.toolExecution)
										.onChange(async (v) => {
											s.toolExecution =
												v === 'sequential' ? 'sequential' : 'parallel';
											await this.save();
										}),
								),
						},
					],
				},
				{
					type: 'group',
					heading: 'Instructions',
					items: [
						{
							name: 'Use AGENTS.md',
							desc: this.app.vault.getFileByPath('AGENTS.md')
								? agentsMdDesc
								: `${agentsMdDesc} No AGENTS.md at the vault root.`,
							render: (setting) =>
								void setting.addToggle((t) =>
									t.setValue(s.useVaultAgentsMd).onChange(async (v) => {
										s.useVaultAgentsMd = v;
										await this.save();
									}),
								),
						},
						{
							name: 'Custom system prompt',
							desc: 'Your own instructions. They come after the built-in instructions and the vault root AGENTS.md.',
							render: (setting) => {
								setting.settingEl.addClass('librarian-prompt-setting');
								setting.addTextArea((t) => {
									t.inputEl.rows = 6;
									t.setPlaceholder(
										'For example: Keep answers short and cite the notes you read.',
									);
									t.setValue(s.customSystemPrompt).onChange(async (v) => {
										s.customSystemPrompt = v;
										await this.save();
									});
								});
							},
						},
					],
				},
				{
					type: 'group',
					heading: 'Chat',
					items: [
						{
							name: 'Open chat in',
							desc: 'Where a new chat opens. An open chat stays where it is.',
							render: (setting) =>
								void setting.addDropdown((d) =>
									d
										.addOptions({ sidebar: 'Right sidebar', tab: 'Main area' })
										.setValue(s.chatLocation)
										.onChange(async (v) => {
											s.chatLocation = v === 'tab' ? 'tab' : 'sidebar';
											await this.save();
										}),
								),
						},
						{
							name: 'Commands folder',
							desc: 'Each note in it becomes a /name command. $ARGUMENTS takes the rest of the line.',
							render: (setting) =>
								void setting.addText((t) =>
									t
										.setPlaceholder('Librarian/commands')
										.setValue(s.commandsFolder)
										.onChange(async (v) => {
											s.commandsFolder = v.trim().replace(/^\/+|\/+$/g, '');
											await this.save();
										}),
								),
						},
					],
				},
			],
		};
	}

	// MCP servers

	private mcpPage(): Page {
		const servers = this.plugin.settings.mcpServers;
		const mcp = this.plugin.mcp;
		const troubled = servers.some(
			(server) =>
				server.enabled && ['needs-sign-in', 'error'].includes(mcp.state(server.id).status),
		);
		return {
			name: 'MCP servers',
			desc: 'Remote tool servers and how you sign in to them.',
			displayValue: servers.length
				? `${servers.length} ${servers.length === 1 ? 'server' : 'servers'}`
				: '',
			status: troubled ? 'warning' : null,
			items: [
				{
					type: 'list',
					heading: 'Servers',
					addItem: { name: 'Add server', action: () => this.editMcpServer(null) },
					emptyState:
						'No servers yet. Their tools ask first, and their results are marked untrusted.',
					// The order is also the order of their tool permission groups.
					onReorder: (from, to) => {
						const [moved] = servers.splice(from, 1);
						if (!moved) return;
						servers.splice(to, 0, moved);
						void this.save().then(() => this.refresh());
					},
					items: servers.map((server) => this.mcpServerRow(server)),
				},
			],
		};
	}

	private mcpServerRow(server: McpServerConfig): Row {
		const mcp = this.plugin.mcp;
		return {
			name: server.name,
			desc: server.url,
			aliases: ['MCP', 'OAuth', 'Sign in', 'API key'],
			render: (setting) => {
				setting.settingEl.addClass('librarian-mcp-server');
				const state = mcp.state(server.id);
				const label = MCP_STATUS_LABELS[state.status];
				// A reason says more than the state it explains, such as a missing key.
				const text =
					state.status === 'ready'
						? `${label}, ${state.tools.length} tools`
						: state.status === 'error'
							? `${label}: ${state.message ?? 'unknown'}`
							: state.status === 'needs-sign-in'
								? (state.message ?? label)
								: label;
				setting.descEl.createDiv({ cls: `librarian-mcp-status is-${state.status}`, text });
				if (mcp.handoffPending(server.id))
					setting.descEl.createDiv({
						cls: 'librarian-mcp-status is-handoff',
						text: 'A sign-in waits for your phone or tablet to take it.',
					});
				setting.addToggle((t) =>
					t
						.setTooltip('Enabled')
						.setValue(server.enabled)
						.onChange(async (v) => {
							server.enabled = v;
							await this.save();
							await mcp.connect(server.id);
							this.refresh();
						}),
				);
				// The button follows the saved sign-in, not the connection, so turning a server off
				// and on never looks like a sign-out, and a server that lists its tools without a
				// token (Google) is not shown as signed in.
				const signedIn = mcp.signedIn(server.id);
				const keyMissing =
					server.auth === 'apiKey' && !this.plugin.secrets.get(apiKeySecretId(server.id));
				// The button names what it does; this badge names what is, so Sign in and Sign out
				// never have to be read to know where a server stands (LIB-FEAT-228).
				const badge =
					server.auth === 'oauth'
						? signedIn
							? MCP_BADGES.signedIn
							: MCP_BADGES.signedOut
						: server.auth === 'apiKey'
							? keyMissing
								? MCP_BADGES.noKey
								: MCP_BADGES.keySaved
							: null;
				// A row without a badge or a button keeps their room, so every row's controls line up.
				const shown = badge ?? MCP_BADGES.signedOut;
				const el = setting.controlEl.createDiv({
					cls: `librarian-mcp-auth is-${shown.tone}`,
					attr: badge
						? { role: 'img', 'aria-label': badge.text }
						: { 'aria-hidden': 'true' },
				});
				el.toggleClass('librarian-mcp-spacer', !badge);
				setIcon(el.createSpan({ cls: 'librarian-mcp-auth-icon' }), shown.icon);
				steadyLabel(
					el.createSpan(),
					Object.values(MCP_BADGES).map((b) => b.text),
					shown.text,
				);
				if (!server.enabled && !signedIn)
					setting.addButton((b) => {
						steadyLabel(b.buttonEl, MCP_BUTTON_LABELS, 'Sign in');
						b.buttonEl.addClass('librarian-mcp-spacer');
						b.buttonEl.setAttrs({ 'aria-hidden': 'true', tabindex: '-1' });
					});
				else {
					// A server that will not register this app gets Reconnect: Sign in would fail the same way.
					const oauth = server.auth === 'oauth' && !state.signInBlocked;
					const label = signedIn
						? 'Sign out'
						: oauth
							? 'Sign in'
							: keyMissing
								? 'Add key'
								: 'Reconnect';
					setting.addButton((b) => {
						steadyLabel(b.buttonEl, MCP_BUTTON_LABELS, label);
						// Only the step the server waits for is accented; Sign out stays quiet.
						if (label === 'Sign in' || label === 'Add key') b.setCta();
						b.onClick(async () => {
							if (signedIn) await mcp.signOut(server.id);
							else if (keyMissing) return this.editMcpServer(server);
							else if (oauth) await mcp.signIn(server.id);
							else await mcp.connect(server.id);
							this.refresh();
						});
					});
				}
				// Only a desktop can sign in through 127.0.0.1, so only it makes sign-ins for the
				// others; rows without one keep its room so the icons line up (LIB-FEAT-234).
				if (Platform.isDesktopApp)
					setting.addExtraButton((b) => {
						if (server.auth !== 'oauth') {
							b.extraSettingsEl.addClass('librarian-mcp-spacer');
							b.extraSettingsEl.setAttr('aria-hidden', 'true');
							b.extraSettingsEl.removeAttribute('tabindex');
							return;
						}
						b.setIcon('smartphone')
							.setTooltip('Sign in for a mobile device')
							.onClick(async () => {
								await mcp.signInForDevice(server.id);
								this.refresh();
							});
					});
				setting
					.addExtraButton((b) =>
						b
							.setIcon('pencil')
							.setTooltip('Edit')
							.onClick(() => this.editMcpServer(server)),
					)
					.addExtraButton((b) =>
						b
							.setIcon('trash-2')
							.setTooltip('Remove')
							.onClick(() =>
								new ConfirmModal(
									this.app,
									`Remove MCP server ${server.name}?`,
									(el) =>
										el.createEl('p', {
											text: 'Its sign-in and its tool permissions are removed too.',
										}),
									'Remove',
									async () => {
										await mcp.remove(server.id);
										await this.plugin.controller.recalculateUsage();
										this.refresh();
									},
								).open(),
							),
					);
			},
		};
	}

	private editMcpServer(existing: McpServerConfig | null) {
		const mcp = this.plugin.mcp;
		new McpServerEditorModal(this.app, this.plugin, existing, async (saved, typed) => {
			if (existing) Object.assign(existing, saved);
			else this.plugin.settings.mcpServers.push(saved);
			if (typed.key && saved.auth === 'apiKey')
				this.plugin.secrets.set(apiKeySecretId(saved.id), typed.key);
			if (typed.clientSecret && saved.auth === 'oauth')
				this.plugin.secrets.set(clientSecretId(saved.id), typed.clientSecret);
			// A secret without its client is of no use and must not linger on the device.
			if (!saved.oauthClientId) this.plugin.secrets.clear(clientSecretId(saved.id));
			await this.save();
			await mcp.connect(saved.id);
			this.refresh();
		}).open();
	}

	// Device sync

	/**
	 * The sync passphrase. With it the fixed secrets travel sealed in the settings, and a desktop
	 * can hand MCP sign-ins to a phone or tablet (LIB-FEAT-233, LIB-FEAT-234).
	 */
	private deviceSyncPage(): Page {
		const secrets = this.plugin.secrets;
		const state = secrets.state;
		const waiting = state === 'off' && secrets.hasBundle();
		const status =
			state === 'on'
				? `${secrets.usesSharedPassphrase ? 'On with the Google Calendar Tasks Sync passphrase of this device' : 'On'}, ${secrets.sealedCount()} sealed`
				: state === 'locked'
					? 'Locked: this passphrase does not open what another device sealed.'
					: waiting
						? 'Another device sealed keys here. Enter its passphrase to use them.'
						: 'Off';
		let pending = '';
		return {
			name: 'Device sync',
			desc: 'Keys and sign-ins for your other devices, and a settings backup.',
			displayValue: state === 'on' ? 'On' : state === 'locked' ? 'Locked' : 'Off',
			status: state === 'locked' || waiting ? 'warning' : null,
			items: [
				{
					type: 'group',
					items: [
						{
							name: 'Sync passphrase',
							desc: "API keys, the WebDAV password and client secrets are sealed with it into this plugin's data file, which your vault's sync carries to your other devices. Enter the same one once on each device.",
							aliases: ['Passphrase', 'Sync', 'Devices', 'Keychain'],
							render: (setting) => {
								setting.setClass('librarian-secret-input');
								setting.descEl.createDiv({
									cls: `librarian-sync-status is-${waiting ? 'waiting' : state}`,
									text: status,
								});
								setting
									.addText((t) => {
										t.inputEl.type = 'password';
										t.setPlaceholder(
											this.app.secretStorage.getSecret(PASSPHRASE_ID)
												? 'Saved on this device'
												: 'Passphrase',
										);
										t.onChange((v) => {
											pending = v;
										});
									})
									.addButton((b) =>
										b.setButtonText('Save').onClick(async () => {
											if (!pending) return;
											// Deriving the key takes a moment, longer on a phone.
											b.setDisabled(true);
											const result = await secrets.setPassphrase(pending);
											new Notice(
												result === 'locked'
													? 'This passphrase does not open what another device sealed.'
													: 'Keys and client secrets are sealed with this passphrase.',
											);
											await this.plugin.mcp.claimHandoffs();
											this.refresh();
										}),
									);
							},
						},
						{
							name: 'Sign-ins',
							desc: 'A sign-in to an MCP server stays on the device that made it. On desktop, Sign in for a mobile device on a server makes one more for a phone or tablet, which takes it when it opens with the same passphrase.',
							aliases: ['OAuth', 'Mobile', 'Phone', 'Tablet'],
							render: () => {},
						},
					],
				},
				{
					type: 'group',
					heading: 'Backup',
					items: [
						{
							name: 'Export settings',
							desc: 'Writes every setting to a JSON file at the top of the vault. Keys go in sealed with the sync passphrase, so only a device with the same passphrase opens them. MCP sign-ins and chat history are not included.',
							aliases: ['Backup', 'Export', 'Save settings'],
							render: (setting) => {
								setting.addButton((b) =>
									b.setButtonText('Export').onClick(async () => {
										const path = await this.plugin.exportSettings();
										new Notice(
											secrets.state === 'on'
												? `Settings exported to ${path}, with the keys sealed.`
												: `Settings exported to ${path}. The keys of this device are not in it: set a sync passphrase first to include them.`,
										);
									}),
								);
							},
						},
						{
							name: 'Import settings',
							desc: 'Replaces every setting on this device with an exported file.',
							aliases: ['Backup', 'Import', 'Restore'],
							render: (setting) => {
								setting.addButton((b) =>
									b
										.setButtonText('Import')
										.onClick(() =>
											new BackupFileModal(
												this.app,
												(file) => void this.importFrom(file),
											).open(),
										),
								);
							},
						},
					],
				},
			],
		};
	}

	/** Checks the file, asks before replacing everything, then says what came back (LIB-FEAT-241). */
	private async importFrom(file: TFile): Promise<void> {
		const next = settingsFromBackup(await this.app.vault.read(file));
		if ('error' in next) {
			new Notice(next.error);
			return;
		}
		new ConfirmModal(
			this.app,
			'Import settings?',
			(el) => {
				el.createEl('p', {
					text: `Every setting on this device is replaced with the ones in ${file.name}.`,
				});
				el.createEl('p', {
					text: 'Server sign-ins are not in it. Sign in again, or on a phone take one from the desktop.',
				});
			},
			'Import',
			async () => {
				await this.plugin.importSettings(next);
				const state = this.plugin.secrets.state;
				new Notice(
					!next.sealedSecrets
						? 'Settings imported. They held no keys, so enter them again.'
						: state === 'on'
							? 'Settings imported, with their keys.'
							: 'Settings imported. Enter the sync passphrase they were exported with under Device sync to bring back the keys.',
				);
				this.refresh();
			},
		).open();
	}

	// WebDAV storage

	/** One WebDAV storage. The password goes to this device's SecretStorage only. */
	private webdavPage(): Page {
		const w = this.plugin.settings.webdav;
		const saved = !!this.plugin.secrets.get(WEBDAV_SECRET_ID);
		let pending = '';
		return {
			name: 'WebDAV storage',
			desc: 'One WebDAV server, such as a NAS, the agent may reach.',
			displayValue: w.enabled ? 'On' : 'Off',
			status: w.enabled && (!w.url.trim() || (!!w.username && !saved)) ? 'warning' : null,
			items: [
				{
					type: 'group',
					items: [
						{
							name: 'Enabled',
							desc: 'The agent reaches these files through the WebDAV tools, on desktop and phone.',
							aliases: ['WebDAV', 'NAS', 'Synology', 'Remote storage'],
							render: (setting) =>
								void setting.addToggle((t) =>
									t.setValue(w.enabled).onChange(async (v) => {
										w.enabled = v;
										await this.save();
										// The storage group under Tool permissions comes and goes with this.
										this.refresh();
									}),
								),
						},
						{
							name: 'URL',
							desc: 'Address of the folder the agent may reach. Storage paths start here.',
							render: (setting) => {
								setting.settingEl.addClass('librarian-wide-input');
								setting.addText((t) =>
									t
										.setPlaceholder('https://nas.example.com/webdav')
										.setValue(w.url)
										.onChange(async (v) => {
											w.url = v.trim();
											await this.save();
										}),
								);
							},
						},
						{
							name: 'User name',
							render: (setting) =>
								void setting.addText((t) =>
									t
										.setPlaceholder('Optional')
										.setValue(w.username)
										.onChange(async (v) => {
											w.username = v.trim();
											await this.save();
										}),
								),
						},
						{
							name: 'Password',
							desc: keptWhere(this.plugin.secrets),
							render: (setting) =>
								void setting
									.setClass('librarian-secret-input')
									.addText((t) => {
										t.inputEl.type = 'password';
										t.setPlaceholder(
											saved
												? 'Saved on this device'
												: 'Not saved on this device',
										);
										t.onChange((v) => {
											pending = v;
										});
									})
									.addButton((b) =>
										b.setButtonText('Save').onClick(() => {
											if (!pending) return;
											this.plugin.secrets.set(WEBDAV_SECRET_ID, pending);
											new Notice('Password saved on this device.');
											this.refresh();
										}),
									),
						},
						{
							name: 'Connection',
							desc: 'Checks the address, the user name and the password.',
							render: (setting) =>
								void setting.addButton((b) =>
									b.setButtonText('Test').onClick(async () => {
										b.setDisabled(true);
										try {
											const client = new WebDavClient({
												url: w.url,
												username: w.username,
												password: this.plugin.secrets.get(WEBDAV_SECRET_ID),
											});
											new Notice(
												(await client.stat(''))
													? 'Connected to the storage.'
													: 'Not found: /',
											);
										} catch (error) {
											new Notice(
												error instanceof Error
													? error.message
													: String(error),
											);
										} finally {
											b.setDisabled(false);
										}
									}),
								),
						},
					],
				},
			],
		};
	}

	// Skills

	/** Found skills, each with its permission and, when asked, its listing. */
	private skillsPage(): Page {
		const { skills, diagnostics } = this.plugin.skills;
		const hooks = listHooks();
		const sections: Section[] = [];
		if (skills.length)
			sections.push({
				type: 'group',
				items: [
					this.bulkRow(
						SKILLS_GROUP_ID,
						'All skills',
						'A new skill asks first, and the model finds it with skill_search.',
						hooks,
					),
					this.advancedRow(
						'Listing',
						'Choose for each skill whether the model sees it upfront or finds it with skill_search.',
					),
				],
			});
		sections.push({
			type: 'list',
			heading: 'Found skills',
			extraButtons: [
				(b) =>
					b
						.setIcon('refresh-cw')
						.setTooltip('Rescan')
						// The skill manager announces the new list, which redraws the page.
						.onClick(() => void this.plugin.skills.scan()),
			],
			...(skills.length > 5
				? { search: { placeholder: 'Search skills', match: rowMatches } }
				: {}),
			emptyState:
				'No skills found. A skill is a folder with a SKILL.md, inside a folder named .agents/skills at the vault root or in any folder. Rescan after adding one.',
			items: skills.map((skill) => this.skillRow(skill, hooks)),
		});
		if (diagnostics.length)
			sections.push({
				type: 'group',
				heading: 'Problems',
				items: diagnostics.map(
					(d): Row => ({
						name: d.location,
						desc: d.message,
						render: (setting) => setting.settingEl.addClass('librarian-skill-problem'),
					}),
				),
			});
		return {
			name: 'Skills',
			desc: 'SKILL.md folders, and what each skill may do.',
			displayValue: `${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}`,
			status: diagnostics.length ? 'warning' : null,
			items: sections,
		};
	}

	/** Name with the skill icon the chat chips use, the description, then the path on its own line. */
	private skillRow(skill: Skill, hooks: ListHooks): Row {
		const key = skillKey(skill.name);
		return {
			name: skill.name,
			desc: skill.description,
			aliases: [skill.location],
			render: (setting) => {
				setting.settingEl.addClass('librarian-skill');
				const icon = createSpan({ cls: 'librarian-skill-icon' });
				setIcon(icon, 'sparkles');
				setting.nameEl.prepend(icon);
				const path = setting.descEl.createDiv({ cls: 'librarian-skill-path' });
				setIcon(path.createSpan({ cls: 'librarian-skill-path-icon' }), 'folder');
				// A narrow pane wraps the path after a slash rather than inside a folder name.
				const text = path.createSpan();
				for (const [i, part] of skill.location.split('/').entries()) {
					if (i > 0) {
						text.appendText('/');
						text.createEl('wbr');
					}
					text.appendText(part);
				}
				if (this.showAdvanced) this.listingSelect(setting, key);
				this.permissionControl(setting, key, hooks);
			},
		};
	}

	// Tool permissions

	private permissionsPage(): Page {
		const perms = this.plugin.permissions;
		const labels = this.toolLabels();
		const sections: Section[] = [
			{
				type: 'group',
				items: [
					this.advancedRow(
						'Execution and listing',
						'Show how each tool runs, and whether the model sees it upfront or finds it with tool_search.',
					),
				],
			},
		];
		for (const group of perms.groups()) {
			// Skills have their own page.
			if (group.id === SKILLS_GROUP_ID) continue;
			const hooks = listHooks();
			sections.push({
				type: 'list',
				heading: group.label,
				emptyState: 'Its tools show here once the server connects.',
				items: group.tools.length
					? [
							this.bulkRow(group.id, 'Set all', groupNote(group.id), hooks),
							...group.tools.map((tool) =>
								this.toolRow(tool, labels.get(tool) ?? tool, hooks),
							),
						]
					: [],
			});
		}
		return {
			name: 'Tool permissions',
			desc: 'What each tool may do without asking.',
			items: sections,
		};
	}

	/**
	 * What the chat's tool cards call each tool. An MCP tool drops its server's name, which its
	 * group heading already shows.
	 */
	private toolLabels(): Map<string, string> {
		const labels = new Map<string, string>([
			[TOOL_SEARCH_NAME, 'Find tools'],
			[SKILL_SEARCH_NAME, 'Find skills'],
		]);
		for (const { tool } of this.plugin.registry.entries()) {
			const server = this.plugin.settings.mcpServers.find((s) =>
				tool.name.startsWith(`${s.id}__`),
			);
			const prefix = server ? `${server.name}: ` : '';
			labels.set(
				tool.name,
				prefix && tool.label.startsWith(prefix)
					? tool.label.slice(prefix.length)
					: tool.label,
			);
		}
		return labels;
	}

	private toolRow(tool: string, label: string, hooks: ListHooks): Row {
		return {
			name: label,
			desc: label === tool ? '' : tool,
			aliases: [tool],
			render: (setting) => {
				setting.settingEl.addClass('librarian-tool-row');
				if (this.showAdvanced) {
					this.executionSelect(setting, tool);
					// The two searches are how deferred things are found, so they are always listed.
					if (tool !== TOOL_SEARCH_NAME && tool !== SKILL_SEARCH_NAME)
						this.listingSelect(setting, tool);
				}
				this.permissionControl(setting, tool, hooks);
			},
		};
	}

	/** First row of a permission list: one choice for every row in it, Mixed when they differ. */
	private bulkRow(groupId: string, name: string, desc: string, hooks: ListHooks): Row {
		const perms = this.plugin.permissions;
		return {
			name,
			desc,
			render: (setting) => {
				setting.settingEl.addClass('librarian-bulk-row');
				setting.addDropdown((d) => {
					d.selectEl.setAttr('aria-label', `${name} permission`);
					const fill = () => {
						const display = perms.getGroupDisplay(groupId);
						d.selectEl.empty();
						if (display === 'mixed')
							d.selectEl.createEl('option', {
								value: 'mixed',
								text: 'Mixed',
								attr: { disabled: 'true' },
							});
						for (const p of PERMISSIONS) d.addOption(p, PERMISSION_LABELS[p]);
						d.setValue(display);
					};
					fill();
					hooks.fill = fill;
					d.onChange(async (v) => {
						if (v === 'mixed') return;
						await perms.setGroup(groupId, v as ToolPermission);
						for (const refresh of hooks.rows) refresh();
						fill();
						await this.plugin.controller.recalculateUsage();
					});
				});
			},
		};
	}

	/** Shows or hides the execution and listing choices; one switch for this page and the other. */
	private advancedRow(name: string, desc: string): Row {
		return {
			name,
			desc,
			render: (setting) =>
				void setting.addToggle((t) =>
					t.setValue(this.showAdvanced).onChange((v) => {
						this.showAdvanced = v;
						this.refresh();
					}),
				),
		};
	}

	/** Three icon radios: Always allow, Ask first, Blocked. The tooltip names each and says what it does. */
	private permissionControl(setting: Setting, key: string, hooks: ListHooks) {
		const perms = this.plugin.permissions;
		const group = setting.controlEl.createDiv({
			cls: 'librarian-segmented',
			attr: { role: 'radiogroup', 'aria-label': `${key} permission` },
		});
		const options = PERMISSIONS.map((p) => {
			const locked = p === 'always_allow' && !perms.canAlwaysAllow(key);
			const why = locked
				? 'The server marks this tool destructive.'
				: PERMISSION_DESCRIPTIONS[p];
			const el = segment(
				group,
				PERMISSION_LABELS[p],
				() =>
					void (async () => {
						await perms.setTool(key, p);
						refresh();
						hooks.fill();
						// No hover on a phone or tablet: the tap itself shows what the icon means.
						if (Platform.isMobile) new Notice(`${PERMISSION_LABELS[p]}: ${why}`);
						await this.plugin.controller.recalculateUsage();
					})(),
			);
			setIcon(el, PERMISSION_ICONS[p]);
			setTooltip(el, `${PERMISSION_LABELS[p]}\n${why}`, { classes: ['librarian-tooltip'] });
			if (locked) {
				el.addClass('is-disabled');
				el.setAttr('aria-disabled', 'true');
			}
			return { p, el };
		});
		const refresh = () => {
			const current = perms.get(key);
			for (const { p, el } of options) setChecked(el, p === current);
		};
		refresh();
		hooks.rows.push(refresh);
	}

	private executionSelect(setting: Setting, tool: string) {
		setting.addDropdown((d) => {
			d.selectEl.addClass('librarian-tool-execution');
			d.selectEl.setAttr('aria-label', `${tool} execution`);
			d.addOptions({ parallel: 'Parallel', sequential: 'Sequential' })
				.setValue(this.plugin.toolExecutionOf(tool))
				.onChange((v) => {
					this.plugin.settings.toolExecutionByTool[tool] =
						v === 'sequential' ? 'sequential' : 'parallel';
					void this.save();
				});
		});
	}

	private listingSelect(setting: Setting, key: string) {
		setting.addDropdown((d) => {
			d.selectEl.addClass('librarian-tool-deferred');
			d.selectEl.setAttr('aria-label', `${key} listing`);
			d.addOptions({ listed: 'Listed', deferred: 'Deferred' })
				.setValue(this.plugin.toolDeferredOf(key) ? 'deferred' : 'listed')
				.onChange((v) => {
					this.plugin.settings.toolDeferredByTool[key] = v === 'deferred';
					void this.save();
				});
		});
	}

	// Context

	private contextPage(): Page {
		const c = this.plugin.settings.context;
		return {
			name: 'Context',
			desc: 'When to warn about the context window and when to compact it.',
			items: [
				{
					type: 'group',
					items: [
						{
							name: 'Warning at (%)',
							desc: 'The context ring warns at this share of the usable input.',
							render: (setting) =>
								numberInput(
									setting,
									Math.round(c.warningAt * 100),
									async (v) => {
										c.warningAt = Math.min(100, Math.max(1, v ?? 70)) / 100;
										await this.save();
									},
									'70',
								),
						},
						{
							name: 'Compact at (%)',
							desc: 'Older turns are summarized at this share of the usable input.',
							render: (setting) =>
								numberInput(
									setting,
									Math.round(c.compactAt * 100),
									async (v) => {
										c.compactAt = Math.min(100, Math.max(1, v ?? 85)) / 100;
										await this.save();
									},
									'85',
								),
						},
						{
							name: 'Preserve recent turns',
							desc: 'The latest turns stay word for word when older ones are summarized.',
							render: (setting) =>
								numberInput(
									setting,
									c.preserveRecentTurns,
									async (v) => {
										c.preserveRecentTurns = Math.max(1, v ?? 6);
										await this.save();
									},
									'6',
								),
						},
						{
							name: 'Reserved output tokens',
							desc: 'Room held back for the answer. The usable input is what the window has left after this and the margin.',
							render: (setting) =>
								numberInput(
									setting,
									c.reserveOutputTokens === 'model-max'
										? undefined
										: c.reserveOutputTokens,
									async (v) => {
										c.reserveOutputTokens = v === undefined ? 'model-max' : v;
										await this.save();
									},
									'Model maximum',
								),
						},
						{
							name: 'Safety margin tokens',
							desc: 'Extra room, capped at 10% of the context window.',
							render: (setting) =>
								numberInput(
									setting,
									c.safetyMarginTokens,
									async (v) => {
										c.safetyMarginTokens = v ?? 4096;
										await this.save();
									},
									'4096',
								),
						},
					],
				},
			],
		};
	}

	// Sessions

	private sessionsPage(): Page {
		const list = this.sessionList;
		const current = this.plugin.controller.session?.id;
		return {
			name: 'Sessions',
			desc: 'Past conversations, and where they are kept with their rewind snapshots.',
			displayValue: list
				? `${list.length} ${list.length === 1 ? 'session' : 'sessions'}`
				: '',
			items: [
				{
					type: 'list',
					// There from the first draw: a redraw after the list arrives keeps the header.
					search: { placeholder: 'Search sessions', match: rowMatches },
					emptyState: list ? 'No sessions yet.' : 'Loading sessions',
					items: (list ?? []).map((session) =>
						this.sessionRow(session, session.id === current),
					),
				},
				{
					type: 'group',
					items: [
						{
							name: 'Storage',
							desc: `Each session is a JSONL file in ${this.plugin.sessions.sessionsDir}. Rewind snapshots are kept next to them.`,
							aliases: ['History', 'Snapshots', 'Rewind'],
							// Drawn whenever the page is: the list is read then, not at startup.
							render: () => void this.loadSessions(),
						},
					],
				},
			],
		};
	}

	/** A row opens its session in the chat; the pencil renames it and the bin deletes it. */
	private sessionRow(session: SessionSummary, isCurrent: boolean): Row {
		return {
			name: session.title,
			desc: `${session.providerId || '?'}/${session.modelId || '?'}, ${new Date(session.updatedAt).toLocaleString()}`,
			render: (setting) => {
				setting.settingEl.addClass('librarian-session-setting');
				setting.settingEl.toggleClass('is-current', isCurrent);
				const info = setting.infoEl;
				info.setAttr('role', 'button');
				info.setAttr('tabindex', '0');
				info.addEventListener('click', () => void this.openSession(session));
				info.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') void this.openSession(session);
				});
				setting
					.addExtraButton((b) =>
						b
							.setIcon('pencil')
							.setTooltip('Rename')
							.onClick(() =>
								renameSession(this.plugin, session, () => this.loadSessions()),
							),
					)
					.addExtraButton((b) =>
						b
							.setIcon('trash-2')
							.setTooltip('Delete')
							.onClick(() =>
								confirmDeleteSession(this.plugin, session, () =>
									this.loadSessions(),
								),
							),
					);
			},
		};
	}

	/** Reads the session list and redraws only when it changed, so the redraw's own read stops. */
	private async loadSessions(): Promise<void> {
		const list = await this.plugin.sessions.list();
		const key = (l: SessionSummary[]) =>
			l.map((s) => `${s.id} ${s.updatedAt} ${s.title}`).join('\n');
		if (this.sessionList && key(list) === key(this.sessionList)) return;
		this.sessionList = list;
		this.refresh();
	}

	private async openSession(session: SessionSummary) {
		// The settings window covers the chat, so it closes before the session opens there.
		(this.app as unknown as { setting: { close(): void } }).setting.close();
		const view = await this.plugin.activateView();
		await view?.openSession(session.id);
	}
}
