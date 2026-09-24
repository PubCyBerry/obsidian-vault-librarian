# Vault Librarian

Vault Librarian is an agent that lives inside Obsidian. You ask in plain language, it searches your vault with small tools (`ls`, `find`, `grep`, `read`), reads what it finds, and, with your approval, creates or edits notes. It works the same on desktop and on the phone, and it talks to any OpenAI-compatible endpoint you point it at: a local server, a company gateway, or a commercial API.

There is no index to build. The agent explores the vault the way a coding agent explores a repository, so nothing has to be synced or rebuilt when notes change.

## What it does

- **Agentic search.** The model calls `find`, `grep`, `ls` and `read` as many times as it needs, then answers from what it actually read. Sources are shown as `path/to/note.md:12-20` and clicking one opens the note at those lines. A `[[wikilink]]` in an answer opens its note in a new tab.
- **Create and edit notes.** `write` creates a note (or replaces one only when told to). `edit` replaces exact text and refuses when the text is ambiguous or has changed since it was read.
- **Permissions per tool.** On a new install the tools that only read run without asking, and in parallel: `ls`, `find`, `grep`, `read`, the tool and skill searches, listing and reading the WebDAV storage, and the MCP tools that only read. An MCP tool counts as reading when its server marks it read-only, or, with no mark, when its name starts with a verb such as `search`, `get`, `list` or `fetch` and names no change. Everything that changes notes or files, runs a command or calls another MCP tool asks first. You can set each tool, or a whole group, to **Always allow**, **Ask first** or **Blocked**. Blocked tools are removed from the model's tool list and refused again at execution time. Changing the vault root `AGENTS.md` always asks.
- **A short tool list.** The model sees `ls`, `find`, `grep`, `read`, `write`, `edit` and `bash` upfront. Other tools (the active note, WebDAV and MCP tools) are named in the `tool_search` description and loaded when a task needs them, so their schemas stay out of every request. **Execution and listing** under Tool permissions shows how each tool runs and whether it is listed.
- **Approval cards.** A write shows the full content it will create, an edit shows before and after. Approve, reject, or allow that tool from now on.
- **Rewind.** Go back to any earlier message. The conversation after it collapses and the notes the agent created or changed in that span are restored. Notes you edited yourself since then are left alone and listed.
- **Sessions.** Every conversation is an append-only JSONL file in the plugin folder, so it syncs with the vault and survives conflicts as a separate copy. Reopen, rename, and delete from the history view.
- **Context management.** Usage is estimated with a Hangul-aware token count, corrected from provider usage, and shown as a ring next to the send button. Older turns are summarized automatically before the window fills.
- **Vault-local instructions.** If `AGENTS.md` exists at the vault root it is included as instructions, above your own custom system prompt and below the built-in rules.
- **Skills.** Each `.agents/skills/<name>/SKILL.md` ([Agent Skills](https://agentskills.io) format) at the vault root or inside a folder is a skill. By default the model knows skills by name only: when a task calls for one it finds it with `skill_search` and reads its `SKILL.md`, so descriptions stay out of every request. **Settings → Skills** lists the skills found and sets what each may do; to show a skill's description upfront instead, turn on **Listing** there and set the skill to **Listed**. `/skill <name>` runs one directly.
- **Images.** Paste a screenshot or attach a vault image when the model accepts images. Only the path is stored in the session.
- **Streaming.** Answers stream through `fetch`. If the server does not allow Obsidian's origin, the plugin falls back to Obsidian's `requestUrl` and tells you that streaming is unavailable.
- **Send while it works.** A message you send while the agent is working waits above the composer and goes, one at a time, once the agent finishes. **Send now** on a waiting message puts it in before the next tool call: calls that have not started yet are skipped and the model reads your message first. Stop, or a failed request, puts the waiting messages back in the composer.
- **WebDAV storage.** Connect one WebDAV server, such as a NAS, under **Settings → WebDAV storage**. The agent can list, read, write, edit, move and delete files there, and copy files and folders between the storage and the vault byte for byte without passing their contents through the conversation. Requests go through Obsidian's `requestUrl`, so the server needs no CORS setup and phones work the same. The password is kept in `SecretStorage` on each device, and sealed for your other devices when Device sync is on. Changes on the storage are not undone by rewind.
- **MCP servers.** Add remote servers under **Settings → MCP servers** and sign in with OAuth or an API key. Each row shows whether this device is signed in or holds a key, and you can drag rows to reorder them. Servers that do not let apps register on their own, such as Google's, take a client ID and secret you make in their console (a desktop app client); signing in that way works on desktop.
- **Set up once, use on every device.** Under **Settings → Device sync**, a sync passphrase seals your API keys, the WebDAV password and client secrets into this plugin's data file, which your vault's sync carries to your other devices; each device enters the same passphrase once. If Google Calendar Tasks Sync already keeps its passphrase on a device, that one is used. MCP sign-ins are not shared, because servers such as Atlassian and Outline replace the refresh token on every use: on desktop, the phone icon on a server's row signs in once more for a phone or tablet, which takes that sign-in when it opens. This is also how a phone reaches servers that refuse sign-in from a phone.
- **A shell, the web and Obsidian commands.** `bash` runs a shell command inside Obsidian, not your operating system. The vault is the working directory, so `grep`, `sed`, `awk`, `find`, `rg`, `jq` and the rest work on your notes, and `/tmp` holds scratch files for the conversation. Two commands are specific to Obsidian: `curl` sends a request to any URL through `requestUrl` (no CORS setup, same on phones) and writes the response **exactly as the server sent it**, so a web page arrives as its own HTML and you pipe it through `grep` or `jq` to keep what you need; `obsidian` runs any Obsidian CLI command, such as `obsidian search query=... limit=5` or `obsidian command id=<id>` (`obsidian help` lists them). Of the developer commands, only the ones that look are open: `dev:errors`, `dev:console`, `dev:dom`, `dev:css` and `dev:screenshot`, which saves the PNG in the shell (`/tmp`, or a vault path that asks like any write). `eval` and `dev:cdp` stay closed. The shell has one permission row, `bash`. `curl` and `obsidian` have no rows of their own: the approval card shows the whole command, URLs included, so one approval covers it. Writes the shell makes to your notes still go through the `write` permission and its approval card, and rewind undoes them, except that a binary file the shell overwrote is left as it is. Obsidian commands are not undone by rewind.

## Setup

1. Install the plugin and enable it.
2. **Settings → Vault Librarian → Providers → Add provider.** Enter the base URL of an OpenAI-compatible server (the part before `/chat/completions`) and your API key, then add at least one model with tool calling enabled: **Add from server** lists the models the `/models` endpoint reports (with the context window when the server gives one), or **Add model** takes one by hand. **Test** next to Connection checks the endpoint before you save.
3. Open the chat from the ribbon icon or the **Open chat** command and ask something.

API keys are stored with Obsidian's `SecretStorage`, which is per device. On a new device the chat shows a banner asking for the key; nothing is sent until it is set. With a sync passphrase under **Device sync**, keys also enter `data.json`, but only sealed (PBKDF2-SHA256 with 600,000 iterations and AES-256-GCM, the same format Google Calendar Tasks Sync uses), so a device without the passphrase cannot read them. Keys never enter the session files.

### Streaming and CORS

`fetch` streaming needs the server to allow the origins Obsidian uses: `app://obsidian.md` on desktop, `capacitor://localhost` on iOS, `http://localhost` on Android. If it does not, keep the transport on **Auto**: the first failed request switches the provider to `requestUrl` for the rest of the session, or set the transport to **requestUrl** permanently.

### Compatibility settings

OpenAI-compatible servers differ in the details. The provider and model editors expose the same compatibility flags as Pi's `models.json` (`supportsReasoningEffort`, `maxTokensField`, `thinkingFormat`, and so on). Model-level values override provider-level ones.

## Commands

| Command | What it does |
| --- | --- |
| Open chat | Opens the chat in the right sidebar (full screen on phones) |
| New session | Starts a new conversation |
| Open session history | Lists past conversations |
| Compact context | Summarizes the older part of the current conversation now |
| Add active note to prompt | Attaches the note you are viewing to your next message |

## Privacy

The plugin talks to the endpoints you configure: the model provider, and any MCP server or WebDAV storage you add. Note contents reach the model provider when the agent reads them, or when you attach a note or an image yourself. On a new install the tools that only read run without asking, so the agent can read notes it finds on its own, list and read the WebDAV storage, and call an MCP server's read tools with arguments it chose, such as a search query taken from your notes. Set the **Read-only tools** group, the **WebDAV storage** group or a server's group to **Ask first** to approve each call. Files reach the WebDAV storage only through the storage tools that change it, which ask first by default. The shell's `curl` is the exception: it sends a request to whatever URL the agent chooses, including URLs it found in notes or web pages, and a request can carry note contents. By default every `bash` call asks first, and its card shows the whole command, URL included. Set `bash` to **Always allow** only if you are comfortable with the agent browsing on its own: it then reaches any URL and runs any Obsidian command without asking. Header values such as `Authorization` are masked on screen but are sent as written and stay in the session file. There is no telemetry.

The `find` and `grep` tools enumerate Markdown notes to search the vault; a folder restriction narrows the search results. They run only after the tool's permission check (Always allow by default on a new install). Opening the image picker enumerates vault file paths locally so you can choose an image. It sends only the image you attach, not the complete file list. Vault enumeration is necessary for these features and may be reported on the community scorecard.

When enabled, the vault-root `AGENTS.md` is included in the system prompt sent to your configured endpoint. Search results can include note paths and excerpts. Signing in to an MCP server on desktop opens a listener on `127.0.0.1` for the few minutes the browser takes to come back, then closes it; on a phone the sign-in returns through an `obsidian://` link. No files outside the vault are read, except on the WebDAV storage you connect, and the temporary PNG that `obsidian dev:screenshot` has Obsidian write and the plugin then moves into the shell and deletes. A screenshot, like `dev:dom`, holds whatever the window shows. The shell sees the vault and its own scratch space, never the rest of your disk, and has no way to reach the network except through `curl`.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # type check and production bundle
npm run lint     # Biome and ESLint (eslint-plugin-obsidianmd)
npm test         # vitest
```

The agent loop is `@earendil-works/pi-agent-core`; the OpenAI-compatible adapter is `@earendil-works/pi-ai`. Both are pinned. Commits follow Conventional Commits (enforced by commitlint through prek) and releases are cut by release-please.

## License

MIT
