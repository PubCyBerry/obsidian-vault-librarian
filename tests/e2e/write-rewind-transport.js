(async () => {
	const p = app.plugins.plugins['vault-librarian'];
	const c = p.controller;
	const out = { running: true, steps: {} };
	window.__e2e2 = out;
	const approveAll = () =>
		c.subscribe((e) => {
			if (e.type === 'approval' && e.request)
				setTimeout(() => e.request.resolve('approve'), 30);
		});
	const unsub = approveAll();
	try {
		// 1. Source link click opens the note at the cited line.
		const link = document.querySelector('.librarian-source');
		link.click();
		await new Promise((r) => setTimeout(r, 800));
		const leafView = app.workspace.getMostRecentLeaf()?.view;
		const view = leafView && leafView.getViewType() === 'markdown' ? leafView : null;
		out.steps.source = {
			file: view?.file?.path,
			mode: view?.getMode(),
			cursor: view?.editor.getCursor(),
			selection: view?.editor.getSelection().slice(0, 60),
		};
		// 2. Create a note, then rewind: the note must go to the trash.
		await p.activateView();
		await c.newSession();
		const t0 = Date.now();
		await c.send(
			"00-inbox/메모.md 파일을 새로 만들고 본문에 '오늘 배운 것: Vault API' 한 줄만 적어줘.",
		);
		const events = await p.sessions.load(c.session.id);
		const created = app.vault.getFileByPath('00-inbox/메모.md');
		const content = created ? await app.vault.read(created) : null;
		const userIndex = events.findIndex((e) => e.type === 'user');
		const preview = c.previewRewind(userIndex);
		const rewind = await c.rewind(userIndex);
		out.steps.write = {
			ms: Date.now() - t0,
			types: events.map((e) => e.type),
			tools: events
				.filter((e) => e.type === 'tool_call')
				.map((e) => `${e.name}(${e.args.path})`),
			created: !!created,
			content,
			snapshot: events.find((e) => e.type === 'snapshot'),
			preview,
			rewind,
			afterRewindExists: !!app.vault.getFileByPath('00-inbox/메모.md'),
			composerText: document.querySelector('.librarian-input')?.value,
			aliveTypes: c.events.map((e) => e.event.type),
		};
		// 3. requestUrl transport: the answer arrives in one piece and the notice is shown.
		p.settings.providers[0].transport = 'requestUrl';
		await p.saveSettings();
		await c.newSession();
		const log = [];
		const unsub2 = c.subscribe((e) => {
			if (e.type === 'state') log.push(e.state);
		});
		const t1 = Date.now();
		await c.send(
			'meeting 문서를 찾아서 Electron이 어디에 쓰인다고 적혀 있는지 한 문장으로 답해줘.',
		);
		unsub2();
		const ev2 = await p.sessions.load(c.session.id);
		out.steps.requestUrl = {
			ms: Date.now() - t1,
			log,
			activity: document.querySelector('.librarian-activity')?.textContent,
			answer: ev2
				.filter((e) => e.type === 'assistant')
				.pop()
				?.content?.slice(0, 200),
			tools: ev2.filter((e) => e.type === 'tool_call').map((e) => e.name),
			errors: ev2.filter((e) => e.type === 'error'),
		};
		p.settings.providers[0].transport = 'auto';
		await p.saveSettings();
		// 4. Settings tab renders the five sections in order.
		app.setting.open();
		app.setting.openTabById('vault-librarian');
		await new Promise((r) => setTimeout(r, 300));
		out.steps.settings = {
			headings: [
				...document.querySelectorAll(
					'.librarian-settings .setting-item-heading .setting-item-name',
				),
			].map((e) => e.textContent),
			groups: document.querySelectorAll('.librarian-tool-permission-group').length,
			rows: document.querySelectorAll('.librarian-tool-permission-row').length,
		};
		app.setting.close();
	} catch (error) {
		out.error = String(error?.stack || error);
	} finally {
		unsub();
		out.running = false;
	}
})();
