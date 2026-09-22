import {
	type App,
	Modal,
	Notice,
	PluginSettingTab,
	requireApiVersion,
	Setting,
	type SettingDefinitionItem,
	setIcon,
	setTooltip,
} from 'obsidian';
import type LibrarianPlugin from '../main';
import { apiKeySecretId, type McpStatus } from '../mcp/mcp-manager';
import {
	PERMISSION_DESCRIPTIONS,
	PERMISSION_ICONS,
	PERMISSION_LABELS,
	TOOL_GROUPS,
} from '../permissions/tool-permission-manager';
import { testConnection } from '../provider/transport';
import { isValidSecretId } from '../storage/secret-store';
import {
	MCP_SERVER_ID_PATTERN,
	type McpServerConfig,
	type ModelConfig,
	newMcpServer,
	newModel,
	newProvider,
	type ProviderCompat,
	type ProviderConfig,
	THINKING_LEVELS,
	type ThinkingLevel,
	type ToolPermission,
} from '../types';

const PERMISSIONS: ToolPermission[] = ['always_allow', 'approval_required', 'blocked'];

const MCP_STATUS_LABELS: Record<McpStatus, string> = {
	disabled: 'Disabled',
	disconnected: 'Not connected',
	connecting: 'Connecting...',
	ready: 'Connected',
	'needs-sign-in': 'Sign-in needed',
	error: 'Error',
};

class McpServerEditorModal extends Modal {
	private draft: McpServerConfig;

	constructor(
		app: App,
		private readonly plugin: LibrarianPlugin,
		private readonly existing: McpServerConfig | null,
		private readonly onSaved: (server: McpServerConfig) => Promise<void>,
	) {
		super(app);
		this.draft = existing ? { ...existing } : newMcpServer('');
	}

	onOpen() {
		const el = this.contentEl;
		el.empty();
		this.titleEl.setText(this.existing ? 'Edit MCP server' : 'Add MCP server');
		new Setting(el).setName('Name').addText((t) =>
			t.setValue(this.draft.name).onChange((v) => {
				this.draft.name = v;
				if (!this.existing) this.draft.id = newMcpServer(v).id;
			}),
		);
		new Setting(el)
			.setName('URL')
			.setDesc('Endpoint of the server. For Outline it ends in /mcp.')
			.addText((t) =>
				t.setValue(this.draft.url).onChange((v) => {
					this.draft.url = v.trim();
				}),
			);
		new Setting(el)
			.setName('Authentication')
			.setDesc('Sign in through the browser, or paste an API key once per device.')
			.addDropdown((d) =>
				d
					.addOptions({ oauth: 'OAuth (sign in)', apiKey: 'API key', none: 'None' })
					.setValue(this.draft.auth)
					.onChange((v) => {
						this.draft.auth = v as McpServerConfig['auth'];
					}),
			);
		const note = el.createDiv({ cls: 'librarian-modal-note' });
		const buttons = el.createDiv({ cls: 'librarian-modal-buttons' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
		const save = buttons.createEl('button', { cls: 'mod-cta', text: 'Save' });
		save.addEventListener(
			'click',
			() =>
				void (async () => {
					const name = this.draft.name.trim();
					if (!name) return note.setText('Name is required.');
					if (!/^https?:\/\//.test(this.draft.url))
						return note.setText('The URL must start with http or https.');
					if (!MCP_SERVER_ID_PATTERN.test(this.draft.id))
						return note.setText('Name must contain a letter or digit.');
					const taken = this.plugin.settings.mcpServers.some(
						(s) => s.id === this.draft.id && s !== this.existing,
					);
					if (taken) return note.setText('This name is already used.');
					await this.onSaved({ ...this.draft, name });
					this.close();
				})(),
		);
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
		new Setting(el)
			.setName('ID')
			.setDesc('The model ID sent to the API.')
			.addText((t) => t.setValue(d.id).onChange((v) => (d.id = v.trim())));
		new Setting(el)
			.setName('Display name')
			.addText((t) => t.setValue(d.name).onChange((v) => (d.name = v.trim())));
		new Setting(el)
			.setName('API override')
			.setDesc('Leave empty to use the provider API.')
			.addText((t) =>
				t.setValue(d.api ?? '').onChange((v) => (d.api = v.trim() || undefined)),
			);
		new Setting(el)
			.setName('Tool calling')
			.setDesc('Librarian only lists models that can call tools.')
			.addToggle((t) => t.setValue(d.toolCalling).onChange((v) => (d.toolCalling = v)));
		new Setting(el)
			.setName('Reasoning')
			.addToggle((t) => t.setValue(d.reasoning).onChange((v) => (d.reasoning = v)));
		new Setting(el).setName('Accepts images').addToggle((t) =>
			t.setValue(d.input.includes('image')).onChange((v) => {
				d.input = v ? ['text', 'image'] : ['text'];
			}),
		);
		numberInput(
			new Setting(el).setName('Context window'),
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

		const samplingSetting = new Setting(el)
			.setName('Sampling parameters')
			.setDesc('JSON object merged into the request body, e.g. {"top_k": 20}.');
		let samplingText = d.samplingParams ? JSON.stringify(d.samplingParams) : '';
		samplingSetting.addTextArea((t) =>
			t.setValue(samplingText).onChange((v) => (samplingText = v)),
		);

		d.compat = d.compat ?? {};
		const compat = d.compat;
		renderCompat(el, compat, 'Compatibility override');

		const buttons = el.createDiv({ cls: 'librarian-modal-buttons' });
		const save = buttons.createEl('button', { cls: 'mod-cta', text: 'Save' });
		save.addEventListener('click', () => {
			if (!d.id) {
				new Notice('The model needs an ID.');
				return;
			}
			if (!d.name) d.name = d.id;
			if (samplingText.trim()) {
				try {
					const parsed = JSON.parse(samplingText) as unknown;
					if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
						throw new Error('not an object');
					d.samplingParams = parsed as Record<string, unknown>;
				} catch {
					new Notice('Sampling parameters must be a JSON object.');
					return;
				}
			} else {
				delete d.samplingParams;
			}
			if (Object.keys(compat).length === 0) delete d.compat;
			this.onSave(d);
			this.close();
		});
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
	}

	onClose() {
		this.contentEl.empty();
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
		let idSetting: Setting;
		new Setting(el).setName('Name').addText((t) =>
			t.setValue(d.name).onChange((v) => {
				d.name = v.trim();
				if (this.isNew) {
					d.id = slug(d.name);
					d.secretId = `vault-librarian-${d.id}`;
					idSetting.setDesc(`ID ${d.id || '?'}, key stored as ${d.secretId}`);
				}
			}),
		);
		idSetting = new Setting(el)
			.setName('ID')
			.setDesc(`ID ${d.id || '?'}, key stored as ${d.secretId}`);
		if (this.isNew) {
			idSetting.addText((t) =>
				t.setValue(d.id).onChange((v) => {
					d.id = slug(v);
					d.secretId = `vault-librarian-${d.id}`;
					idSetting.setDesc(`ID ${d.id || '?'}, key stored as ${d.secretId}`);
				}),
			);
		}
		new Setting(el)
			.setName('Base URL')
			.setDesc('The endpoint root such as the /v1 URL of an OpenAI-compatible server.')
			.addText((t) => t.setValue(d.baseUrl).onChange((v) => (d.baseUrl = v.trim())));
		new Setting(el)
			.setName('API')
			.addText((t) =>
				t.setValue(d.api).onChange((v) => (d.api = v.trim() || 'openai-completions')),
			);
		const stored = this.plugin.secrets.get(d.secretId);
		new Setting(el)
			.setName('API key')
			.setDesc(stored === null ? 'Not set on this device' : 'Stored on this device')
			.addText((t) => {
				t.inputEl.type = 'password';
				t.setPlaceholder(
					stored === null ? 'Enter the key' : 'Leave empty to keep the stored key',
				);
				t.onChange((v) => {
					this.apiKeyInput = v;
					this.apiKeyTouched = true;
				});
			});
		new Setting(el)
			.setName('Auth header')
			.setDesc('Send Authorization: Bearer <key>.')
			.addToggle((t) => t.setValue(d.authHeader).onChange((v) => (d.authHeader = v)));
		new Setting(el).setName('Transport').addDropdown((dd) => {
			dd.addOption('auto', 'Auto');
			dd.addOption('requestUrl', 'Non-streaming (Obsidian)');
			dd.addOption('fetch', 'Streaming (browser)');
			dd.setValue(d.transport);
			dd.onChange((v) => (d.transport = v as ProviderConfig['transport']));
		});
		new Setting(el).setName('Test connection').addButton((b) =>
			b.setButtonText('Test').onClick(async () => {
				const key = this.apiKeyTouched ? this.apiKeyInput.trim() : stored;
				b.setDisabled(true);
				const result = await testConnection(d, key);
				b.setDisabled(false);
				new Notice(
					result.ok
						? `Connection OK. ${result.models} models available.`
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
			'default',
		);
		numberInput(new Setting(req).setName('Top p'), r.topP, (v) => (r.topP = v), 'default');
		numberInput(new Setting(req).setName('Top k'), r.topK, (v) => (r.topK = v), 'default');
		numberInput(new Setting(req).setName('Min p'), r.minP, (v) => (r.minP = v), 'default');
		numberInput(
			new Setting(req).setName('Max output tokens').setDesc('Empty uses the model maximum.'),
			r.maxTokens,
			(v) => (r.maxTokens = v),
			'model max',
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
		);
		numberInput(
			new Setting(req).setName('Max retries'),
			r.maxRetries,
			(v) => (r.maxRetries = v ?? 2),
		);
		new Setting(req)
			.setName('Parallel read tools')
			.addToggle((t) =>
				t.setValue(r.parallelReadTools).onChange((v) => (r.parallelReadTools = v)),
			);
		let extraText = r.extraBody ? JSON.stringify(r.extraBody) : '';
		new Setting(req)
			.setName('Extra request body')
			.setDesc(
				'JSON object merged into every request. Cannot override model, messages, tools, tool_choice or stream.',
			)
			.addTextArea((t) => t.setValue(extraText).onChange((v) => (extraText = v)));

		new Setting(el)
			.setName('Models')
			.setHeading()
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

		const buttons = el.createDiv({ cls: 'librarian-modal-buttons' });
		const save = buttons.createEl('button', { cls: 'mod-cta', text: 'Save' });
		save.addEventListener(
			'click',
			() =>
				void (async () => {
					if (!d.name || !d.id) {
						new Notice('The provider needs a name.');
						return;
					}
					// The id prefixes the secret id, so both follow SecretStorage's character rule.
					if (!isValidSecretId(d.id) || !isValidSecretId(d.secretId)) {
						new Notice(
							'The provider ID may only use lowercase letters, digits and dashes.',
						);
						return;
					}
					if (this.isNew && this.plugin.settings.providers.some((p) => p.id === d.id)) {
						new Notice(`A provider with id ${d.id} already exists.`);
						return;
					}
					if (extraText.trim()) {
						try {
							const parsed = JSON.parse(extraText) as unknown;
							if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
								throw new Error('not an object');
							r.extraBody = parsed as Record<string, unknown>;
						} catch {
							new Notice('Extra request body must be a JSON object.');
							return;
						}
					} else {
						delete r.extraBody;
					}
					if (this.apiKeyTouched)
						this.plugin.secrets.set(d.secretId, this.apiKeyInput.trim());
					await this.onSave(d);
					this.close();
				})(),
		);
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
	}

	private renderModels() {
		this.modelsEl.empty();
		if (!this.draft.models.length)
			this.modelsEl.createDiv({ cls: 'setting-item-description', text: 'No models yet.' });
		this.draft.models.forEach((model, i) => {
			new Setting(this.modelsEl)
				.setName(model.name || model.id)
				.setDesc(
					`${model.id} · ${model.contextWindow.toLocaleString('en-US')} ctx · ${model.toolCalling ? 'tools' : 'no tools'}${model.input.includes('image') ? ' · images' : ''}`,
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

export class LibrarianSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: LibrarianPlugin,
	) {
		super(app, plugin);
	}

	private unsubscribeMcp: (() => void) | null = null;

	display(): void {
		this.renderLegacy();
		this.unsubscribeMcp?.();
		this.unsubscribeMcp = this.plugin.mcp.subscribe(() => this.refreshSettings());
	}

	hide(): void {
		this.unsubscribeMcp?.();
		this.unsubscribeMcp = null;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		// Custom sections retain their existing controls while participating in settings search.
		const sections = [
			{
				name: 'Providers',
				aliases: [
					'API key',
					'Base URL',
					'Default model',
					'Transport',
					'Models',
					'Connection',
					'Compatibility',
				],
				render: (el: HTMLElement) => this.renderProviders(el),
			},
			{
				name: 'Agent',
				aliases: [
					'Max tool iterations',
					'Repeated failure limit',
					'AGENTS.md',
					'Custom system prompt',
				],
				render: (el: HTMLElement) => this.renderAgent(el),
			},
			{
				name: 'MCP servers',
				aliases: ['MCP', 'Outline', 'OAuth', 'Sign in', 'Remote tools'],
				render: (el: HTMLElement) => this.renderMcpServers(el),
			},
			{
				name: 'Tool permissions',
				aliases: [
					'Read',
					'Write',
					'Ask first',
					'Blocked',
					...TOOL_GROUPS.flatMap((group) => group.tools),
				],
				render: (el: HTMLElement) => this.renderToolPermissions(el),
			},
			{
				name: 'Context',
				aliases: [
					'Warning at',
					'Compact at',
					'Preserve recent turns',
					'Reserved output tokens',
					'Safety margin tokens',
				],
				render: (el: HTMLElement) => this.renderContext(el),
			},
			{
				name: 'Sessions',
				aliases: ['Storage', 'History', 'Snapshots', 'Rewind'],
				render: (el: HTMLElement) => this.renderSessions(el),
			},
		];
		return sections.map((section) => ({
			name: section.name,
			aliases: section.aliases,
			render: (setting: Setting) => {
				setting.settingEl.empty();
				setting.settingEl.addClass('librarian-settings-section');
				section.render(setting.settingEl);
			},
		}));
	}

	private refreshSettings() {
		if (requireApiVersion('1.13.0')) this.update();
		else this.renderLegacy();
	}

	private renderLegacy(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('librarian-settings');
		this.renderProviders(containerEl);
		this.renderAgent(containerEl);
		this.renderMcpServers(containerEl);
		this.renderToolPermissions(containerEl);
		this.renderContext(containerEl);
		this.renderSessions(containerEl);
	}

	private async save() {
		await this.plugin.saveSettings();
		await this.plugin.controller.recalculateUsage();
	}

	private renderProviders(el: HTMLElement) {
		new Setting(el)
			.setName('Providers')
			.setHeading()
			.addButton((b) =>
				b
					.setButtonText('Add provider')
					.setCta()
					.onClick(() => {
						new ProviderEditorModal(this.app, this.plugin, null, async (p) => {
							this.plugin.settings.providers.push(p);
							if (!this.plugin.settings.activeProviderId && p.models[0]) {
								this.plugin.settings.activeProviderId = p.id;
								this.plugin.settings.activeModelId = p.models[0].id;
							}
							await this.save();
							this.refreshSettings();
						}).open();
					}),
			);
		const s = this.plugin.settings;
		if (!s.providers.length)
			el.createDiv({
				cls: 'setting-item-description',
				text: 'Add an OpenAI-compatible provider to start.',
			});
		s.providers.forEach((provider, i) => {
			new Setting(el)
				.setName(provider.name)
				.setDesc(
					`${provider.baseUrl || 'no URL'} · ${provider.models.length} ${provider.models.length === 1 ? 'model' : 'models'} · ${provider.transport}`,
				)
				.addExtraButton((b) =>
					b
						.setIcon('pencil')
						.setTooltip('Edit')
						.onClick(() => {
							new ProviderEditorModal(
								this.app,
								this.plugin,
								provider,
								async (updated) => {
									s.providers[i] = updated;
									await this.save();
									this.refreshSettings();
								},
							).open();
						}),
				)
				.addExtraButton((b) =>
					b
						.setIcon('trash-2')
						.setTooltip('Delete')
						.onClick(() => {
							const modal = new Modal(this.app);
							modal.titleEl.setText(`Delete provider ${provider.name}?`);
							modal.contentEl.createEl('p', {
								text: 'Its API key on this device is cleared. Sessions that used it are kept.',
							});
							const row = modal.contentEl.createDiv({
								cls: 'librarian-modal-buttons',
							});
							const ok = row.createEl('button', {
								cls: 'mod-warning',
								text: 'Delete',
							});
							ok.addEventListener(
								'click',
								() =>
									void (async () => {
										modal.close();
										this.plugin.secrets.clear(provider.secretId);
										s.providers.splice(i, 1);
										if (s.activeProviderId === provider.id) {
											s.activeProviderId = null;
											s.activeModelId = null;
										}
										await this.save();
										this.refreshSettings();
									})(),
							);
							row.createEl('button', { text: 'Cancel' }).addEventListener(
								'click',
								() => modal.close(),
							);
							modal.open();
						}),
				);
		});
		const selectable = this.plugin.providers.listSelectable();
		if (selectable.length) {
			new Setting(el)
				.setName('Default model')
				.setDesc('Used for new sessions.')
				.addDropdown((d) => {
					for (const { provider, model } of selectable)
						d.addOption(
							`${provider.id}\u0000${model.id}`,
							`${provider.name} / ${model.name}`,
						);
					d.setValue(`${s.activeProviderId ?? ''}\u0000${s.activeModelId ?? ''}`);
					d.onChange(async (v) => {
						const [providerId, modelId] = v.split('\u0000');
						s.activeProviderId = providerId ?? null;
						s.activeModelId = modelId ?? null;
						await this.save();
					});
				});
		}
	}

	private renderAgent(el: HTMLElement) {
		new Setting(el).setName('Agent').setHeading();
		const s = this.plugin.settings;
		numberInput(
			new Setting(el)
				.setName('Max tool iterations')
				.setDesc('Turns with tool calls before the agent stops and waits for you.'),
			s.maxIterations,
			async (v) => {
				s.maxIterations = v ?? 10;
				await this.save();
			},
		);
		numberInput(
			new Setting(el)
				.setName('Repeated failure limit')
				.setDesc('Stop when the same tool call fails this many times.'),
			s.repeatedFailureLimit,
			async (v) => {
				s.repeatedFailureLimit = v ?? 3;
				await this.save();
			},
		);
		new Setting(el)
			.setName('Open chat in')
			.setDesc('Where a new chat view opens. An open chat is reused wherever it is.')
			.addDropdown((d) =>
				d
					.addOptions({ sidebar: 'Right sidebar', tab: 'Main area' })
					.setValue(s.chatLocation)
					.onChange(async (v) => {
						s.chatLocation = v === 'tab' ? 'tab' : 'sidebar';
						await this.save();
					}),
			);
		new Setting(el)
			.setName('Commands folder')
			.setDesc(
				'Notes in this folder become /name commands. $ARGUMENTS takes the rest of the line.',
			)
			.addText((t) =>
				t.setValue(s.commandsFolder).onChange(async (v) => {
					s.commandsFolder = v.trim().replace(/^\/+|\/+$/g, '');
					await this.save();
				}),
			);
		const agentsMd = new Setting(el)
			.setName('Use vault root AGENTS.md')
			.setDesc('Read AGENTS.md at the vault root as vault-local instructions.');
		const status = this.app.vault.getFileByPath('AGENTS.md') ? '' : 'AGENTS.md not found';
		if (status)
			agentsMd.setDesc(
				`Read AGENTS.md at the vault root as vault-local instructions. ${status}.`,
			);
		agentsMd.addToggle((t) =>
			t.setValue(s.useVaultAgentsMd).onChange(async (v) => {
				s.useVaultAgentsMd = v;
				await this.save();
			}),
		);
		new Setting(el)
			.setName('Custom system prompt')
			.setDesc('Applied below the vault root instructions file.')
			.addTextArea((t) => {
				t.inputEl.rows = 6;
				t.setValue(s.customSystemPrompt).onChange(async (v) => {
					s.customSystemPrompt = v;
					await this.save();
				});
			});
		const order = el.createDiv({ cls: 'setting-item-description librarian-prompt-order' });
		order.createDiv({ text: 'Prompt order' });
		const list = order.createEl('ol');
		list.createEl('li', { text: 'Librarian built-in instructions' });
		list.createEl('li', { text: 'Vault root AGENTS.md' });
		list.createEl('li', { text: 'Your custom system prompt' });
	}

	private renderMcpServers(el: HTMLElement) {
		new Setting(el)
			.setName('MCP servers')
			.setHeading()
			.setDesc(
				'Remote servers over streamable HTTP. Their tools ask first and their results are marked untrusted.',
			)
			.addButton((b) =>
				b.setButtonText('Add server').onClick(() => {
					new McpServerEditorModal(this.app, this.plugin, null, async (server) => {
						this.plugin.settings.mcpServers.push(server);
						await this.save();
						await this.plugin.mcp.connect(server.id);
						this.refreshSettings();
					}).open();
				}),
			);
		const mcp = this.plugin.mcp;
		for (const server of this.plugin.settings.mcpServers) {
			const state = mcp.state(server.id);
			const status = MCP_STATUS_LABELS[state.status];
			const detail =
				state.status === 'ready' ? `${state.tools.length} tools` : (state.message ?? '');
			const row = new Setting(el)
				.setName(server.name)
				.setDesc(`${server.url} · ${status}${detail ? ` · ${detail}` : ''}`);
			row.addToggle((t) =>
				t
					.setTooltip('Enabled')
					.setValue(server.enabled)
					.onChange(async (v) => {
						server.enabled = v;
						await this.save();
						await mcp.connect(server.id);
						this.refreshSettings();
					}),
			);
			if (server.auth === 'apiKey') {
				const has = !!this.plugin.secrets.get(apiKeySecretId(server.id));
				let pendingKey = '';
				row.addText((t) => {
					t.inputEl.type = 'password';
					t.setPlaceholder(has ? 'API key saved on this device' : 'API key');
					t.onChange((v) => {
						pendingKey = v;
					});
				});
				row.addButton((b) =>
					b.setButtonText('Save key').onClick(async () => {
						const key = pendingKey.trim();
						if (!key) return;
						this.plugin.secrets.set(apiKeySecretId(server.id), key);
						await mcp.connect(server.id);
						this.refreshSettings();
					}),
				);
			} else if (server.auth === 'oauth') {
				row.addButton((b) =>
					b
						.setButtonText(state.status === 'ready' ? 'Sign out' : 'Sign in')
						.onClick(async () => {
							if (state.status === 'ready') await mcp.signOut(server.id);
							else await mcp.signIn(server.id);
							this.refreshSettings();
						}),
				);
			} else {
				row.addButton((b) =>
					b.setButtonText('Reconnect').onClick(async () => {
						await mcp.connect(server.id);
						this.refreshSettings();
					}),
				);
			}
			row.addExtraButton((b) =>
				b
					.setIcon('pencil')
					.setTooltip('Edit')
					.onClick(() => {
						new McpServerEditorModal(this.app, this.plugin, server, async (updated) => {
							Object.assign(server, updated);
							await this.save();
							await mcp.connect(server.id);
							this.refreshSettings();
						}).open();
					}),
			);
			row.addExtraButton((b) =>
				b
					.setIcon('trash')
					.setTooltip('Remove')
					.onClick(async () => {
						await mcp.remove(server.id);
						await this.plugin.controller.recalculateUsage();
						this.refreshSettings();
					}),
			);
		}
		if (this.plugin.settings.mcpServers.length === 0)
			el.createDiv({ cls: 'librarian-modal-note', text: 'No MCP servers yet.' });
	}

	private renderToolPermissions(el: HTMLElement) {
		new Setting(el)
			.setName('Tool permissions')
			.setHeading()
			.setDesc(
				'Every tool asks first on a new install. Blocked tools are hidden from the model.',
			);
		const perms = this.plugin.permissions;
		const wrap = el.createDiv({ cls: 'librarian-tool-permissions' });
		for (const group of perms.groups()) {
			const groupEl = wrap.createEl('details', { cls: 'librarian-tool-permission-group' });
			groupEl.open = true;
			const summary = groupEl.createEl('summary');
			summary.createSpan({ cls: 'librarian-group-label', text: `${group.label} ` });
			summary.createSpan({ cls: 'librarian-group-count', text: String(group.tools.length) });
			const select = summary.createEl('select', {
				cls: 'dropdown',
				attr: { 'aria-label': `${group.label} permission` },
			});
			select.addEventListener('click', (e) => e.stopPropagation());
			const fill = () => {
				select.empty();
				const display = perms.getGroupDisplay(group.id);
				if (display === 'mixed')
					select.createEl('option', {
						value: 'mixed',
						text: 'Mixed',
						attr: { disabled: 'true' },
					}).selected = true;
				for (const p of PERMISSIONS) {
					const option = select.createEl('option', {
						value: p,
						text: PERMISSION_LABELS[p],
					});
					if (display === p) option.selected = true;
				}
			};
			fill();
			const rows: (() => void)[] = [];
			select.addEventListener(
				'change',
				() =>
					void (async () => {
						if (select.value === 'mixed') return;
						await perms.setGroup(group.id, select.value as ToolPermission);
						for (const r of rows) r();
						fill();
						await this.plugin.controller.recalculateUsage();
					})(),
			);
			for (const tool of group.tools) {
				const row = groupEl.createDiv({ cls: 'librarian-tool-permission-row' });
				row.createSpan({ cls: 'librarian-tool-permission-name', text: tool });
				const seg = row.createDiv({
					cls: 'librarian-segmented',
					attr: { role: 'radiogroup', 'aria-label': `${tool} permission` },
				});
				const buttons = PERMISSIONS.map((p) => {
					// Icon only; the label and its meaning live in the hover tooltip.
					const b = seg.createEl('button', {
						attr: { role: 'radio', 'aria-label': PERMISSION_LABELS[p] },
					});
					setIcon(b, PERMISSION_ICONS[p]);
					const why =
						p === 'always_allow' && !perms.canAlwaysAllow(tool)
							? 'The server marks this tool destructive.'
							: PERMISSION_DESCRIPTIONS[p];
					setTooltip(b, `${PERMISSION_LABELS[p]}\n${why}`, {
						classes: ['librarian-tooltip'],
					});
					if (p === 'always_allow' && !perms.canAlwaysAllow(tool)) {
						// A disabled button gets no mouse events, so the native title carries the reason.
						b.disabled = true;
						b.setAttr('title', why);
					}
					b.addEventListener(
						'click',
						() =>
							void (async () => {
								await perms.setTool(tool, p);
								refresh();
								fill();
								await this.plugin.controller.recalculateUsage();
							})(),
					);
					return { p, b };
				});
				const refresh = () => {
					const current = perms.get(tool);
					for (const { p, b } of buttons) {
						b.toggleClass('is-active', p === current);
						b.setAttr('aria-checked', String(p === current));
					}
				};
				refresh();
				rows.push(refresh);
			}
		}
	}

	private renderContext(el: HTMLElement) {
		new Setting(el).setName('Context').setHeading();
		const c = this.plugin.settings.context;
		numberInput(
			new Setting(el).setName('Warning at (%)').setDesc('Of the usable input budget.'),
			Math.round(c.warningAt * 100),
			async (v) => {
				c.warningAt = Math.min(100, Math.max(1, v ?? 70)) / 100;
				await this.save();
			},
		);
		numberInput(
			new Setting(el).setName('Compact at (%)').setDesc('Of the usable input budget.'),
			Math.round(c.compactAt * 100),
			async (v) => {
				c.compactAt = Math.min(100, Math.max(1, v ?? 85)) / 100;
				await this.save();
			},
		);
		numberInput(
			new Setting(el).setName('Preserve recent turns'),
			c.preserveRecentTurns,
			async (v) => {
				c.preserveRecentTurns = Math.max(1, v ?? 6);
				await this.save();
			},
		);
		numberInput(
			new Setting(el)
				.setName('Reserved output tokens')
				.setDesc('Empty uses the model maximum.'),
			c.reserveOutputTokens === 'model-max' ? undefined : c.reserveOutputTokens,
			async (v) => {
				c.reserveOutputTokens = v === undefined ? 'model-max' : v;
				await this.save();
			},
			'model max',
		);
		numberInput(
			new Setting(el)
				.setName('Safety margin tokens')
				.setDesc('Capped at 10% of the context window.'),
			c.safetyMarginTokens,
			async (v) => {
				c.safetyMarginTokens = v ?? 4096;
				await this.save();
			},
		);
	}

	private renderSessions(el: HTMLElement) {
		new Setting(el).setName('Sessions').setHeading();
		new Setting(el)
			.setName('Storage')
			.setDesc(
				`Sessions are stored as JSONL files in ${this.plugin.sessions.sessionsDir}. Snapshots for rewind live next to them.`,
			);
	}
}
