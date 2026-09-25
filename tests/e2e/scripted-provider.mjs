// An OpenAI-compatible server that streams scripted responses slowly, so the chat's streaming can
// be watched and measured without a model or a key (LIB-TEST-272). Run it with Node, add a
// provider with base URL http://127.0.0.1:18765/v1 and model `scripted`, and leave its key empty.
//
//   node tests/e2e/scripted-provider.mjs [port]
//
// A request whose last message contains "agents" starts one explore sub-agent; any other request
// writes a note, lists the vault root, then answers in Markdown with a heading, a list, code and a
// table. The sub-agent thinks, writes a note, lists Projects, then answers in a list.
import http from 'node:http';

const port = Number(process.argv[2] ?? 18765);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ANSWER = `## What the vault holds

The vault keeps **five areas** of work, and each has its own folder:

- \`Projects\` holds one folder per project, with a hub note in each.
- \`Meetings\` records the decisions, one note per meeting.
- \`Journal\` and \`Inbox\` catch what comes in during the day.

\`\`\`ts
const areas = ['Projects', 'Meetings', 'Journal'];
for (const area of areas) console.log(area);
\`\`\`

| Folder | Notes |
| --- | --- |
| Projects | 4 |
| Meetings | 6 |

That is the whole layout; ask for any folder to go deeper.`;

const AGENT_ANSWER = `The projects under \`Projects\` are:

1. **Pricing page**: the new plans and their copy, waiting on legal.
2. **Onboarding**: the first-run checklist, in review.
3. **Mobile app**: the offline mode, being built.

Each has a hub note named after its folder.`;

/** A message's text, whether it came as a string or as parts. */
const textOf = (content) =>
	Array.isArray(content)
		? content.map((part) => part.text ?? '').join('')
		: String(content ?? '');

/** The steps of one response: thinking, text, then tool calls. */
function script(messages) {
	const system = messages.find((m) => m.role === 'system' || m.role === 'developer');
	const sub = textOf(system?.content).includes('# Sub-agent');
	const lastUser = messages.findLastIndex((m) => m.role === 'user');
	const results = messages.slice(lastUser + 1).filter((m) => m.role === 'tool').length;
	const asked = textOf(messages[lastUser]?.content);
	if (sub)
		return results === 0
			? {
					thinking:
						'The task asks for the project folders, so I list Projects first. '.repeat(
							3,
						),
					text: 'Looking through the folders under Projects.',
					calls: [{ name: 'ls', args: { path: 'Projects' } }],
				}
			: { text: AGENT_ANSWER, slow: 60 };
	if (asked.includes('agents'))
		return results === 0
			? {
					text: 'I will ask an explore agent to look through the projects.',
					calls: [
						{
							name: 'spawn_agent',
							args: {
								agent: 'explore',
								title: 'Look through Projects',
								task: 'List the project folders under Projects with one line each.',
							},
						},
					],
				}
			: { text: 'The explore agent found three projects; each has a hub note.' };
	return results === 0
		? {
				thinking: 'The user wants the layout. I list the root before answering.',
				text: 'Let me list the vault first to see what is there. I will look at the root folders, then answer with their layout.',
				calls: [{ name: 'ls', args: { path: '' } }],
			}
		: { text: ANSWER };
}

async function stream(res, body) {
	const plan = script(body.messages ?? []);
	const chunk = (delta, finish = null) =>
		res.write(
			`data: ${JSON.stringify({
				id: 'scripted',
				object: 'chat.completion.chunk',
				created: 0,
				model: 'scripted',
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`,
		);
	chunk({ role: 'assistant', content: '' });
	await sleep(300);
	for (let i = 0; plan.thinking && i < plan.thinking.length; i += 6) {
		chunk({ reasoning_content: plan.thinking.slice(i, i + 6) });
		await sleep(40);
	}
	// A few characters at a time, as a model's tokens come.
	for (let i = 0; plan.text && i < plan.text.length; i += 4) {
		chunk({ content: plan.text.slice(i, i + 4) });
		await sleep(plan.slow ?? 45);
	}
	(plan.calls ?? []).forEach((call, index) => {
		chunk({
			tool_calls: [
				{
					index,
					id: `call_${Date.now()}_${index}`,
					type: 'function',
					function: { name: call.name, arguments: JSON.stringify(call.args) },
				},
			],
		});
	});
	chunk({}, plan.calls ? 'tool_calls' : 'stop');
	res.write(
		`data: ${JSON.stringify({ id: 'scripted', object: 'chat.completion.chunk', created: 0, model: 'scripted', choices: [], usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 } })}\n\n`,
	);
	res.end('data: [DONE]\n\n');
}

http.createServer((req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Headers', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	if (req.method === 'OPTIONS') return res.end();
	if (req.url?.endsWith('/models')) {
		res.setHeader('Content-Type', 'application/json');
		return res.end(JSON.stringify({ data: [{ id: 'scripted', object: 'model' }] }));
	}
	let raw = '';
	req.on('data', (d) => {
		raw += d;
	});
	req.on('end', () => {
		const body = JSON.parse(raw || '{}');
		res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
		void stream(res, body);
	});
}).listen(port, '127.0.0.1', () => console.log(`scripted provider on http://127.0.0.1:${port}/v1`));
