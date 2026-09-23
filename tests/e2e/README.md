# Manual end-to-end scripts

These run inside a development vault that has the plugin enabled and a provider with a key configured.
Copy a script to the vault root, then run it from the Obsidian CLI or a devtools console:

```
app.vault.adapter.read("turn.js").then((s) => (0, eval)(s));
```

Results land in `window.__e2e` (turn.js) and `window.__e2e2` (write-rewind-transport.js).
`turn.js` sends one message and auto-approves every tool call; `write-rewind-transport.js` clicks a source link,
creates a note and rewinds it, sends a turn over the requestUrl transport, and renders the settings tab.

`queue.js` drives the chat view like a user while the agent works: a message queued during a run and sent
after it, **Send now** skipping the next call and going in after the tool results, and Stop handing the
queue back to the composer. It auto-approves every tool call and leaves the results in `window.__queue`.

`skill-search.js` sends a request that a deferred skill covers, without telling the model to use a tool, and
leaves the `# Skills` section, the `skill_search` description and the calls in `window.__skill`.
`selection.js` runs a list of requests in fresh sessions to see whether the model reaches for `tool_search`
and `skill_search` on its own, and leaves the calls of each in `window.__batch`. Set `window.__batchCfg` first
(the script's header lists the fields); `deferBash: true` hides `bash` behind `tool_search`.

`webdav.js` needs a WebDAV storage in the settings and its password saved on that device. It calls the nine
storage tools in a throwaway `librarian-e2e-<time>` folder on the storage and in the vault, removes both, and
leaves the steps in `window.__webdav` (`failed` lists anything that went wrong). A local server works too:
`uvx --with cheroot wsgidav --config=<yaml>` with a `simple_dc` user and `accept_basic: true`.
