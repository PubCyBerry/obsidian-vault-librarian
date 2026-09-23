# Manual end-to-end scripts

These run inside a development vault that has the plugin enabled and a provider with a key configured.
Copy a script to the vault root, then run it from the Obsidian CLI or a devtools console:

```
app.vault.adapter.read("turn.js").then((s) => (0, eval)(s));
```

Results land in `window.__e2e` (turn.js) and `window.__e2e2` (write-rewind-transport.js).
`turn.js` sends one message and auto-approves every tool call; `write-rewind-transport.js` clicks a source link,
creates a note and rewinds it, sends a turn over the requestUrl transport, and renders the settings tab.

`webdav.js` needs a WebDAV storage in the settings and its password saved on that device. It calls the nine
storage tools in a throwaway `librarian-e2e-<time>` folder on the storage and in the vault, removes both, and
leaves the steps in `window.__webdav` (`failed` lists anything that went wrong). A local server works too:
`uvx --with cheroot wsgidav --config=<yaml>` with a `simple_dc` user and `accept_basic: true`.
