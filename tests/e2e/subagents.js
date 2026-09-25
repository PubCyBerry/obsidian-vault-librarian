// Sub-agents end to end (LIB-TEST-142, LIB-TEST-270, LIB-TEST-266), in a vault window with a
// provider and its key set. Load it through the Obsidian CLI with window.__e2eOut set to a
// folder for the screenshots, then start one step at a time and poll window.__subagents.state:
//
//   __subagents.start('parallel')   two explore agents side by side, their rows and the pane
//   __subagents.start('define')     the model writes an agent file, uses it and deletes it
//   __subagents.start('settings')   the Sub-agents page and the Custom system prompt
//
// Every approval card the run shows is approved. Results land in window.__subagents.results.
(() => {
	const { remote } = require('electron');
	const fs = require('node:fs');
	const path = require('node:path');
	const wc = remote.getCurrentWebContents();
	const OUT = window.__e2eOut;
	const plugin = () => app.plugins.plugins['vault-librarian'];
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const $ = (selector, root = document) => root.querySelector(selector);
	const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
	const chat = () => $('.workspace-leaf-content[data-type="librarian-chat"]');
	const results = {};

	async function until(check, what, ms = 60000) {
		const end = Date.now() + ms;
		for (;;) {
			const value = check();
			if (value) return value;
			if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
			await sleep(100);
		}
	}

	/** A screenshot, best effort: a window the system keeps from painting has none to give. */
	async function shot(name, el) {
		await sleep(400);
		const r = el?.getBoundingClientRect();
		const rect = r
			? {
					x: Math.max(0, Math.floor(r.left)),
					y: Math.max(0, Math.floor(r.top)),
					width: Math.ceil(r.width),
					height: Math.ceil(r.height),
				}
			: undefined;
		try {
			const image = await wc.capturePage(rect);
			fs.mkdirSync(OUT, { recursive: true });
			fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
		} catch (error) {
			results.shotErrors = [...(results.shotErrors ?? []), `${name}: ${error}`];
		}
	}

	async function ask(text) {
		const input = $('.librarian-input', chat());
		input.value = text;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await sleep(200);
		$('.librarian-send', chat()).click();
	}

	/** Waits for the run to end, approving each card; returns the tools the cards asked about. */
	async function run(onCard) {
		const c = plugin().controller;
		const asked = [];
		const end = Date.now() + 600000;
		await sleep(800);
		while (c.isRunning || c.state !== 'idle') {
			if (Date.now() > end) throw new Error('Timed out waiting for the run to end');
			const request = c.pendingApproval;
			if (request && !request.__seen) {
				request.__seen = true;
				asked.push({
					tool: request.name,
					key: request.permissionKey,
					agent: request.agentTitle ?? null,
					waiting: request.waiting,
				});
				if (onCard) await onCard(request);
				await sleep(300);
				request.resolve('approve');
			}
			await sleep(150);
		}
		await sleep(1000);
		return asked;
	}

	async function layout() {
		// In front, so the window paints and its screenshots have something in them.
		const win = remote.getCurrentWindow();
		win.show();
		win.focus();
		const ws = app.workspace;
		await plugin().activateView('sidebar');
		ws.rightSplit.expand();
		ws.rightSplit.setSize(470);
		await plugin().controller.newSession();
		await sleep(800);
	}

	const lastAnswer = () =>
		$$('.librarian-msg-assistant', chat()).at(-1)?.textContent.trim().slice(0, 600);

	const steps = {
		/** Two explore agents at once: their rows, the run head, the pane and the way back. */
		async parallel() {
			await layout();
			const c = plugin().controller;
			const heads = new Set();
			const watch = setInterval(() => {
				const text = $('.librarian-work-activity', chat())?.textContent;
				if (text) heads.add(text);
			}, 200);
			await ask(
				'Use two explore sub-agents at the same time: one lists each project folder in Projects with a one-line status, the other lists the decisions recorded in the notes in Meetings. Then combine their answers into one short summary with the note paths.',
			);
			// Look while they work: the rows and the pane of a running agent.
			const row = await until(
				() => $('.librarian-agent-row', chat()),
				'an agent row',
				180000,
			);
			await sleep(2500);
			await shot('agents-running', $('.librarian-messages', chat()));
			row.click();
			await until(
				() => !$('.librarian-agent-view', chat()).hasClass('is-hidden'),
				'the pane',
			);
			await sleep(3000);
			await shot('agent-pane-running', chat());
			$('.librarian-agent-back', chat()).click();
			await sleep(500);
			const asked = await run();
			clearInterval(watch);
			const header = $$('.librarian-work-header', chat()).at(-1);
			if ($$('.librarian-work', chat()).at(-1).hasClass('is-collapsed')) header.click();
			await sleep(800);
			await shot('agents-done', $('.librarian-messages', chat()));
			results.parallel = {
				asked,
				heads: [...heads],
				agents: [...c.agents.values()].map((a) => ({
					title: a.title,
					agent: a.agent,
					status: a.status,
					events: a.events.length,
					session: a.sessionId,
				})),
				rows: $$('.librarian-agent-row', chat()).map((r) => r.getAttribute('aria-label')),
				answer: lastAnswer(),
			};
			$('.librarian-agent-row', chat()).click();
			await until(
				() => !$('.librarian-agent-view', chat()).hasClass('is-hidden'),
				'the pane',
			);
			await sleep(1500);
			await shot('agent-pane-done', chat());
			results.parallel.pane = {
				head: $('.librarian-agent-head', chat()).textContent,
				asker: $('.librarian-msg-asker', chat())?.textContent ?? null,
				chips: $$('.librarian-agent-body .librarian-chip-name', chat()).map(
					(c) => c.textContent,
				),
			};
			$('.librarian-agent-back', chat()).click();
			await sleep(500);
			results.parallel.back = !$('.librarian-messages', chat()).hasClass('is-hidden');
		},

		/** The model writes an agent file, starts it, then deletes it; each change asks. */
		async define() {
			await layout();
			const defs = plugin().agentDefs;
			const file = '.agents/agents/note-critic.md';
			await ask(
				'Create a sub-agent definition named note-critic that reviews one note for unclear sentences and lists them with line numbers. It may only use read, grep and find. Save it in the agents folder.',
			);
			const made = await run(async (request) => {
				if (request.name === 'write')
					await shot('approve-agent-file', $('.librarian-approval', chat()));
			});
			results.define = {
				made,
				file: await app.vault.adapter.exists(file),
				agent: defs.get('note-critic') ?? null,
			};
			await ask('Use the note-critic agent on Projects/Pricing page/Pricing page.md.');
			const used = await run();
			const run2 = [...plugin().controller.agents.values()];
			results.define.used = {
				asked: used,
				runs: run2.map((a) => ({ agent: a.agent, status: a.status })),
				answer: lastAnswer(),
			};
			await ask('Now delete the note-critic agent.');
			const removed = await run();
			results.define.removed = {
				asked: removed,
				file: await app.vault.adapter.exists(file),
				agent: defs.get('note-critic') ?? null,
			};
		},

		/** The Sub-agents page, and the Custom system prompt with Restore default. */
		async settings() {
			app.setting.open();
			app.setting.openTabById('vault-librarian');
			// Its title is "Settings - <vault> - Obsidian" in the app's language: 설정 in Korean.
			const sw = await until(
				() =>
					remote.BrowserWindow.getAllWindows().find((w) =>
						new RegExp(`^(Settings|설정) - ${app.vault.getName()} - `).test(
							w.getTitle(),
						),
					),
				'the settings window',
			);
			sw.setContentSize(1000, 760);
			const inPage = (body, name = '') =>
				sw.webContents.executeJavaScript(
					`((name) => { ${body} })(${JSON.stringify(name)})`,
				);
			const snap = async (file) => {
				await sleep(900);
				const image = await sw.webContents.capturePage();
				fs.writeFileSync(path.join(OUT, `${file}.png`), image.toPNG());
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
			await open('Sub-agents');
			await snap('settings-subagents');
			await open('Agent');
			const before = await inPage(
				`const b = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Restore default'); return { shown: !!b && b.offsetParent !== null, text: document.querySelector('.librarian-prompt-setting textarea')?.value.slice(0, 60) };`,
			);
			await snap('settings-prompt');
			await inPage(
				`const t = document.querySelector('.librarian-prompt-setting textarea'); t.value = t.value + '\\nAlways answer in Korean.'; t.dispatchEvent(new Event('input', { bubbles: true }));`,
			);
			await sleep(600);
			const edited = await inPage(
				`const b = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Restore default'); return !!b && b.offsetParent !== null;`,
			);
			await snap('settings-prompt-edited');
			const stored = typeof plugin().settings.systemPrompt === 'string';
			await inPage(
				`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Restore default').click();`,
			);
			await sleep(600);
			await inPage(`document.querySelector('.modal .mod-warning')?.click();`);
			await sleep(800);
			results.settings = {
				before,
				edited,
				stored,
				restored: plugin().settings.systemPrompt === undefined,
				restoreHidden: await inPage(
					`const b = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Restore default'); return !b || b.offsetParent === null;`,
				),
			};
			app.setting.close();
		},
	};

	window.__subagents = {
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
