// LIB-TEST-190: deferred skills, the # Skills section and a real turn that has to find a skill.
// Set window.__skillPrompt first to try another request. Results land in window.__skill.
(async () => {
	const out = { running: true };
	window.__skill = out;
	try {
		const p = app.plugins.plugins['vault-librarian'];
		await p.skills.scan();
		out.skills = p.skills.skills.map(
			(s) => `${s.name}${p.toolDeferredOf(`skill:${s.name}`) ? '*' : ''}`,
		);
		out.visible = p.registry.visible().map((t) => t.name);
		out.searchDescription = p.registry
			.visible()
			.find((t) => t.name === 'skill_search')?.description;
		const prompt = await p.controller.systemPrompt();
		out.skillsSection = prompt.includes('# Skills')
			? prompt.slice(prompt.indexOf('# Skills'))
			: null;
		await p.activateView();
		const c = p.controller;
		const log = [];
		const unsub = c.subscribe((e) => {
			if (e.type === 'approval' && e.request) {
				log.push(`approval:${e.request.permissionKey}`);
				setTimeout(() => e.request.resolve('approve'), 50);
			}
			if (e.type === 'error') log.push(`error:${e.message}`);
			if (e.type === 'notice') log.push(`notice:${e.message}`);
		});
		await c.newSession();
		const t0 = Date.now();
		await c.send(window.__skillPrompt || 'Obsidian에서 callout 문법을 짧게 알려줘.');
		unsub();
		out.turn = {
			ms: Date.now() - t0,
			log,
			events: c.events
				.map((x) => x.event)
				.filter((e) => e.type === 'assistant' || e.type === 'tool_result')
				.map((e) =>
					e.type === 'tool_result'
						? `result ${e.name} ${e.ok ? 'ok' : 'ERR'} ${e.content.slice(0, 160)}`
						: `assistant ${e.stopReason} ${e.toolCalls
								.map((t) => `${t.name}(${JSON.stringify(t.args).slice(0, 100)})`)
								.join(' ')} ${e.content.slice(0, 200)}`,
				),
		};
	} catch (error) {
		out.error = String(error?.stack || error);
	}
	out.running = false;
})();
