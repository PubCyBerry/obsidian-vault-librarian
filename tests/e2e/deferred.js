(async () => {
	const out = {};
	try {
		const p = app.plugins.plugins['vault-librarian'];
		out.registered = p.registry.entries().map((e) => `${e.tool.name}${e.deferred ? '*' : ''}`);
		out.visibleBefore = p.registry.visible().map((t) => t.name);
		const search = p.registry.visible().find((t) => t.name === 'tool_search');
		out.searchDescription = search?.description.slice(0, 400);
		const view = await p.activateView();
		const send = view.contentEl.querySelector('.librarian-send');
		const input = view.contentEl.querySelector('.librarian-input');
		input.value = 'x';
		input.dispatchEvent(new Event('input'));
		const svg = send.querySelector('svg');
		const b = svg.getBoundingClientRect();
		out.disc = [Math.round(b.width), Math.round(b.height)];
		input.value = '';
		input.dispatchEvent(new Event('input'));
		const c = p.controller;
		const log = [];
		const unsub = c.subscribe((e) => {
			if (e.type === 'approval' && e.request)
				setTimeout(() => e.request.resolve('approve'), 50);
			if (e.type === 'error') log.push(`error:${e.message}`);
		});
		await c.newSession();
		const t0 = Date.now();
		await c.send(
			'Outline 위키의 컬렉션 목록을 가져와서 이름만 알려줘. 필요한 도구가 안 보이면 tool_search로 찾아.',
		);
		unsub();
		out.turn = {
			ms: Date.now() - t0,
			log,
			visibleAfter: p.registry.visible().map((t) => t.name),
			events: c.events
				.map((x) => x.event)
				.filter(
					(e) =>
						e.type === 'tool_call' ||
						e.type === 'assistant' ||
						e.type === 'tool_result',
				)
				.map((e) =>
					e.type === 'tool_call'
						? `call ${e.name} ${JSON.stringify(e.args).slice(0, 80)}`
						: e.type === 'tool_result'
							? `result ${e.name} ${e.ok ? 'ok' : 'ERR'} ${e.content.slice(0, 100)}`
							: `assistant ${e.stopReason} ${e.content.slice(0, 100)}`,
				),
		};
	} catch (error) {
		out.error = String(error?.stack || error);
	}
	window.__def = out;
})();
