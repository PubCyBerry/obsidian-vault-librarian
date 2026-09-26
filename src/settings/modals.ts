import {
	type App,
	FuzzySuggestModal,
	Modal,
	Notice,
	requireApiVersion,
	Setting,
	type TFile,
} from 'obsidian';
import type LibrarianPlugin from '../main';
import { apiKeySecretId } from '../mcp/mcp-manager';
import { clientSecretId } from '../mcp/oauth-provider';
import { modelFromServer } from '../provider/model-catalog';
import { type ServerModel, testConnection } from '../provider/transport';
import {
	MAX_DESCRIPTION,
	type Skill,
	type SkillManager,
	skillBody,
	skillNameProblem,
} from '../skills/skill-manager';
import { isValidSecretId, type SecretStore } from '../storage/secret-store';
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
} from '../types';
import { modalButtons } from '../ui/session-list';

/** Where a typed secret goes: this device, and the sealed settings while Device sync is on. */
export function keptWhere(secrets: SecretStore): string {
	return secrets.state === 'on'
		? 'Kept on this device and sealed for your other devices.'
		: 'Kept on this device only.';
}

/** A validation message under the row on Obsidian 1.13 and later, a notice before that. */
function invalid(setting: Setting, message: string): void {
	if (requireApiVersion('1.13.0')) setting.setErrorMessage(message);
	else new Notice(message);
}

function clearError(setting: Setting): void {
	if (requireApiVersion('1.13.0')) setting.setErrorMessage(null);
}

/** What the editor hands back beside the server: secrets typed into it, empty when unchanged. */
interface McpSecretsTyped {
	key: string;
	clientSecret: string;
}

export class McpServerEditorModal extends Modal {
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

/**
 * Adds a skill to the root skills folder, or edits one where it is (LIB-FEAT-282): its name, what
 * it is for and its instructions. A skill's name is its folder's, so an existing one keeps it.
 */
export class SkillEditorModal extends Modal {
	private name = '';
	private description = '';
	private body = '';
	/** The SKILL.md as it was read, so a change made meanwhile is not written over. */
	private original = '';

	constructor(
		app: App,
		private readonly skills: SkillManager,
		private readonly existing: Skill | null,
		private readonly onSaved: () => Promise<void>,
	) {
		super(app);
		this.description = existing?.description ?? '';
	}

	onOpen() {
		void this.render();
	}

	private async render() {
		const skill = this.existing;
		if (skill) {
			try {
				this.original = await this.app.vault.adapter.read(skill.location);
			} catch {
				new Notice(`Could not read ${skill.location}. Rescan the skills.`);
				this.close();
				return;
			}
			this.body = skillBody(this.original);
		}
		this.modalEl.addClass('librarian-modal');
		this.titleEl.setText(skill ? `Edit skill ${skill.name}` : 'Add skill');
		const el = this.contentEl;
		const name: Setting = new Setting(el)
			.setName('Name')
			.setDesc(
				skill
					? skill.location
					: 'Lowercase letters, digits and hyphens. The folder of the skill takes this name.',
			)
			.addText((t) =>
				skill
					? t.setValue(skill.name).setDisabled(true)
					: t.setPlaceholder('meeting-notes').onChange((v) => {
							this.name = v.trim();
							clearError(name);
						}),
			);
		const description: Setting = new Setting(el)
			.setName('Description')
			.setDesc('What the skill does and when to use it. The model picks skills by this.')
			.addTextArea((t) =>
				t.setValue(this.description).onChange((v) => {
					this.description = v;
					clearError(description);
				}),
			);
		description.settingEl.addClass('librarian-prompt-setting', 'librarian-short-text');
		const instructions: Setting = new Setting(el)
			.setName('Instructions')
			.setDesc(
				'What the model follows once it reads the skill. Paths in them are relative to the folder of the skill.',
			)
			.addTextArea((t) =>
				t.setValue(this.body).onChange((v) => {
					this.body = v;
					clearError(instructions);
				}),
			);
		instructions.settingEl.addClass('librarian-prompt-setting');
		const buttons = modalButtons(el, () => this.close());
		buttons
			.createEl('button', { cls: 'mod-cta', text: 'Save' })
			.addEventListener('click', () => void this.save(name, description, instructions));
	}

	private async save(name: Setting, description: Setting, instructions: Setting) {
		const nameProblem = this.existing ? null : skillNameProblem(this.name);
		if (nameProblem) return invalid(name, nameProblem);
		const text = this.description.trim();
		if (!text) return invalid(description, 'Description is required.');
		if (text.length > MAX_DESCRIPTION)
			return invalid(
				description,
				`Description is longer than ${MAX_DESCRIPTION} characters.`,
			);
		try {
			if (this.existing)
				await this.skills.update(this.existing, text, this.body, this.original);
			else await this.skills.create(this.name, text, this.body);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return invalid(this.existing ? instructions : name, message);
		}
		await this.onSaved();
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

export function numberInput(
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

export class ModelEditorModal extends Modal {
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
export class ServerModelModal extends FuzzySuggestModal<ServerModel> {
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
export class BackupFileModal extends FuzzySuggestModal<TFile> {
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

export class ProviderEditorModal extends Modal {
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
