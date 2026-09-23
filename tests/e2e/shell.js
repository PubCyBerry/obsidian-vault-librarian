// Desktop check for LIB-TEST-176: the shell over a real vault, a real request and real Obsidian
// verbs. Copy to the dev vault root and run with
//   app.vault.adapter.read('shell.js').then(s => (0, eval)(s))
// then read window.__shell.
(async () => {
	const plugin = app.plugins.plugins['vault-librarian'];
	const out = { version: plugin.manifest.version };
	const tool = plugin.registry.visible().find((t) => t.name === 'bash');
	out.hasTool = Boolean(tool);
	out.toolNames = plugin.registry.visible().map((t) => t.name);

	// Approve everything the shell asks about, recording what it asked.
	out.asked = [];
	const off = plugin.controller.subscribe((e) => {
		if (e.type === 'approval' && e.request) {
			out.asked.push({ name: e.request.name, key: e.request.permissionKey });
			queueMicrotask(() => e.request.resolve('approve'));
		}
	});

	let n = 0;
	const run = async (label, command, timeout = 30) => {
		const started = performance.now();
		try {
			const r = await tool.execute(`e2e-${++n}`, { command, timeout });
			out[label] = {
				ms: Math.round(performance.now() - started),
				text: String(r.content[0].text).slice(0, 300),
			};
		} catch (e) {
			out[label] = {
				ms: Math.round(performance.now() - started),
				threw: String(e).slice(0, 300),
			};
		}
	};

	await run('first', 'echo ready');
	await run('vault', 'ls | head -5');
	await run('grep', "grep -rl 'Librarian' . 2>/dev/null | head -3");
	await run(
		'pipeline',
		'for f in $(ls *.md 2>/dev/null | head -3); do echo "$f $(wc -l < $f)"; done',
	);
	await run('curlRaw', 'curl -s https://example.com | head -c 120');
	await run(
		'curlFollow',
		`link=$(curl -s https://example.com | grep -o 'https://[^"]*' | head -1); echo "link=$link"; curl -s "$link" | grep -o '<title>[^<]*</title>'`,
	);
	await run(
		'curlJson',
		'curl -s https://api.github.com/repos/PubCyBerry/obsidian-vault-librarian | jq -r .name',
	);
	await run('obsVersion', 'obsidian version');
	await run('obsCommands', 'obsidian commands filter=workspace | head -5');
	await run('obsSearch', 'obsidian search query=Librarian limit=3');
	await run('obsHelp', 'obsidian help | head -3');
	await run('obsWithheld', 'obsidian eval code=1');
	await run('tmp', 'curl -s https://example.com -o /tmp/p.html && wc -c < /tmp/p.html');
	await run('tmpAgain', "grep -c 'a' /tmp/p.html");
	await run('loop', 'while true; do :; done', 30);
	await run('deadline', 'sleep 10', 1);
	await run('gzip', 'echo x | gzip | wc -c');
	await run('unknown', 'git status');

	off?.();
	window.__shell = out;
	return Object.keys(out).length;
})();
