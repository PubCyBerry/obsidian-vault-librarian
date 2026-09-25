// Runs inside the demo vault window and records the README media: screenshots with capturePage,
// and screen recordings as frames from the DevTools screencast. record.mjs loads it through the
// Obsidian CLI, starts one scene at a time with `__demo.start(name, options)` and polls
// `__demo.state`.
//
// The model is real (GPT-6 Luna), so every run words things differently: a scene waits for what
// it needs and approves each card the run shows. The key comes from OPENAI_API_KEY in the
// environment of the Obsidian process, goes into this vault's keychain for the recording and is
// cleared at the end. The pointer and the typing are drawn in the page, so nothing reaches the
// real mouse or keyboard. A recording shows the pointer and takes no screenshots; every other run
// hides the pointer, so a scene that gives both runs twice.
(() => {
	const { remote } = require('electron');
	const fs = require('node:fs');
	const path = require('node:path');
	const win = remote.getCurrentWindow();
	const wc = remote.getCurrentWebContents();
	const OUT = window.__demoOut;
	const NOTE = 'Projects/Onboarding redesign/Onboarding redesign.md';
	const KEY_ID = 'vault-librarian-openai';
	const phone = document.body.hasClass('is-phone');

	const plugin = () => app.plugins.plugins['vault-librarian'];
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const $ = (selector, root = document) => root.querySelector(selector);
	const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
	const chat = () => $('.workspace-leaf-content[data-type="librarian-chat"]');
	const workBlock = () => $$('.librarian-work', chat()).at(-1);

	async function until(check, what, ms = 30000) {
		const end = Date.now() + ms;
		for (;;) {
			const value = check();
			if (value) return value;
			if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
			await sleep(50);
		}
	}

	// Pointer: an arrow on the desktop, a fingertip on the phone.

	for (const old of $$('.demo-pointer')) old.remove();
	const pointer = document.body.createDiv({ cls: 'demo-pointer' });
	const size = phone ? 34 : 24;
	pointer.style.cssText = `position:fixed;left:0;top:0;width:${size}px;height:${size}px;z-index:2147483647;pointer-events:none;transition:transform 560ms cubic-bezier(.3,.7,.2,1)`;
	if (phone)
		Object.assign(pointer.style, {
			borderRadius: '50%',
			background: 'rgba(255,255,255,.4)',
			border: '2px solid rgba(255,255,255,.85)',
			marginLeft: `-${size / 2}px`,
			marginTop: `-${size / 2}px`,
		});
	else
		pointer.innerHTML =
			'<svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 2.5v17l4.6-4.3 3.3 7.3 3-1.4-3.3-7.1 6.3-.2z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
	let at = { x: innerWidth * 0.62, y: innerHeight * 0.6 };
	let recording = false;
	const place = () => {
		pointer.style.transform = `translate(${at.x}px, ${at.y}px)`;
		pointer.style.display = recording ? '' : 'none';
	};
	place();

	async function moveTo(el, fx = 0.5, fy = 0.5) {
		el.scrollIntoView({ block: 'nearest' });
		const r = el.getBoundingClientRect();
		at = { x: r.left + r.width * fx, y: r.top + r.height * fy };
		place();
		await sleep(recording ? 620 : 150);
	}

	async function click(el, fx, fy) {
		await moveTo(el, fx, fy);
		const ring = document.body.createDiv();
		ring.style.cssText = `position:fixed;left:${at.x - 16}px;top:${at.y - 16}px;width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.35);z-index:2147483646;pointer-events:none`;
		ring.animate(
			[
				{ opacity: 0.9, transform: 'scale(.3)' },
				{ opacity: 0, transform: 'scale(1.3)' },
			],
			{ duration: 420 },
		).onfinish = () => ring.remove();
		await sleep(110);
		el.click();
		await sleep(380);
	}

	async function ask(text, perSecond = 26) {
		const input = $('.librarian-input', chat());
		await click(input, 0.3, 0.5);
		input.focus();
		for (let i = 1; i <= text.length; i++) {
			input.value = text.slice(0, i);
			input.dispatchEvent(new Event('input', { bubbles: true }));
			await sleep(recording ? (1000 / perSecond) * (0.5 + Math.random()) : 5);
		}
		await sleep(400);
		await click($('.librarian-send', chat()));
	}

	/**
	 * Waits for the run to end and approves each card it shows on the way. `shots` names the
	 * screenshot to take of the first card of a tool, such as `{ write: 'approve-write' }`.
	 */
	async function run(shots = {}) {
		const c = plugin().controller;
		const end = Date.now() + 300000;
		await sleep(500);
		while (c.isRunning || c.state !== 'idle') {
			if (Date.now() > end) throw new Error('Timed out waiting for the run to end');
			const card = $$('.librarian-approval', chat()).find(
				(el) => !el.dataset.demoSeen && $('.mod-cta', el),
			);
			if (card) {
				card.dataset.demoSeen = '1';
				await sleep(1500);
				const tool = $('.librarian-approval-title', card)?.textContent.match(
					/Approve (\S+)\?/,
				)?.[1];
				if (tool && shots[tool]) {
					card.scrollIntoView({ block: 'nearest' });
					await shot(shots[tool], card, 12);
					delete shots[tool];
				}
				await click($('.mod-cta', card));
			}
			await sleep(100);
		}
		await sleep(1500);
	}

	/** The chip of the last call to one of `names` in the last work block. */
	function chip(...names) {
		const chips = $$('.librarian-chip', workBlock());
		for (const name of names) {
			const found = chips.findLast(
				(c) => c.querySelector('.librarian-chip-name')?.textContent === name,
			);
			if (found) return found;
		}
		return null;
	}

	async function lookInside(names, shotName) {
		const block = workBlock();
		if (block.hasClass('is-collapsed')) await click($('.librarian-work-header', block), 0.2);
		await sleep(600);
		const target = chip(...names);
		if (!target) return;
		await click(target, 0.4);
		await sleep(1600);
		await shot(shotName, $('.librarian-messages', chat()));
		await click($('.librarian-step-pop-close'));
		await click($('.librarian-work-header', block), 0.2);
	}

	async function fileInExplorer(filePath) {
		const explorer = app.workspace.getLeavesOfType('file-explorer')[0].view;
		explorer.revealInFolder(app.vault.getFileByPath(filePath));
		await sleep(300);
		return until(
			() => $(`.nav-file-title[data-path="${CSS.escape(filePath)}"]`),
			`${filePath} in the file explorer`,
		);
	}

	// Output

	/** The window, or the smallest box around `els` (an element or a list) and `pad` around it. */
	async function shot(name, els, pad = 0) {
		if (recording) return;
		await sleep(300);
		let rect;
		if (els) {
			const boxes = [els].flat().map((el) => el.getBoundingClientRect());
			const left = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.left)) - pad));
			const top = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.top)) - pad));
			const right = Math.min(
				innerWidth,
				Math.ceil(Math.max(...boxes.map((b) => b.right)) + pad),
			);
			const bottom = Math.min(
				innerHeight,
				Math.ceil(Math.max(...boxes.map((b) => b.bottom)) + pad),
			);
			rect = { x: left, y: top, width: right - left, height: bottom - top };
		}
		const image = await wc.capturePage(rect);
		fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
		fs.writeFileSync(path.join(OUT, 'shots', `${name}.png`), image.toPNG());
	}

	const recorder = {
		async start(name, scale) {
			this.dir = path.join(OUT, 'frames', name);
			fs.rmSync(this.dir, { recursive: true, force: true });
			fs.mkdirSync(this.dir, { recursive: true });
			this.frames = [];
			this.marks = {};
			const debug = wc.debugger;
			if (!debug.isAttached()) debug.attach('1.3');
			this.listener = (_event, method, params) => {
				if (method !== 'Page.screencastFrame') return;
				const file = path.join(
					this.dir,
					`${String(this.frames.length).padStart(5, '0')}.jpg`,
				);
				fs.writeFileSync(file, Buffer.from(params.data, 'base64'));
				this.frames.push({ file, t: params.metadata.timestamp });
				debug.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId });
			};
			debug.on('message', this.listener);
			await debug.sendCommand('Page.startScreencast', {
				format: 'jpeg',
				quality: 92,
				maxWidth: Math.round(innerWidth * scale),
				maxHeight: Math.round(innerHeight * scale),
			});
			await sleep(600);
		},
		mark(label) {
			if (recording) this.marks[label] = this.frames.at(-1)?.t ?? 0;
		},
		async stop() {
			await sleep(800);
			const debug = wc.debugger;
			await debug.sendCommand('Page.stopScreencast');
			debug.removeListener('message', this.listener);
			const start = this.frames[0].t;
			// The screencast sends a frame only when the page changes, so each frame lasts until
			// the next one; ffmpeg's concat demuxer takes that as a duration per file.
			const lines = this.frames.flatMap((f, i) => [
				`file '${f.file.replaceAll('\\', '/')}'`,
				`duration ${((this.frames[i + 1]?.t ?? f.t + 1) - f.t).toFixed(4)}`,
			]);
			lines.push(`file '${this.frames.at(-1).file.replaceAll('\\', '/')}'`);
			fs.writeFileSync(path.join(this.dir, 'frames.txt'), `${lines.join('\n')}\n`);
			const marks = Object.fromEntries(
				Object.entries(this.marks).map(([k, t]) => [k, Number((t - start).toFixed(3))]),
			);
			fs.writeFileSync(path.join(this.dir, 'marks.json'), JSON.stringify(marks, null, '\t'));
		},
	};

	// Scenes

	async function configure() {
		const key = process.env.OPENAI_API_KEY;
		if (!key) throw new Error('OPENAI_API_KEY is not set for the Obsidian process.');
		const p = plugin();
		p.settings.providers = [
			{
				id: 'openai',
				name: 'OpenAI',
				baseUrl: 'https://api.openai.com/v1',
				api: 'openai-completions',
				secretId: KEY_ID,
				authHeader: true,
				transport: 'auto',
				compat: {},
				requestDefaults: {
					stream: true,
					timeoutMs: 120000,
					maxRetries: 2,
					thinkingLevel: 'low',
				},
				models: [
					{
						id: 'gpt-6-luna',
						name: 'GPT-6 Luna',
						api: 'openai-responses',
						toolCalling: true,
						reasoning: true,
						input: ['text', 'image'],
						contextWindow: 272000,
						maxTokens: 128000,
						cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
						thinkingLevelMap: {
							off: 'none',
							minimal: null,
							low: 'low',
							medium: 'medium',
							high: 'high',
							xhigh: 'xhigh',
							max: 'max',
						},
					},
				],
			},
		];
		p.settings.activeProviderId = 'openai';
		p.settings.activeModelId = 'gpt-6-luna';
		p.settings.chatLocation = 'sidebar';
		p.secrets.set(KEY_ID, key);
		await p.saveSettings();
		await p.controller.setModel('openai', 'gpt-6-luna');
	}

	async function layout() {
		win.setAlwaysOnTop(true, 'screen-saver');
		win.show();
		win.setContentSize(1440, 900);
		win.center();
		const ws = app.workspace;
		// Open the note in the main tab first: closing the last tab leaves a new empty one behind.
		const main = ws.getLeaf(false);
		await main.openFile(app.vault.getFileByPath(NOTE), { state: { mode: 'preview' } });
		for (const leaf of [...ws.getLeavesOfType('markdown'), ...ws.getLeavesOfType('empty')])
			if (leaf !== main) leaf.detach();
		ws.leftSplit.expand();
		const explorer = ws.getLeavesOfType('file-explorer')[0];
		await ws.revealLeaf(explorer);
		for (const folder of Object.keys(explorer.view.fileItems))
			explorer.view.fileItems[folder].setCollapsed?.(
				!['Meetings', 'Projects', 'Projects/Onboarding redesign'].includes(folder),
			);
		await plugin().activateView('sidebar');
		ws.rightSplit.expand();
		await plugin().controller.newSession();
		$('.librarian-input', chat()).value = '';
		await sleep(600);
		ws.leftSplit.setSize(270);
		ws.rightSplit.setSize(470);
		await sleep(900);
	}

	const scenes = {
		async setup() {
			await configure();
			await layout();
		},

		/** Ask, look inside, change notes with approval, rewind. */
		async tour({ record = false } = {}) {
			await layout();
			recording = record;
			place();
			if (record) await recorder.start('tour', 1);
			recorder.mark('ask');
			await ask('What did we decide about the onboarding checklist, and what is still open?');
			await run();
			recorder.mark('answered');
			await sleep(1500);
			await shot('window');
			await shot('answer', $('.librarian-messages', chat()));
			await lookInside(['grep', 'find', 'read'], 'timeline');
			recorder.mark('timeline');

			const source = $('.librarian-source', chat());
			if (source) {
				await click(source, 0.3);
				await sleep(2200);
			}
			recorder.mark('source');

			await ask(
				"Collect the open action items from this month's meetings into Inbox/Action items.md, grouped by owner.",
			);
			await run({ write: 'approve-write' });
			if (app.vault.getFileByPath('Inbox/Action items.md')) {
				await click(await fileInExplorer('Inbox/Action items.md'), 0.3);
				await sleep(2200);
			}
			recorder.mark('written');

			await click(await fileInExplorer(NOTE), 0.3);
			await sleep(900);
			await ask(
				'Priya sent the empty-state copy. Tick it off in the onboarding project note.',
			);
			await run({ edit: 'approve-edit' });
			await sleep(1200);
			recorder.mark('edited');

			const second = $$('.librarian-msg-user', chat())[1];
			await click($('.librarian-rewind', second));
			const confirm = await until(
				() => $('.modal-container .mod-warning'),
				'the rewind dialog',
			);
			await sleep(1600);
			await shot('rewind');
			await click(confirm);
			await sleep(2600);
			recorder.mark('rewound');
			if (record) await recorder.stop();
			recording = false;
			place();
		},

		/** The shell and the web: curl and jq in one approved command. */
		async web() {
			await plugin().controller.newSession();
			await sleep(800);
			await ask(
				'Look up the latest Obsidian release on GitHub and tell me when it came out.',
			);
			await run({ bash: 'approve-bash' });
			await lookInside(['bash'], 'shell');
		},

		async context() {
			const ring = $('.librarian-context-indicator', chat());
			await moveTo(ring);
			ring.dispatchEvent(new MouseEvent('mouseenter'));
			await sleep(700);
			await shot(
				'context',
				[$('.librarian-context-popover', chat()), $('.librarian-composer', chat())],
				12,
			);
			ring.dispatchEvent(new MouseEvent('mouseleave'));
		},

		/**
		 * Obsidian 1.13 shows the settings in a window of their own, so this scene works in that
		 * window's page and takes its screenshots there. Dialogs opened from the settings open there too.
		 */
		async settings() {
			app.setting.open();
			app.setting.openTabById('vault-librarian');
			const sw = await until(
				() =>
					remote.BrowserWindow.getAllWindows().find((w) =>
						w.getTitle().startsWith('Settings'),
					),
				'the settings window',
			);
			sw.setAlwaysOnTop(true, 'screen-saver');
			sw.setContentSize(1000, 760);
			sw.center();
			// Runs `body` in the settings page with `name` and `value` bound, and returns its value.
			const inPage = (body, name = '', value = '') =>
				sw.webContents.executeJavaScript(
					`((name, value) => { ${body} })(${JSON.stringify(name)}, ${JSON.stringify(value)})`,
				);
			const clickRow = (name) =>
				inPage(
					`const row = [...document.querySelectorAll('.setting-item')].findLast((i) => i.querySelector('.setting-item-name')?.textContent === name); row?.click(); return !!row;`,
					name,
				);
			const clickButton = (name) =>
				inPage(
					`const b = [...document.querySelectorAll('button, [aria-label]')].findLast((b) => b.textContent === name || b.getAttribute('aria-label') === name); b?.click(); return !!b;`,
					name,
				);
			const fill = (name, value) =>
				inPage(
					`const row = [...document.querySelectorAll('.modal .setting-item')].findLast((i) => i.querySelector('.setting-item-name')?.textContent === name); const input = row?.querySelector('input'); if (!input) return false; input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); return true;`,
					name,
					value,
				);
			const waitFor = async (selector, what) => {
				const end = Date.now() + 30000;
				while (!(await inPage(`return !!document.querySelector(name);`, selector))) {
					if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
					await sleep(200);
				}
			};
			// The whole window, or the box of the last element matching `selector` with `pad` around it.
			const snap = async (file, selector, pad = 0) => {
				await sleep(700);
				const rect = selector
					? await inPage(
							`const r = [...document.querySelectorAll(name)].at(-1).getBoundingClientRect(); const p = Number(value); const x = Math.max(0, Math.floor(r.left - p)), y = Math.max(0, Math.floor(r.top - p)); return { x, y, width: Math.min(innerWidth - x, Math.ceil(r.width + 2 * p)), height: Math.min(innerHeight - y, Math.ceil(r.height + 2 * p)) };`,
							selector,
							String(pad),
						)
					: undefined;
				const image = await sw.webContents.capturePage(rect);
				fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
				fs.writeFileSync(path.join(OUT, 'shots', `${file}.png`), image.toPNG());
			};
			const home = async () => {
				app.setting.openTabById('vault-librarian');
				await sleep(900);
			};
			const open = async (page) => {
				await home();
				if (!(await clickRow(page))) throw new Error(`No ${page} row in the settings`);
				await sleep(900);
			};

			await home();
			await snap('settings');
			await open('Tool permissions');
			await snap('permissions');
			await open('Providers');
			await snap('providers');

			if (!(await clickButton('Add provider'))) throw new Error('No Add provider button');
			await waitFor('.modal.librarian-modal', 'the provider editor');
			await fill('Name', 'OpenAI');
			await fill('Base URL', 'https://api.openai.com/v1');
			await inPage(
				`const select = [...document.querySelectorAll('.modal .setting-item')].find((i) => i.querySelector('.setting-item-name')?.textContent === 'API')?.querySelector('select'); if (select) { select.value = 'openai-responses'; select.dispatchEvent(new Event('change', { bubbles: true })); }`,
			);
			await snap('add-provider', '.modal.librarian-modal');
			await clickButton('Cancel');
			await sleep(500);

			await inPage(`document.querySelector('[aria-label="Edit"]')?.click();`);
			await waitFor('.modal.librarian-modal', 'Edit provider');
			await clickButton('Add from server');
			const picker = '.prompt-input[placeholder="Pick a model the server lists"]';
			await waitFor(picker, 'the server model picker');
			await inPage(
				`const input = document.querySelector(name); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));`,
				picker,
				'gpt-6',
			);
			await snap('add-from-server', '.prompt', 24);
			await inPage(
				`document.querySelector(name).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`,
				picker,
			);
			await sleep(400);
			await clickButton('Cancel');
			await sleep(400);
			sw.setAlwaysOnTop(false);
			app.setting.close();
		},

		/** The phone: the same agent in Obsidian's phone layout. */
		async mobile({ record = false } = {}) {
			win.setAlwaysOnTop(true, 'screen-saver');
			win.show();
			await plugin().activateView();
			await sleep(800);
			await plugin().controller.newSession();
			$('.librarian-input', chat()).value = '';
			await sleep(800);
			recording = record;
			place();
			if (record) await recorder.start('mobile', devicePixelRatio);
			await ask('What is still open in the onboarding project, and who owns it?');
			await run();
			recorder.mark('answered');
			await sleep(1500);
			await shot('mobile');
			await lookInside(['read', 'grep', 'find'], 'mobile-timeline');
			if (record) await recorder.stop();
			recording = false;
			place();
		},

		async finish() {
			plugin().secrets.clear(KEY_ID);
			win.setAlwaysOnTop(false);
			pointer.remove();
		},
	};

	window.__demo = {
		state: { scene: null, running: false, error: null },
		start(name, options) {
			this.state = { scene: name, running: true, error: null };
			scenes[name](options)
				.catch((error) => {
					this.state.error = String(error?.stack ?? error);
				})
				.finally(() => {
					this.state.running = false;
				});
			return name;
		},
	};
})();
