# Manual end-to-end scripts

These run inside a development vault that has the plugin enabled and a provider with a key configured.
Copy a script to the vault root, then run it from the Obsidian CLI or a devtools console:

```
app.vault.adapter.read("turn.js").then((s) => (0, eval)(s));
```

Results land in `window.__e2e` (turn.js) and `window.__e2e2` (write-rewind-transport.js).
`turn.js` sends one message and auto-approves every tool call; `write-rewind-transport.js` clicks a source link,
creates a note and rewinds it, sends a turn over the requestUrl transport, and reads the settings tab's page definitions.

`queue.js` drives the chat view like a user while the agent works: a message queued during a run and sent
after it, **Send now** skipping the next call and going in after the tool results, and Stop handing the
queue back to the composer. It auto-approves every tool call and leaves the results in `window.__queue`.

`skill-search.js` sends a request that a deferred skill covers, without telling the model to use a tool, and
leaves the `# Skills` section, the `skill_search` description and the calls in `window.__skill`.
`selection.js` runs a list of requests in fresh sessions to see whether the model reaches for `tool_search`
and `skill_search` on its own, and leaves the calls of each in `window.__batch`. Set `window.__batchCfg` first
(the script's header lists the fields); `deferBash: true` hides `bash` behind `tool_search`.

`scripted-provider.mjs` is an OpenAI-compatible server that streams scripted responses slowly, so the chat's
streaming can be watched without a model or a key: `node tests/e2e/scripted-provider.mjs` listens on
`http://127.0.0.1:18765/v1`. `streaming.js` adds it as the `Scripted` provider (the OpenAI key slot, left empty),
then `__streaming.start('note')` measures the note chip and the answer drawn as Markdown while they stream, and
`__streaming.start('agents')` measures the agent pane's spinner while a sub-agent streams. Results land in
`window.__streaming.results`; put the plugin's settings file back afterwards.

`sessions.js` and `tabs.js` run several sessions at once against `scripted-provider.mjs`, with the same
Scripted provider and `ls` set to Ask first (put the settings file back afterwards, and delete the
sessions they leave). `__sessions.start()` sends session A, moves the chat to a new session B while A
waits for its approval, follows the banner back to A, lets A finish unseen and checks the session
list's Active group, the head's badge, the Notice, a draft kept across the switch and Stop on an Active
row (LIB-TEST-279). `__tabs.start()` opens a second chat in a new tab, shows one session and its
approval card in both, restores a chat from its saved state, closes a chat while its session runs and
closes the last one (LIB-TEST-280). Each leaves its checks in `window.__sessions` or `window.__tabs`.

`webdav.js` needs a WebDAV storage in the settings and its password saved on that device. It calls the nine
storage tools in a throwaway `librarian-e2e-<time>` folder on the storage and in the vault, removes both, and
leaves the steps in `window.__webdav` (`failed` lists anything that went wrong). A local server works too:
`uvx --with cheroot wsgidav --config=<yaml>` with a `simple_dc` user and `accept_basic: true`.
