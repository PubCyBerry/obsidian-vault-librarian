// LIB-TEST-193: does the model find deferred tools and skills without being told to?
// Set window.__batchCfg = {prompts: [...] | prompt + n, deferBash, noDav} first. Each prompt runs in a
// fresh session with every approval answered "approve"; the calls land in window.__batch.
// deferBash and noDav change the settings in memory only and are put back at the end.
(async () => {
	const out = { running: true, runs: [] };
	window.__batch = out;
	const p = app.plugins.plugins['vault-librarian'];
	const cfg = window.__batchCfg || {};
	out.cfg = cfg;
	const had = p.settings.toolDeferredByTool.bash;
	const davWas = p.settings.webdav.enabled;
	if (cfg.deferBash) p.settings.toolDeferredByTool.bash = true;
	if (cfg.noDav) p.settings.webdav.enabled = false;
	const c = p.controller;
	const unsub = c.subscribe((e) => {
		if (e.type === 'approval' && e.request) setTimeout(() => e.request.resolve('approve'), 50);
	});
	try {
		const prompts = cfg.prompts ?? Array.from({ length: cfg.n || 3 }, () => cfg.prompt);
		for (const prompt of prompts) {
			await c.newSession();
			const t0 = Date.now();
			await c.send(prompt);
			const ev = c.events.map((x) => x.event);
			const answers = ev.filter((e) => e.type === 'assistant');
			out.runs.push({
				prompt: prompt.slice(0, 40),
				ms: Date.now() - t0,
				calls: answers.flatMap((e) =>
					e.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args).slice(0, 70)})`),
				),
				stops: ev.filter((e) => e.type === 'error').map((e) => e.message),
				answer: (answers[answers.length - 1]?.content || '').slice(0, 100),
			});
		}
	} catch (error) {
		out.error = String(error?.stack || error);
	} finally {
		unsub();
		if (had === undefined) delete p.settings.toolDeferredByTool.bash;
		else p.settings.toolDeferredByTool.bash = had;
		p.settings.webdav.enabled = davWas;
	}
	out.running = false;
})();
