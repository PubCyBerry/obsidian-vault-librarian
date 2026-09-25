// Streaming on screen (LIB-TEST-272), in a vault window with scripted-provider.mjs running. Load it
// through the Obsidian CLI, then start one step at a time and poll window.__streaming.state:
//
//   __streaming.start('note')     a note, a call and a Markdown answer: the note is a chip from its
//                                 first word, grows, is kept when it is saved, and the answer is
//                                 Markdown while it streams
//   __streaming.start('agents')   an explore sub-agent: its pane's spinner keeps turning and the
//                                 pane is not drawn anew while the agent's answer streams
//
// Set window.__e2eOut to a folder for the screenshots. The first step adds a provider named
// Scripted (base URL http://127.0.0.1:18765/v1, the OpenAI key slot) and picks it; put the
// settings file back afterwards. Every approval card is approved.
(() => {
	const { remote } = require('electron');
	const fs = require('node:fs');
	const path = require('node:path');
	const wc = remote.getCurrentWebContents();
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
			await sleep(50);
		}
	}

	async function shot(name, el) {
		const out = window.__e2eOut;
		if (!out) return;
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
			fs.mkdirSync(out, { recursive: true });
			fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG());
		} catch (error) {
			results.shotErrors = [...(results.shotErrors ?? []), `${name}: ${error}`];
		}
	}

	async function setup() {
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
						reasoning: true,
						input: ['text'],
						contextWindow: 128000,
						maxTokens: 8192,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			});
			await p.saveSettings();
		}
		const win = remote.getCurrentWindow();
		win.show();
		win.focus();
		await p.activateView('sidebar');
		app.workspace.rightSplit.expand();
		app.workspace.rightSplit.setSize(470);
		await p.controller.newSession();
		await p.controller.setModel('scripted', 'scripted');
		await sleep(500);
	}

	async function ask(text) {
		const input = $('.librarian-input', chat());
		input.value = text;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await sleep(200);
		$('.librarian-send', chat()).click();
	}

	/** The spinner's turn in degrees, from its transform. */
	function angle(el) {
		const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform);
		if (!m) return null;
		const [a, b] = m[1].split(',').map(Number);
		return Math.round((Math.atan2(b, a) * 180) / Math.PI);
	}

	const steps = {
		/** A note, a call and a Markdown answer. */
		async note() {
			await setup();
			const c = plugin().controller;
			const samples = [];
			let lastChip = null;
			let chipIds = 0;
			const ids = new WeakMap();
			const idOf = (el) => {
				if (!el) return null;
				if (!ids.has(el)) ids.set(el, ++chipIds);
				return ids.get(el);
			};
			const watch = setInterval(() => {
				const box = $$('.librarian-message', chat()).at(-1);
				const answer = $$('.librarian-msg-assistant', chat()).at(-1);
				if (box !== lastChip) lastChip = box;
				samples.push({
					t: Math.round(performance.now()),
					running: c.isRunning,
					chip: idOf(box),
					chips: $$('.librarian-message', chat()).length,
					width: box ? Math.round(box.getBoundingClientRect().width) : 0,
					height: box ? Math.round(box.getBoundingClientRect().height) : 0,
					growing: box?.classList.contains('is-growing') ?? false,
					chipText: box?.textContent.length ?? 0,
					chipHeading: box ? $$('h1, h2, h3', box).length : 0,
					answer: idOf(answer),
					answerText: answer?.textContent.length ?? 0,
					pre: answer ? $$('pre', answer).length : 0,
					table: answer ? $$('table', answer).length : 0,
					fading: answer ? $$('.librarian-reveal', answer).length : 0,
				});
			}, 50);
			await ask('Describe the layout of this vault.');
			await until(() => $('.librarian-message', chat()), 'a note chip', 30000);
			await sleep(1200);
			await shot('note-growing', $('.librarian-messages', chat()));
			// The answer streaming in its own place, already drawn as Markdown.
			await until(
				() => c.isRunning && $('.librarian-msg-assistant pre', chat()),
				'the answer drawn as Markdown',
				60000,
			);
			await shot('answer-streaming', $('.librarian-messages', chat()));
			await until(() => !c.isRunning && c.state === 'idle', 'the run to end', 60000);
			await sleep(800);
			clearInterval(watch);
			await shot('answer-done', $('.librarian-messages', chat()));
			// Where the chip's text went down between two samples while the chip stayed.
			const drops = samples.filter(
				(s, i) =>
					i > 0 && s.chip === samples[i - 1].chip && s.chipText < samples[i - 1].chipText,
			);
			const vanished = samples.filter(
				(s, i) =>
					i > 0 &&
					s.chips < samples[i - 1].chips &&
					s.answerText <= samples[i - 1].answerText,
			);
			results.note = {
				samples: samples.length,
				chipsAtEnd: $$('.librarian-message', chat()).map((b) => b.textContent.slice(0, 80)),
				answer: $$('.librarian-msg-assistant', chat()).at(-1)?.textContent.slice(0, 120),
				answerMarkdown: {
					h2: $$('.librarian-msg-assistant h2', chat()).length,
					pre: $$('.librarian-msg-assistant pre', chat()).length,
					table: $$('.librarian-msg-assistant table', chat()).length,
				},
				maxWidth: Math.max(...samples.map((s) => s.width)),
				widths: [...new Set(samples.filter((s) => s.chip === 1).map((s) => s.width))],
				growingSeen: samples.some((s) => s.growing),
				// The answer opens with a heading: it never shows in a chip.
				headingInChip: samples.some((s) => s.chipHeading > 0),
				// Once shown, the answer never left the page, not even while it was saved.
				answerGaps: samples.filter(
					(s, i) => i > 0 && samples[i - 1].answerText > 0 && s.answerText === 0,
				).length,
				markdownWhileStreaming: samples.some(
					(s) => s.running && s.pre > 0 && s.table === 0,
				),
				tableWhileStreaming: samples.some((s) => s.running && s.table > 0),
				maxFading: Math.max(...samples.map((s) => s.fading)),
				drops: drops.slice(0, 5),
				vanished: vanished.slice(0, 5),
				timeline: samples.filter((_, i) => i % 10 === 0).slice(0, 60),
			};
		},

		/** An explore sub-agent: the pane while its answer streams. */
		async agents() {
			await setup();
			const c = plugin().controller;
			const approve = setInterval(() => c.pendingApproval?.resolve('approve'), 200);
			await ask('Use agents to look through the projects.');
			const row = await until(() => $('.librarian-agent-row', chat()), 'an agent row', 60000);
			row.click();
			await until(
				() => !$('.librarian-agent-view', chat()).classList.contains('is-hidden'),
				'the pane',
			);
			const body = $('.librarian-agent-body', chat());
			let redraws = 0;
			const observer = new MutationObserver((list) => {
				for (const m of list) if (m.target === body && m.removedNodes.length) redraws++;
			});
			observer.observe(body, { childList: true });
			const spinners = [];
			const samples = [];
			const t0 = performance.now();
			while (performance.now() - t0 < 15000) {
				const spinner = $(
					'.librarian-work.is-running .librarian-work-header .librarian-spinner',
					body,
				);
				if (spinner && !spinners.includes(spinner)) spinners.push(spinner);
				samples.push({
					t: Math.round(performance.now() - t0),
					spinner: spinner ? spinners.indexOf(spinner) : null,
					angle: spinner ? angle(spinner) : null,
					status: c.agents.get(row.dataset.agentCallId)?.status,
					streaming: !!c.agents.get(row.dataset.agentCallId)?.stream,
					chip: $$('.librarian-message', body).at(-1)?.textContent.length ?? 0,
				});
				if (samples.length === 40) await shot('agent-pane-streaming', chat());
				if (c.agents.get(row.dataset.agentCallId)?.status === 'done') break;
				await sleep(100);
			}
			observer.disconnect();
			// How far the turn moved between two samples, against how far the clock says it should.
			const steps = samples
				.map((s, i) => {
					const p = samples[i - 1];
					if (!p || s.angle === null || p.angle === null) return null;
					const moved = (((s.angle - p.angle) % 360) + 360) % 360;
					const expected = ((((s.t - p.t) * 0.45) % 360) + 360) % 360;
					const off = Math.min(
						Math.abs(moved - expected),
						360 - Math.abs(moved - expected),
					);
					return {
						t: s.t,
						moved,
						expected: Math.round(expected),
						off: Math.round(off),
						same: s.spinner === p.spinner,
						streaming: s.streaming,
					};
				})
				.filter(Boolean);
			const streaming = steps.filter((s) => s.streaming);
			results.agents = {
				spinners: spinners.length,
				redraws,
				samples: samples.length,
				streamingSamples: streaming.length,
				// A restart shows as a step far off the clock.
				offClock: steps.filter((s) => s.off > 40).slice(0, 10),
				sameWhileStreaming: streaming.every((s) => s.same),
				steps: steps.slice(0, 40),
			};
			$('.librarian-agent-back', chat()).click();
			await until(() => !c.isRunning && c.state === 'idle', 'the run to end', 60000);
			clearInterval(approve);
			results.agents.answer = $$('.librarian-msg-assistant', chat()).at(-1)?.textContent;
		},
	};

	window.__streaming = {
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
