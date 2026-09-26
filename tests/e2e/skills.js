// Skills made, changed and deleted from the settings and by the agent (LIB-TEST-285), in a vault
// window. Load it through the Obsidian CLI, then start a step and poll window.__skillCrud.state:
//
//   __skillCrud.start('settings')  the Skills page: a name the rules refuse and a taken one, Add
//                                  skill, Edit that keeps the keys it does not show, and Delete
//   __skillCrud.start('agent')     with scripted-provider.mjs running: the agent writes and edits
//                                  a skill and removes it with bash, every card asking without
//                                  Always allow; a rewind brings the removed skill back
//   __skillCrud.start('model')     the model in the settings is asked in plain words to make,
//                                  change and delete a skill; every card is approved
//
// Set window.__e2eOut to a folder for the screenshots. 'agent' adds a provider named Scripted
// (base URL http://127.0.0.1:18765/v1); put the settings file back afterwards.
(() => {
	const { remote } = require('electron');
	const fs = require('node:fs');
	const path = require('node:path');
	const plugin = () => app.plugins.plugins['vault-librarian'];
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const $ = (selector, root = document) => root.querySelector(selector);
	const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
	const chat = () => $('.workspace-leaf-content[data-type="librarian-chat"]');
	const view = () => app.workspace.getLeavesOfType('librarian-chat')[0].view;
	const results = { checks: [] };

	function check(name, ok, detail) {
		results.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
	}

	async function until(test, what, ms = 60000) {
		const end = Date.now() + ms;
		for (;;) {
			const value = await test();
			if (value) return value;
			if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
			await sleep(100);
		}
	}

	const read = (p) => app.vault.adapter.read(p);
	const exists = (p) => app.vault.adapter.exists(p);

	/** The settings window of Obsidian 1.13 and a way to run code in its page. */
	async function settingsWindow() {
		app.setting.open();
		app.setting.openTabById('vault-librarian');
		const sw = await until(
			() =>
				remote.BrowserWindow.getAllWindows().find((w) =>
					new RegExp(`^(Settings|설정) - ${app.vault.getName()} - `).test(w.getTitle()),
				),
			'the settings window',
		);
		sw.setContentSize(1000, 760);
		const inPage = (body, name = '', value = '') =>
			sw.webContents.executeJavaScript(
				`((name, value) => { ${body} })(${JSON.stringify(name)}, ${JSON.stringify(value)})`,
			);
		const snap = async (file) => {
			const out = window.__e2eOut;
			if (!out) return;
			await sleep(700);
			const image = await sw.webContents.capturePage();
			fs.mkdirSync(out, { recursive: true });
			fs.writeFileSync(path.join(out, `${file}.png`), image.toPNG());
		};
		const open = async (page) => {
			app.setting.openTabById('vault-librarian');
			await sleep(900);
			await inPage(
				`[...document.querySelectorAll('.setting-item')].findLast((i) => i.querySelector('.setting-item-name')?.textContent === name)?.click();`,
				page,
			);
			await sleep(900);
		};
		// The icon buttons carry their tooltip as aria-label; `name` picks the row, `value` the button.
		const rowButton = (row, label) =>
			inPage(
				`const r = [...document.querySelectorAll('.setting-item')].find((i) => i.querySelector('.setting-item-name')?.textContent.trim() === name); const b = r && [...r.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === value); b?.click(); return !!b;`,
				row,
				label,
			);
		const button = (label) =>
			inPage(
				`const b = [...document.querySelectorAll('button, [aria-label]')].findLast((e) => e.textContent.trim() === name || e.getAttribute('aria-label') === name); b?.click(); return !!b;`,
				label,
			);
		// The settings are a modal too; the skill editor is the one with the plugin's class.
		// `value` into the input or text area of the editor row named `name`.
		const fill = (row, value) =>
			inPage(
				`const r = [...document.querySelectorAll('.modal.librarian-modal .setting-item')].find((i) => i.querySelector('.setting-item-name')?.textContent === name); const input = r?.querySelector('textarea, input'); if (!input) return false; input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); return true;`,
				row,
				value,
			);
		// setErrorMessage puts the message under the row, so the editor's text holds it.
		const modalError = () =>
			inPage(`return document.querySelector('.modal.librarian-modal')?.textContent ?? '';`);
		const modalOpen = () =>
			inPage(`return !!document.querySelector('.modal.librarian-modal');`);
		const lastModal = () =>
			inPage(`return [...document.querySelectorAll('.modal')].at(-1)?.textContent ?? '';`);
		const rowNames = () =>
			inPage(
				`return [...document.querySelectorAll('.setting-item.librarian-skill .setting-item-name')].map((e) => e.textContent.trim());`,
			);
		return {
			sw,
			inPage,
			snap,
			open,
			rowButton,
			button,
			fill,
			modalError,
			modalOpen,
			lastModal,
			rowNames,
		};
	}

	async function settingsStep() {
		const s = await settingsWindow();
		const skills = plugin().skills;
		const name = `e2e-${Date.now().toString(36)}`;
		const file = `.agents/skills/${name}/SKILL.md`;
		await s.open('Skills');
		await s.snap('skills-page');
		check(
			'the Skills page lists the skills found',
			(await s.rowNames()).includes('meeting-notes'),
		);

		// Add: the rules on a name, then a taken name, then one that is free.
		check('Add skill opens the editor', await s.button('Add skill'));
		await until(() => s.modalOpen(), 'the editor');
		await s.snap('skill-add-empty');
		await s.fill('Name', 'Bad Name');
		await s.fill('Description', 'Says hello.');
		await s.button('Save');
		await sleep(400);
		const badName = await s.modalError();
		check('a name the rules refuse is named', /lowercase letters/.test(badName), badName);
		await s.fill('Name', 'meeting-notes');
		await s.button('Save');
		await sleep(600);
		const taken = await s.modalError();
		check('a taken name is refused', /already exists/.test(taken), taken);
		await s.fill('Name', name);
		await s.fill(
			'Description',
			'Greets the reader: one line. Use when a note needs a greeting.',
		);
		await s.fill('Instructions', '# Greet\n\nWrite "Hello" on the first line.');
		await s.snap('skill-add-filled');
		await s.button('Save');
		await until(async () => !(await s.modalOpen()), 'the editor to close');
		const made = await read(file);
		check(
			'Save wrote the SKILL.md with the two fields and the instructions',
			made ===
				`---\nname: ${name}\ndescription: "Greets the reader: one line. Use when a note needs a greeting."\n---\n\n# Greet\n\nWrite "Hello" on the first line.\n`,
			made,
		);
		check('the new skill is scanned', skills.get(name)?.location === file);
		await sleep(600);
		check('its row is on the page', (await s.rowNames()).includes(name));
		await s.snap('skill-added');

		// Edit: keys the editor does not show stay as written.
		await app.vault.adapter.write(
			file,
			made.replace('---\n\n', 'license: MIT\n# kept\nmetadata:\n  author: e2e\n---\n\n'),
		);
		await skills.scan();
		await sleep(600);
		check('Edit opens the editor', await s.rowButton(name, 'Edit'));
		await until(() => s.modalOpen(), 'the editor');
		await sleep(300);
		const shown = await s.inPage(
			`return [...document.querySelectorAll('.modal.librarian-modal textarea')].map((t) => t.value);`,
		);
		check(
			'the editor shows the description and the instructions',
			shown[0]?.startsWith('Greets the reader') && shown[1]?.startsWith('# Greet'),
			shown,
		);
		await s.snap('skill-edit');
		await s.fill('Description', 'Greets the reader. Use when a note needs a greeting.');
		await s.fill('Instructions', '# Greet\n\nWrite "Hi" on the first line.');
		await s.button('Save');
		await until(async () => !(await s.modalOpen()), 'the editor to close');
		const edited = await read(file);
		check(
			'Save changed the description and the instructions and kept the rest',
			edited ===
				`---\nname: ${name}\ndescription: "Greets the reader. Use when a note needs a greeting."\nlicense: MIT\n# kept\nmetadata:\n  author: e2e\n---\n\n# Greet\n\nWrite "Hi" on the first line.\n`,
			edited,
		);

		// A change made while the editor is open is not written over.
		await s.rowButton(name, 'Edit');
		await until(() => s.modalOpen(), 'the editor');
		await app.vault.adapter.write(file, `${edited}\nAdded meanwhile.\n`);
		await s.fill('Instructions', 'Lost?');
		await s.button('Save');
		await sleep(600);
		const conflict = await s.modalError();
		check(
			'a change made meanwhile stops the save',
			/changed while it was open/.test(conflict),
			conflict,
		);
		check('the file keeps that change', (await read(file)).includes('Added meanwhile.'));
		await s.button('Cancel');
		await sleep(400);

		// Delete: the folder goes to the trash and the row leaves.
		check('Delete asks', await s.rowButton(name, 'Delete'));
		await sleep(500);
		const confirm = await s.lastModal();
		check('the question names the folder', confirm.includes(`.agents/skills/${name}`), confirm);
		await s.snap('skill-delete');
		await s.inPage(`[...document.querySelectorAll('.modal .mod-warning')].at(-1)?.click();`);
		await until(async () => !(await exists(`.agents/skills/${name}`)), 'the folder to go');
		await sleep(600);
		check('the skill is gone from the scan', !skills.get(name));
		check('its row left the page', !(await s.rowNames()).includes(name));
		app.setting.close();
	}

	/** The chat on a new session with the given model, its window in front so timers run. */
	async function chatOn(providerId, modelId) {
		const p = plugin();
		const win = remote.getCurrentWindow();
		win.show();
		win.focus();
		await p.activateView('sidebar');
		app.workspace.rightSplit.expand();
		app.workspace.rightSplit.setSize(470);
		await view().newSession();
		await view().runtime.setModel(providerId, modelId);
		await sleep(300);
	}

	/** Sends like a user, and again while the send button was still turning back from Stop. */
	async function ask(text) {
		const runtime = view().runtime;
		await until(() => !runtime.isRunning, 'the last run to end');
		const input = $('.librarian-input', chat());
		input.value = text;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await until(
			async () => {
				await sleep(400);
				if (runtime.isRunning || input.value === '') return true;
				$('.librarian-send', chat()).click();
				return false;
			},
			'the message to go',
			20000,
		);
	}

	/**
	 * Answers every card until the run ends, and notes what each asked: the tool, the path or the
	 * command, the note under it and whether Always allow was offered.
	 */
	async function approveAll(asked) {
		const runtime = view().runtime;
		await until(() => runtime.isRunning, 'the run to start', 10000);
		while (runtime.isRunning) {
			const card = $('.librarian-approval', chat());
			if (card && !card.dataset.seen) {
				card.dataset.seen = '1';
				const request = runtime.pendingApproval;
				asked.push({
					tool: request?.name,
					target: request?.args?.path ?? request?.args?.command,
					note: $$('.librarian-approval-note', card).map((n) => n.textContent),
					always: $$('button', card).some((b) =>
						b.textContent.startsWith('Always allow'),
					),
				});
				$$('button', card)
					.find((b) => b.textContent === 'Approve')
					?.click();
			}
			await sleep(150);
		}
	}

	const lastAnswer = () =>
		$$('.librarian-msg-assistant', chat()).at(-1)?.textContent.trim().slice(0, 600) ?? '';

	async function scripted() {
		const p = plugin();
		if (!p.settings.providers.some((x) => x.id === 'scripted')) {
			p.settings.providers.push({
				id: 'scripted',
				name: 'Scripted',
				baseUrl: 'http://127.0.0.1:18765/v1',
				api: 'openai-completions',
				secretId: 'vault-librarian-openai',
				authHeader: false,
				transport: 'auto',
				compat: {},
				requestDefaults: {
					stream: true,
					timeoutMs: 120000,
					maxRetries: 0,
					thinkingLevel: 'off',
				},
				models: [
					{
						id: 'scripted',
						name: 'Scripted',
						api: 'openai-completions',
						toolCalling: true,
						reasoning: false,
						input: ['text'],
						contextWindow: 128000,
						maxTokens: 8192,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			});
			await p.saveSettings();
		}
	}

	async function agentStep() {
		await scripted();
		// Allowed writes still ask when they reach a skill.
		const byTool = plugin().settings.toolPermissions.byTool;
		const before = { write: byTool.write, edit: byTool.edit };
		byTool.write = 'always_allow';
		byTool.edit = 'always_allow';
		await plugin().saveSettings();
		await chatOn('scripted', 'scripted');
		const skills = plugin().skills;
		const file = '.agents/skills/tidy-notes/SKILL.md';
		try {
			const made = [];
			await ask('Please make a skill for tidying notes.');
			await approveAll(made);
			results.made = made;
			check(
				'the write and the edit each asked, with the note and without Always allow',
				made.length === 2 &&
					made.every(
						(a) =>
							a.target === file &&
							a.note.includes('Changes to skills always ask first.') &&
							!a.always,
					),
				made,
			);
			check(
				'the skill is scanned with its new description',
				skills.get('tidy-notes')?.description.startsWith('Tidies a note, its headings'),
				skills.get('tidy-notes'),
			);
			const results0 = (await plugin().sessions.load(view().runtime.session.id)).filter(
				(e) => e.type === 'tool_result',
			);
			check(
				'each result says what the file now makes',
				results0.every((r) => JSON.parse(r.content).skill?.name === 'tidy-notes'),
				results0.map((r) => r.content),
			);
			check(
				'the Skills section names it for the next request',
				view().runtime.deps.skillCatalog().includes('tidy-notes'),
			);

			const removed = [];
			await ask('Now delete the skill.');
			await approveAll(removed);
			results.removed = removed;
			check(
				'rm -rf asked for the command, then for the file, without Always allow on the file',
				removed.length === 2 &&
					removed[0].tool === 'bash' &&
					removed[1].tool === 'write' &&
					removed[1].target === file &&
					!removed[1].always,
				removed,
			);
			check('the folder is gone', !(await exists('.agents/skills/tidy-notes')));
			check('the skill left the scan', !skills.get('tidy-notes'));
			check('the answer says so', /gone/.test(lastAnswer()), lastAnswer());

			// Rewinding the request that removed it brings the skill back.
			const runtime = view().runtime;
			const users = runtime.events.filter((e) => e.event.type === 'user');
			const rewound = await runtime.rewind(users.at(-1).index);
			check('rewind put the SKILL.md back', rewound?.reverted.includes(file), rewound);
			check(
				'the skill is scanned again',
				skills.get('tidy-notes')?.description.startsWith('Tidies a note'),
			);
			results.session = runtime.session?.id;
		} finally {
			byTool.write = before.write;
			byTool.edit = before.edit;
			await plugin().saveSettings();
			const skill = skills.get('tidy-notes');
			if (skill) await skills.remove(skill);
		}
	}

	/** A model asked in plain words; what it does is recorded, not scripted. */
	async function modelStep() {
		const p = plugin();
		await chatOn(p.settings.activeProviderId, p.settings.activeModelId);
		const skills = p.skills;
		const turns = [];
		for (const text of [
			'회의 안건을 표로 정리하는 agenda-maker 스킬을 만들어 줘. 안건, 시간, 담당자 열을 두게 해.',
			'agenda-maker 스킬 설명 끝에 "Use when planning a meeting." 문장을 넣어 고쳐 줘.',
			'agenda-maker 스킬을 지워 줘.',
		]) {
			const asked = [];
			await ask(text);
			await approveAll(asked);
			turns.push({
				text,
				asked,
				skill: skills.get('agenda-maker') ?? null,
				answer: lastAnswer().slice(0, 400),
			});
		}
		results.model = {
			model: p.settings.activeModelId,
			turns,
			session: view().runtime.session?.id,
		};
		check(
			'the model made the skill',
			turns[0].skill?.location === '.agents/skills/agenda-maker/SKILL.md',
			turns[0].skill,
		);
		check(
			'the model changed its description',
			/Use when planning a meeting\./.test(turns[1].skill?.description ?? ''),
			turns[1].skill?.description,
		);
		check(
			'the model deleted it',
			!turns[2].skill && !(await exists('.agents/skills/agenda-maker')),
		);
	}

	const steps = { settings: settingsStep, agent: agentStep, model: modelStep };

	window.__skillCrud = {
		state: { step: null, running: false, error: null },
		results,
		start(name) {
			this.state = { step: name, running: true, error: null };
			steps[name]()
				.catch((error) => {
					this.state.error = String(error?.stack ?? error);
				})
				.finally(() => {
					this.state.running = false;
				});
			return 'started';
		},
	};
})();
