// Models added from an OpenAI-compatible server with what the server, Ollama and Pi's lists tell,
// and the effort each request carries (LIB-TEST-297), in a vault window whose settings have that
// provider with its key on this device. Load it through the Obsidian CLI, then start a step and
// poll window.__models.state:
//
//   __models.start('add', { provider })       Add from server for every model the server lists and
//                                            the provider lacks, then Save; results.added
//   __models.start('detect', { provider, model })  Detect in the editor of a model already added,
//                                            then Save; results.detected has the form and the model
//   __models.start('effort', { provider, cases: [[model, level], ...], transport })
//                                            one question per case in a fresh session: the level the
//                                            chat keeps, the one it shows, the reasoning_effort the request
//                                            carried (fetch only) and how much thinking came back
//
// Set window.__e2eOut to a folder for the screenshots. Put the settings file back afterwards and
// delete the sessions in results.sessions.
(() => {
	const { remote } = require('electron');
	const fs = require('node:fs');
	const path = require('node:path');
	const plugin = () => app.plugins.plugins['vault-librarian'];
	const view = () => app.workspace.getLeavesOfType('librarian-chat')[0].view;
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const results = { checks: [], sessions: [] };
	const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

	function check(name, ok, detail) {
		results.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
	}

	async function until(test, what, ms = 60000) {
		const end = Date.now() + ms;
		for (;;) {
			const value = await test();
			if (value) return value;
			if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
			await sleep(150);
		}
	}

	const providerOf = (id) => plugin().settings.providers.find((p) => p.id === id);

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
		// An error in the page comes back with its message instead of Electron's bare failure.
		const inPage = async (body, name = '', value = '') => {
			const result = await sw.webContents.executeJavaScript(
				`((name, value) => { try { ${body} } catch (e) { return { pageError: String(e.stack || e) }; } })(${JSON.stringify(name)}, ${JSON.stringify(value)})`,
			);
			if (result?.pageError) throw new Error(result.pageError);
			return result;
		};
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
		// `name` picks the row, `value` the icon button by its tooltip, in the top-most layer.
		const rowButton = (row, label) =>
			inPage(
				`const r = [...document.querySelectorAll('.setting-item')].findLast((i) => i.querySelector('.setting-item-name')?.textContent.trim() === name); const b = r && [...r.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === value); b?.click(); return !!b;`,
				row,
				label,
			);
		const button = (label) =>
			inPage(
				`const b = [...document.querySelectorAll('button')].findLast((e) => e.textContent.trim() === name); b?.click(); return !!b;`,
				label,
			);
		const modelRows = () =>
			inPage(
				`return [...document.querySelectorAll('.librarian-model-list .setting-item-description')].map((e) => e.textContent);`,
			);
		const suggestions = () =>
			inPage(
				`return [...document.querySelectorAll('.prompt .suggestion-item')].map((e) => e.textContent);`,
			);
		return { inPage, snap, open, rowButton, button, modelRows, suggestions };
	}

	async function add({ provider }) {
		const s = await settingsWindow();
		await s.open('Providers');
		const before = new Set(providerOf(provider).models.map((m) => m.id));
		check('the provider editor opens', await s.rowButton(providerOf(provider).name, 'Edit'));
		await sleep(900);
		for (let round = 0; round < 30; round++) {
			const count = (await s.modelRows()).length;
			await s.button('Add from server');
			let items = [];
			try {
				items = await until(
					async () => {
						const found = await s.suggestions();
						return found.length ? found : null;
					},
					'the server list',
					8000,
				);
			} catch {
				break; // Every model on the server is added: a notice instead of the list.
			}
			results.listed ??= items;
			await s.inPage(`document.querySelector('.prompt .suggestion-item').click();`);
			await until(async () => (await s.modelRows()).length > count, 'the model row', 30000);
		}
		results.rows = await s.modelRows();
		await s.snap('models-added');
		await s.button('Save');
		await sleep(1500);
		results.added = providerOf(provider).models.filter((m) => !before.has(m.id));
		check('models were added', results.added.length > 0, results.added.length);
	}

	async function detect({ provider, model }) {
		const s = await settingsWindow();
		await s.open('Providers');
		const before = structuredClone(providerOf(provider).models.find((m) => m.id === model));
		await s.rowButton(providerOf(provider).name, 'Edit');
		await sleep(900);
		await s.rowButton(before.name, 'Edit');
		const readForm = () =>
			s.inPage(
				`const top = [...document.querySelectorAll('.modal.librarian-modal')].at(-1);
				if (!top?.textContent.startsWith('Edit model')) return null;
				const row = (n) => [...top.querySelectorAll('.setting-item')].find((i) => i.querySelector('.setting-item-name')?.textContent === n);
				const on = (n) => row(n)?.querySelector('.checkbox-container')?.classList.contains('is-enabled');
				const value = (n) => row(n)?.querySelector('input')?.value;
				return {
					toolCalling: on('Tool calling'), reasoning: on('Reasoning'), images: on('Accepts images'),
					context: value('Context window'), output: value('Max output tokens'),
					levels: Object.fromEntries(${JSON.stringify(LEVELS)}.map((l) => [l, value(l)])),
					text: top.textContent,
				};`,
			);
		const shown = await until(readForm, 'the model editor', 10000);
		check('Detect sits in the model editor', await s.button('Detect'));
		const form = await until(
			async () => {
				const now = await readForm();
				return JSON.stringify({ ...now, text: '' }) !==
					JSON.stringify({ ...shown, text: '' }) ||
					/does not list|Connection failed/.test(now.text)
					? now
					: null;
			},
			'the detected details',
			30000,
		);
		await s.snap('model-detected');
		await s.button('Save');
		await sleep(700);
		await s.button('Save');
		await sleep(1500);
		const after = providerOf(provider).models.find((m) => m.id === model);
		results.detected = { before, form: { ...form, text: undefined }, after };
	}

	async function effort({ provider, cases, transport }) {
		const p = plugin();
		const prov = providerOf(provider);
		const kept = prov.transport;
		if (transport) prov.transport = transport;
		const bodies = [];
		const real = window.fetch;
		window.fetch = (input, init) => {
			const url = typeof input === 'string' ? input : (input?.url ?? String(input));
			if (/\/chat\/completions$/.test(url) && typeof init?.body === 'string')
				try {
					bodies.push(JSON.parse(init.body));
				} catch {}
			return real(input, init);
		};
		results.effort = [];
		try {
			await p.activateView();
			for (const [model, level] of cases) {
				await view().newSession();
				const rt = view().runtime;
				// A model may reach for a tool to multiply; the question needs none.
				const unsubscribe = rt.subscribe((e) => {
					if (e.type === 'approval' && e.request)
						setTimeout(() => e.request.resolve('reject'), 50);
				});
				await rt.setModel(provider, model, level);
				const seen = bodies.length;
				const t0 = Date.now();
				await rt.send('What is 17*23? Answer with the number only.');
				unsubscribe();
				results.sessions.push(rt.session.id);
				const events = await p.sessions.load(rt.session.id);
				const answer = events.filter((e) => e.type === 'assistant').at(-1);
				const error = events.filter((e) => e.type === 'error').at(-1);
				const body = bodies.length > seen ? bodies.at(-1) : null;
				results.effort.push({
					model,
					level,
					picked: rt.thinkingLevel,
					effective: rt.effectiveThinkingLevel,
					shown: document.querySelector('.librarian-model-effort')?.textContent ?? 'off',
					sent: body ? (body.reasoning_effort ?? '(none)') : '(not seen)',
					maxTokens: body?.max_tokens ?? body?.max_completion_tokens,
					thinking: (answer?.thinking || '').length,
					answer: (answer?.content || '').trim().slice(0, 40),
					...(error ? { error: error.message.slice(0, 300) } : {}),
					ms: Date.now() - t0,
				});
			}
		} finally {
			window.fetch = real;
			// Picking a model saves the settings, with the transport of the run.
			prov.transport = kept;
			await p.saveSettings();
		}
	}

	const steps = { add, detect, effort };
	window.__models = {
		state: 'idle',
		results,
		start(step, cfg = {}) {
			this.state = 'running';
			steps[step](cfg).then(
				() => (this.state = 'done'),
				(error) => {
					results.error = String(error?.stack || error);
					this.state = 'error';
				},
			);
			return this.state;
		},
	};
})();
