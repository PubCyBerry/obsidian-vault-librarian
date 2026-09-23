// LIB-TEST-155: the nine storage tools against the WebDAV storage configured in the plugin.
// Works in a throwaway folder on the storage and in the vault, and removes both at the end.
// Run from the vault root: app.vault.adapter.read("webdav.js").then(s => (0, eval)(s)); read window.__webdav.
(async () => {
	const out = { steps: [] };
	const stamp = new Date()
		.toISOString()
		.replace(/[-:T.Z]/g, '')
		.slice(0, 14);
	const root = `librarian-e2e-${stamp}`;
	const local = `librarian-e2e-${stamp}`;
	const p = app.plugins.plugins['vault-librarian'];
	const tools = new Map(
		p.registry
			.entries()
			.filter((e) => e.tool.name.startsWith('webdav_'))
			.map((e) => [e.tool.name, e.tool]),
	);
	let n = 0;
	const call = async (name, args, expectError) => {
		const t0 = Date.now();
		try {
			const result = await tools.get(name).execute(`e2e-${++n}`, args, undefined);
			const parsed = JSON.parse(result.content[0].text);
			out.steps.push({ name, ms: Date.now() - t0, ok: !expectError, result: parsed });
			return parsed;
		} catch (error) {
			out.steps.push({
				name,
				ms: Date.now() - t0,
				ok: !!expectError,
				error: String(error.message),
			});
			return null;
		}
	};
	const bytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
	try {
		out.registered = [...tools.keys()];
		out.group = p.permissions.groups().find((g) => g.id === 'webdav')?.tools.length;
		await call('webdav_ls', {});
		await call('webdav_mkdir', { path: `${root}/a/b` });
		const file = `${root}/a/한글 이름 #1.md`;
		await call('webdav_write', { path: file, content: '첫 줄\n둘째 줄\n' });
		await call('webdav_write', { path: file, content: 'x' }, true);
		await call('webdav_edit', { path: file, old_text: '둘째', new_text: '두 번째' });
		const read = await call('webdav_read', { path: file });
		out.readBack = read?.lines?.map((l) => l.text);
		await call('webdav_ls', { path: `${root}/a` });
		await call('webdav_move', { from: file, to: `${root}/moved/renamed.md` });
		await call('webdav_move', { from: `${root}/a`, to: `${root}/moved` }, true);

		await app.vault.createFolder(`${local}/up/sub`);
		await app.vault.create(`${local}/up/note.md`, '# 올리기\n');
		await app.vault.createBinary(`${local}/up/sub/all.bin`, bytes.buffer);
		await call('webdav_upload', { vault_path: `${local}/up`, path: `${root}/up` });
		const again = await call('webdav_upload', {
			vault_path: `${local}/up`,
			path: `${root}/up`,
		});
		out.uploadSkipped = again?.skipped?.length;
		await call('webdav_download', { path: `${root}/up`, vault_path: `${local}/down` });
		const back = await app.vault.readBinary(
			app.vault.getFileByPath(`${local}/down/sub/all.bin`),
		);
		out.binaryRoundTrip =
			[...new Uint8Array(back)].every((b, i) => b === i) && back.byteLength === 256;
		await call('webdav_download', {
			path: `${root}/moved/renamed.md`,
			vault_path: `${local}/down`,
		});
		out.downloadedText = await app.vault.read(
			app.vault.getFileByPath(`${local}/down/renamed.md`),
		);

		await call('webdav_delete', { path: root });
		const after = await call('webdav_ls', {});
		out.rootGone = !after?.entries?.some((e) => e.path === root);
	} catch (error) {
		out.error = String(error?.stack || error);
	} finally {
		const folder = app.vault.getFolderByPath(local);
		if (folder) await app.vault.delete(folder, true);
	}
	out.failed = out.steps
		.filter((s) => !s.ok)
		.map((s) => `${s.name}: ${s.error ?? 'unexpected success'}`);
	window.__webdav = out;
})();
