// Messages sent while the agent works (LIB-TEST-187): a queued follow-up, Send now, and Stop handing
// the queue back. Drives the chat view like a user and leaves the results in window.__queue.
(async () => {
	const p = app.plugins.plugins['vault-librarian'];
	const c = p.controller;
	const log = [];
	window.__queue = { running: true, log };
	const unsub = c.subscribe((e) => {
		if (e.type === 'approval' && e.request) {
			log.push(`approval:${e.request.name}`);
			setTimeout(() => e.request.resolve('approve'), 50);
		}
		if (e.type === 'queue')
			log.push(
				`queue:[${e.queue.map((q) => (q.now ? '!' : '') + q.text.slice(0, 16)).join('|')}]`,
			);
		if (e.type === 'unsent')
			log.push(`unsent:${e.messages.map((m) => m.text.slice(0, 16)).join('|')}`);
		if (e.type === 'tool-status') log.push(`tool:${e.status}`);
		if (e.type === 'error') log.push(`error:${e.message}`);
	});
	const view = await p.activateView();
	const input = document.querySelector('.librarian-input');
	const sendButton = document.querySelector('.librarian-send');
	const type = (text) => {
		input.value = text;
		input.dispatchEvent(new Event('input'));
	};
	const waitFor = async (check, ms = 180000) => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (check()) return true;
			await new Promise((r) => setTimeout(r, 50));
		}
		return false;
	};
	const talk = async () =>
		(await p.sessions.load(c.session.id))
			.filter((e) => ['user', 'assistant', 'tool_result'].includes(e.type))
			.map((e) =>
				e.type === 'user'
					? `U: ${e.content.slice(0, 50)}`
					: e.type === 'assistant'
						? `A: ${e.content.slice(0, 80).replace(/\n/g, ' ')} [${e.toolCalls.map((t) => t.name).join(',')}]`
						: `R: ${e.name} ${e.ok} ${e.content.slice(0, 60).replace(/\n/g, ' ')}`,
			);
	const queueDom = () => ({
		rows: document.querySelectorAll('.librarian-queued').length,
		link: [...document.querySelectorAll('.librarian-send-now')].map((el) => el.textContent),
		button: sendButton.className,
		label: sendButton.getAttribute('aria-label'),
	});
	try {
		// 1. A follow-up waits for the answer, then goes as its own turn.
		await c.newSession();
		type('10-projects/alpha 폴더의 노트 두 개를 각각 read로 읽고 한 줄씩 요약해 줘.');
		const first = view.submit();
		await waitFor(() => log.includes('tool:running'));
		type('방금 읽은 두 노트의 파일 이름만 다시 알려 줘.');
		const typing = queueDom();
		await view.submit();
		const queued = queueDom();
		await first;
		window.__queue.followUp = { typing, queued, talk: await talk(), log: log.splice(0) };

		// 2. Send now: calls that have not started are skipped and the message goes in next.
		await c.newSession();
		type(
			'00-inbox/inbox.md, 10-projects/alpha/meeting.md, 10-projects/alpha/vault-structure.md 세 노트를 순서대로 읽고 각각 요약해 줘. 한 응답에서 read를 하나만 불러.',
		);
		const second = view.submit();
		await waitFor(() => log.includes('tool:ok'));
		type('그만 읽고, 지금까지 읽은 것만으로 바로 답해.');
		await view.submit();
		const before = queueDom();
		document.querySelector('.librarian-send-now')?.click();
		const after = queueDom();
		await second;
		window.__queue.sendNow = {
			before,
			after,
			talk: await talk(),
			skippedCards: document.querySelectorAll('.librarian-tool.is-skipped').length,
			log: log.splice(0),
		};

		// 3. Stop hands the queue back to the composer.
		await c.newSession();
		type('10-projects 폴더를 ls로 보여 주고 무엇이 있는지 설명해 줘.');
		const third = view.submit();
		await waitFor(() => c.state === 'requesting' || c.state === 'streaming');
		type('이 메시지는 입력창으로 돌아와야 한다');
		await view.submit();
		const stopDom = queueDom();
		sendButton.click();
		await third;
		window.__queue.stop = {
			stopDom,
			input: input.value,
			queueHidden: document.querySelector('.librarian-queue').classList.contains('is-hidden'),
			after: queueDom(),
			log: log.splice(0),
		};
		type('');
		window.__queue.running = false;
	} catch (error) {
		window.__queue = { running: false, error: String(error?.stack || error), log };
	} finally {
		unsub();
	}
})();
