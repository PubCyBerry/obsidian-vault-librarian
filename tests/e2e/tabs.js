// Chats in tabs (LIB-TEST-280), in a vault window with scripted-provider.mjs running. Load it
// through the Obsidian CLI, then start it and poll window.__tabs.state:
//
//   __tabs.start()   a second chat in a new tab starts on a new session, both chats can show one
//                    session and its approval card, the layout keeps each chat's session, a chat
//                    closed while its session runs leaves it running, closing the last chat says
//                    so, and the commands go to the chat used last
//
// It adds a provider named Scripted (base URL http://127.0.0.1:18765/v1) and sets ls to Ask first;
// put the settings file back afterwards.
(() => {
	const plugin = () => app.plugins.plugins['vault-librarian'];
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
	const chats = () => app.workspace.getLeavesOfType('librarian-chat').map((l) => l.view);
	const results = { checks: [], notices: [] };
	const stamp = Date.now().toString(36);

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
		if (!p.settings.providers.some((x) => x.id === 'scripted'))
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
		p.settings.activeProviderId = 'scripted';
		p.settings.activeModelId = 'scripted';
		p.settings.toolPermissions.byTool.ls = 'approval_required';
		await p.saveSettings();
	}

	async function ask(view, text) {
		const input = view.contentEl.querySelector('.librarian-input');
		input.value = text;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await sleep(150);
		view.contentEl.querySelector('.librarian-send').click();
	}

	async function run() {
		seen.observe(document.body, { childList: true, subtree: true });
		await setup();
		const p = plugin();
		const side = await p.activateView('sidebar');
		await side.newSession();
		await side.runtime.setModel('scripted', 'scripted');

		// A second chat in a tab: a session of its own, the first chat untouched.
		const tab = await p.openChatInNewTab();
		check('two chats', chats().length === 2);
		check(
			'the tab starts on a new session',
			!tab.runtime.session && tab.runtime !== side.runtime,
		);

		// A in the sidebar asks for approval; the tab opens A too.
		await ask(side, `List the vault ${stamp}`);
		const a = await until(
			() => side.runtime.pendingApproval && side.runtime,
			'A to ask',
			30000,
		);
		await tab.openSession(a.session.id);
		check('both chats show A', tab.runtime === a && side.runtime === a);
		const cards = () =>
			chats().map((v) => v.contentEl.querySelectorAll('.librarian-approval').length);
		await until(() => cards().every((n) => n === 1), 'a card in each chat');
		check('the card shows in both chats', cards().join() === '1,1', cards());
		tab.contentEl.querySelector('.librarian-approval button.mod-cta').click();
		await until(() => cards().every((n) => n === 0), 'both cards to go');
		check('one answer clears both cards', cards().join() === '0,0');

		// The layout keeps which session each chat shows.
		check(
			'the tab keeps A in its state',
			tab.leaf.getViewState().state.session === a.session.id,
		);
		const restored = app.workspace.getLeaf('tab');
		await restored.setViewState({ type: 'librarian-chat', state: { session: a.session.id } });
		await app.workspace.revealLeaf(restored);
		await until(
			() => restored.view.runtime?.session?.id === a.session.id,
			'a restored chat on A',
		);
		check('a chat restored from the layout shows A', restored.view.runtime === a);
		restored.detach();

		// The tab closes while A runs: A goes on.
		tab.leaf.detach();
		await sleep(300);
		check('A runs on after its tab closed', a.isRunning);
		await until(() => !a.isRunning, 'A to finish', 60000);

		// The commands go to the chat used last.
		app.workspace.setActiveLeaf(side.leaf, { focus: true });
		app.commands.executeCommandById('vault-librarian:new-session');
		await until(() => !side.runtime.session, 'the sidebar chat on a new session');
		check('New session went to the chat used last', !side.runtime.session);

		// The last chat closes while a session runs: a Notice says the sessions go on.
		await ask(side, `List it again ${stamp}`);
		const b = await until(
			() => side.runtime.pendingApproval && side.runtime,
			'B to ask',
			30000,
		);
		side.leaf.detach();
		await sleep(1200);
		check(
			'closing the last chat says the sessions keep running',
			results.notices.some((n) => /keep running in the background/.test(n)),
			results.notices,
		);
		check('B runs on with no chat', b.isRunning);
		const back = await p.activateView('sidebar');
		back.contentEl.querySelector('.librarian-session-switch').click();
		const row = await until(
			() =>
				$$('.librarian-sessions-active .librarian-session-row', back.contentEl).find((r) =>
					r.textContent.includes(`List it again ${stamp}`),
				),
			'B in the Active group',
		);
		check('B waits in the Active group of the new chat', row.classList.contains('is-asking'));
		b.stop();
		seen.disconnect();
		results.sessions = [a.session.id, b.session.id];
	}

	window.__tabs = {
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
