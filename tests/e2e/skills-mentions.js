// Skills catalog, skill permissions, the read fallback, and the @mention and /skill suggestion
// lists. No model turn; results land in window.__e2e3.
(async () => {
	const out = {};
	try {
		const p = app.plugins.plugins['vault-librarian'];
		await p.skills.scan();
		out.skills = p.skills.skills.map((s) => [s.name, s.location]);
		out.diagnostics = p.skills.diagnostics;
		out.groups = p.permissions.groups().map((g) => [g.id, g.tools.length]);
		const prompt = await p.controller.systemPrompt();
		out.prompt = {
			hasCatalog: prompt.includes('<available_skills>'),
			skillsSection: prompt.indexOf('# Skills'),
			length: prompt.length,
		};
		const loc = p.skills.skills[0].location;
		out.permission = {
			read: p.permissions.get('read'),
			resolved: p.permissions.resolve('read', { path: loc }),
			key: p.permissions.permissionKey('read', { path: loc }),
		};
		const hidden = await p.skills.hiddenReader().read(loc);
		out.hiddenRead = hidden && { firstLine: hidden.text.split('\n')[0], extra: hidden.extra };
		out.activation = (await p.skills.activation(p.skills.skills[0])).slice(0, 160);

		const view = await p.activateView();
		const input = view.contentEl.querySelector('.librarian-input');
		const list = view.contentEl.querySelector('.librarian-slash');
		const rows = () =>
			[...list.querySelectorAll('.librarian-slash-item')].map((r) => r.textContent);
		const type = (v) => {
			input.value = v;
			input.setSelectionRange(v.length, v.length);
			input.dispatchEvent(new Event('input'));
		};
		type('compare @dash');
		out.mentionRows = rows();
		list.querySelector('.librarian-slash-item').dispatchEvent(
			new MouseEvent('mousedown', { bubbles: true }),
		);
		out.afterAccept = {
			text: input.value,
			caret: input.selectionStart,
			chips: [...view.contentEl.querySelectorAll('.librarian-mention')].map((c) =>
				c.textContent.trim(),
			),
			listHidden: list.classList.contains('is-hidden'),
		};
		type('/skill obs');
		out.skillRows = rows();
		type('/sk');
		out.slashRows = rows();
		type('mail me@example.com');
		out.emailRows = rows().length;
		type('');
		for (const b of view.contentEl.querySelectorAll('.librarian-mention button')) b.click();
		out.chipsAfterRemove = view.contentEl.querySelectorAll('.librarian-mention').length;
	} catch (error) {
		out.error = String(error?.stack || error);
	}
	window.__e2e3 = out;
})();
