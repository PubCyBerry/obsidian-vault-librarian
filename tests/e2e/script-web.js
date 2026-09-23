// LIB-TEST-170: http_request reading a page and following its links, Obsidian commands, and a
// run_js crawl, first called directly and then by the model. Every approval is granted.
// Run from the vault root: app.vault.adapter.read("script-web.js").then(s => (0, eval)(s)); read window.__web.
(async () => {
	const out = {};
	const p = app.plugins.plugins['vault-librarian'];
	const c = p.controller;
	const unsub = c.subscribe((e) => {
		if (e.type === 'approval' && e.request) setTimeout(() => e.request.resolve('approve'), 30);
	});
	const tool = (name) => p.registry.entries().find((e) => e.tool.name === name).tool;
	const call = async (name, args) => {
		const t0 = Date.now();
		try {
			const r = await tool(name).execute(`e2e-${name}-${t0}`, args, undefined);
			return { ms: Date.now() - t0, text: r.content[0].text };
		} catch (error) {
			return { ms: Date.now() - t0, error: String(error.message) };
		}
	};
	try {
		const page = await call('http_request', {
			url: 'https://example.com/',
			format: 'markdown',
			links: true,
		});
		const parsed = JSON.parse(page.text);
		out.page = {
			ms: page.ms,
			status: parsed.status,
			title: parsed.title,
			links: parsed.links,
			body: parsed.body.slice(0, 200),
		};
		const next = parsed.links[0]?.url;
		if (next) {
			const followed = JSON.parse(
				(await call('http_request', { url: next, format: 'markdown' })).text,
			);
			out.followed = {
				url: next,
				status: followed.status,
				title: followed.title,
				bodyLength: followed.bodyLength,
			};
		}
		const listed = JSON.parse(
			(await call('list_commands', { query: 'toggle', limit: 3 })).text,
		);
		out.commands = listed;
		out.script = await call('run_js', {
			code: `
				const start = await tools.http_request({ url: 'https://example.com/', format: 'markdown', links: true });
				const visited = [{ url: start.url, title: start.title }];
				for (const link of start.links.slice(0, 2)) {
					const page = await tools.http_request({ url: link.url, format: 'markdown' });
					visited.push({ url: page.url, status: page.status, title: page.title, chars: page.bodyLength });
				}
				console.log('visited', visited.length);
				return visited;
			`,
			timeout: 60,
		});
		await c.newSession();
		const t0 = Date.now();
		await c.send(
			'https://example.com 페이지를 읽고, 그 페이지에 있는 링크를 따라 들어가서 그 페이지의 제목과 첫 문단을 알려 줘.',
		);
		out.turn = {
			ms: Date.now() - t0,
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
						? `call ${e.name} ${JSON.stringify(e.args).slice(0, 160)}`
						: e.type === 'tool_result'
							? `result ${e.name} ${e.ok ? 'ok' : 'ERR'} ${e.content.slice(0, 120)}`
							: `assistant ${e.stopReason} ${e.content.slice(0, 400)}`,
				),
		};
	} catch (error) {
		out.error = String(error?.stack || error);
	} finally {
		unsub();
	}
	window.__web = out;
})();
