(async () => {
	const p = app.plugins.plugins['vault-librarian'];
	const c = p.controller;
	const log = [];
	window.__e2e = { running: true };
	const unsub = c.subscribe((e) => {
		if (e.type === 'approval' && e.request) {
			log.push(`approval:${e.request.name}`);
			setTimeout(() => e.request.resolve('approve'), 50);
		}
		if (e.type === 'state') log.push(`state:${e.state}`);
		if (e.type === 'tool-status') log.push(`tool:${e.status}`);
		if (e.type === 'error') log.push(`error:${e.message}`);
		if (e.type === 'notice') log.push(`notice:${e.message}`);
	});
	try {
		await p.activateView();
		await c.newSession();
		const t0 = Date.now();
		await c.send(
			window.__e2ePrompt ||
				'vault-structure 문서에서 모바일 관련 규칙이 뭔지 알려줘. 근거 줄도 적어줘.',
		);
		const events = await p.sessions.load(c.session.id);
		window.__e2e = {
			running: false,
			ms: Date.now() - t0,
			log,
			sessionId: c.session.id,
			events: events.map((e) => ({
				type: e.type,
				...(e.type === 'assistant'
					? {
							content: e.content.slice(0, 400),
							thinking: (e.thinking || '').length,
							tools: e.toolCalls.map(
								(t) => `${t.name}(${JSON.stringify(t.args).slice(0, 80)})`,
							),
							usage: e.usage,
							stop: e.stopReason,
						}
					: {}),
				...(e.type === 'tool_result'
					? {
							name: e.name,
							ok: e.ok,
							len: e.content.length,
							head: e.content.slice(0, 120),
						}
					: {}),
				...(e.type === 'error' ? { message: e.message } : {}),
			})),
			usage: c.usage,
			state: c.state,
			fallback: p.transport.hasFallenBack('openwebui'),
			dom: {
				messages: document.querySelectorAll('.librarian-msg').length,
				toolCards: document.querySelectorAll('.librarian-tool').length,
				sources: document.querySelectorAll('.librarian-source').length,
				ring: document
					.querySelector('.librarian-context-indicator')
					?.getAttribute('aria-label'),
			},
		};
	} catch (error) {
		window.__e2e = { running: false, error: String(error?.stack || error), log };
	} finally {
		unsub();
	}
})();
