// Several sessions at once (LIB-TEST-279), in a vault window with scripted-provider.mjs running.
// Load it through the Obsidian CLI, then start it and poll window.__sessions.state:
//
//   __sessions.start()   session A asks for a folder listing (ls set to Ask first), the chat moves
//                        to a new session B while A waits for its approval, B answers, the banner
//                        opens A, A is approved and finishes unseen while B shows, the session list
//                        marks it, a draft survives the switch, and Stop on an Active row stops
//                        only that session
//
// Set window.__e2eOut to a folder for the screenshots. It adds a provider named Scripted (base URL
// http://127.0.0.1:18765/v1) and sets ls to Ask first; put the settings file back afterwards.
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
	const view = () => app.workspace.getLeavesOfType('librarian-chat')[0].view;
	const results = { checks: [], notices: [] };
	// This run's own words, so sessions an earlier run left in the list are never taken for its own.
	const stamp = Date.now().toString(36);
	const A = `What does the vault hold? ${stamp}`;
	const B = `A short question for B ${stamp}`;

	/** One observation: what was expected, and whether it held. */
	function check(name, ok, detail) {
		results.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
	}

	async function until(test, what, ms = 60000) {
		const end = Date.now() + ms;
		for (;;) {
			const value = test();
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
		const image = await wc.capturePage(rect);
		fs.mkdirSync(out, { recursive: true });
		fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG());
	}

	/** Notices as the user saw them. */
	const noted = new WeakSet();
	const seen = new MutationObserver(() => {
		for (const el of $$('.notice'))
			if (!noted.has(el)) {
				noted.add(el);
				results.notices.push(el.textContent);
			}
	});

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
		}
		p.settings.activeProviderId = 'scripted';
		p.settings.activeModelId = 'scripted';
		// A card to wait on: listing asks first while this runs.
		p.settings.toolPermissions.byTool.ls = 'approval_required';
		await p.saveSettings();
		const win = remote.getCurrentWindow();
		win.show();
		win.focus();
		await p.activateView('sidebar');
		app.workspace.rightSplit.expand();
		app.workspace.rightSplit.setSize(470);
		await view().newSession();
		await view().runtime.setModel('scripted', 'scripted');
		await sleep(300);
	}

	async function ask(text) {
		const input = $('.librarian-input', chat());
		input.value = text;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await sleep(150);
		$('.librarian-send', chat()).click();
	}

	const head = () => ({
		title: $('.librarian-session-head-title', chat())?.textContent,
		badge: $('.librarian-session-badge', chat())
			?.className.replace('librarian-session-badge', '')
			.trim(),
		count: $('.librarian-session-badge', chat())?.textContent,
		label: $('.librarian-session-switch', chat())?.getAttribute('aria-label'),
	});
	const banner = () =>
		$('.librarian-attention', chat())?.classList.contains('is-hidden')
			? ''
			: ($('.librarian-attention', chat())?.textContent ?? '');

	async function run() {
		seen.observe(document.body, { childList: true, subtree: true });
		await setup();
		const hub = plugin().hub;

		// A: its first response lists the root, which now asks first.
		const a = view().runtime;
		await ask(A);
		await until(() => a.pendingApproval, 'A to ask for ls', 30000);
		check(
			'A asks in its own chat, no banner',
			banner() === '' && $('.librarian-approval', chat()),
		);

		// B: a new session from the head while A waits.
		$('.librarian-session-new', chat()).click();
		await until(() => view().runtime !== a, 'the chat to show B');
		const b = view().runtime;
		await sleep(300);
		check('A keeps running', a.isRunning && a.pendingApproval !== null);
		check('B starts empty', head().title === 'New session', head());
		check(
			'the head counts A as asking',
			head().badge === 'is-asking' && head().count === '1',
			head(),
		);
		check('the banner names A', /waiting for your approval/.test(banner()), banner());
		check('no card in B', !$('.librarian-approval', chat()));
		await shot('b-with-banner', chat());

		// B answers while A waits; B's own ls card shows in B and is approved there.
		const approveB = setInterval(() => b.pendingApproval?.resolve('approve'), 200);
		await ask(B);
		await until(() => !b.isRunning && b.session, 'B to answer', 60000);
		clearInterval(approveB);
		check('B answered with A still waiting', a.pendingApproval !== null && !b.isRunning);

		// A draft in B, kept across the switch.
		const input = $('.librarian-input', chat());
		input.value = 'half a thought for B';
		input.dispatchEvent(new Event('input', { bubbles: true }));

		// The banner opens A, with its card.
		$('.librarian-attention button', chat()).click();
		// A still runs, so the chat shows the very runtime that waits.
		await until(() => view().runtime === a, 'the chat to show A');
		check('A shows its card', $('.librarian-approval', chat()));
		check('the banner is gone in A', banner() === '');
		check('the input is empty in A', $('.librarian-input', chat()).value === '');
		a.pendingApproval.resolve('approve');
		await until(() => a.state === 'streaming', 'A to answer', 30000);

		// Back to B from the list while A answers.
		$('.librarian-session-switch', chat()).click();
		await until(
			() => !$('.librarian-sessions', chat()).classList.contains('is-hidden'),
			'the list',
		);
		const recent = await until(
			() =>
				$$('.librarian-session-row:not(.is-active) .librarian-session-main', chat()).find(
					(el) => el.textContent.includes(B),
				),
			'B in the list',
		);
		recent.click();
		// B rested unseen, so the hub let its runtime go; the chat reads B again from its log.
		await until(() => view().runtime.session?.id === b.session.id, 'the chat to show B again');
		check(
			'the draft came back',
			$('.librarian-input', chat()).value === 'half a thought for B',
		);
		check('the head counts A as running', head().badge === 'is-running', head());
		$('.librarian-session-switch', chat()).click();
		await until(() => $('.librarian-sessions-active', chat()), 'the Active group');
		const runningRow = $('.librarian-sessions-active .librarian-session-row', chat());
		check(
			'the Active row says A runs, with Stop',
			runningRow?.classList.contains('is-running') &&
				$('.librarian-session-stop', runningRow),
			runningRow?.textContent,
		);
		await shot('active-running', chat());

		// A ends unseen: a Notice, a dot, and its answer's first line.
		await until(() => !a.isRunning, 'A to finish', 60000);
		await sleep(400);
		const endedRow = $('.librarian-sessions-active .librarian-session-row', chat());
		check(
			'A is marked finished',
			endedRow?.classList.contains('is-unread'),
			endedRow?.textContent,
		);
		check('its line is the answer', /What the vault holds/.test(endedRow?.textContent ?? ''));
		check('the head shows a dot', head().badge === 'is-unread', head());
		check(
			'a Notice said A finished',
			results.notices.some((n) => /" finished\./.test(n)),
			results.notices,
		);
		await shot('active-finished', chat());

		// Opening A clears the mark.
		$$('.librarian-sessions-active .librarian-session-main', chat())
			.find((el) => el.textContent.includes(A))
			.click();
		await until(() => view().runtime.session?.id === a.session.id, 'A again');
		await sleep(300);
		check('the mark is gone', !hub.entries().some((e) => e.sessionId === a.session.id));

		// Stop from an Active row stops that session only.
		await ask('Once more, please.');
		await until(() => view().runtime.pendingApproval, 'A to ask again', 30000);
		const again = view().runtime;
		$('.librarian-session-switch', chat()).click();
		const rowB = await until(
			() =>
				$$('.librarian-session-row:not(.is-active) .librarian-session-main', chat()).find(
					(el) => el.textContent.includes(B),
				),
			'B in the list',
		);
		rowB.click();
		await until(() => view().runtime.session?.id === b.session.id, 'B once more');
		$('.librarian-session-switch', chat()).click();
		const stop = await until(
			() =>
				$$('.librarian-sessions-active .librarian-session-row', chat())
					.find((row) => row.textContent.includes(A))
					?.querySelector('.librarian-session-stop'),
			'Stop on A',
		);
		stop.click();
		await until(() => !again.isRunning, 'A to stop', 20000);
		check('Stop ended A', !again.isRunning);
		check('B untouched', view().runtime.session?.id === b.session.id);
		await sleep(400);
		check(
			'a stopped session is not marked',
			!hub.entries().some((e) => e.sessionId === again.session.id),
		);
		$('.librarian-session-switch', chat()).click();
		seen.disconnect();
		results.sessions = [a.session.id, b.session.id];
	}

	window.__sessions = {
		state: { running: false, error: null },
		results,
		start() {
			this.state = { running: true, error: null };
			run()
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
