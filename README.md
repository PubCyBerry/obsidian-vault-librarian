# Vault Librarian

Vault Librarian is an agent that lives inside Obsidian. You ask in plain language, it searches your vault with small tools (`ls`, `find`, `grep`, `read`), reads what it finds, and, with your approval, creates or edits notes. It works the same on desktop and on the phone, and it talks to any OpenAI-compatible endpoint you point it at: a local server, a company gateway, or a commercial API.

There is no index to build. The agent explores the vault the way a coding agent explores a repository, so nothing has to be synced or rebuilt when notes change.

## What it does

- **Agentic search.** The model calls `find`, `grep`, `ls` and `read` as many times as it needs, then answers from what it actually read. Sources are shown as `path/to/note.md:12-20` and clicking one opens the note at those lines.
- **Create and edit notes.** `write` creates a note (or replaces one only when told to). `edit` replaces exact text and refuses when the text is ambiguous or has changed since it was read.
- **Permissions per tool.** Every tool starts as **Ask first**. You can set each tool, or the read-only and write groups, to **Always allow** or **Blocked**. Blocked tools are removed from the model's tool list and refused again at execution time. Changing the vault root `AGENTS.md` always asks.
- **Approval cards.** A write shows the full content it will create, an edit shows before and after. Approve, reject, or allow that tool from now on.
- **Rewind.** Go back to any earlier message. The conversation after it collapses and the notes the agent created or changed in that span are restored. Notes you edited yourself since then are left alone and listed.
- **Sessions.** Every conversation is an append-only JSONL file in the plugin folder, so it syncs with the vault and survives conflicts as a separate copy. Reopen, rename, and delete from the history view.
- **Context management.** Usage is estimated with a Hangul-aware token count, corrected from provider usage, and shown as a ring next to the send button. Older turns are summarized automatically before the window fills.
- **Vault-local instructions.** If `AGENTS.md` exists at the vault root it is included as instructions, above your own custom system prompt and below the built-in rules.
- **Images.** Paste a screenshot or attach a vault image when the model accepts images. Only the path is stored in the session.
- **Streaming.** Answers stream through `fetch`. If the server does not allow Obsidian's origin, the plugin falls back to Obsidian's `requestUrl` and tells you that streaming is unavailable.
- **WebDAV storage.** Connect one WebDAV server, such as a NAS, under **Settings → WebDAV storage**. The agent can list, read, write, edit, move and delete files there, and copy files and folders between the storage and the vault byte for byte without passing their contents through the conversation. Requests go through Obsidian's `requestUrl`, so the server needs no CORS setup and phones work the same. The password is kept in `SecretStorage` on each device. Changes on the storage are not undone by rewind.
- **Web, APIs and commands.** `http_request` sends a request to any http or https URL through `requestUrl`, so REST APIs work on desktop and phone without CORS. With `format: "markdown"` a web page comes back as Markdown with absolute links, so the agent can read a page and follow its links. `list_commands` and `run_command` find and run Obsidian commands. Each site (`http:<origin>`) and each command (`command:<id>`) gets its own permission row once you allow it; a site or command with no row of its own follows the `http_request` or `run_command` row, and blocking that row blocks them all. Commands are not undone by rewind.
- **Scripts.** `run_js` runs JavaScript the agent writes in a QuickJS sandbox. The script has no network, vault or app access of its own: it can only call the agent's tools with `await tools.<name>(args)`, and each of those calls goes through the same permissions, approval cards and rewind snapshots as a direct call. Use it to read many pages or notes in one step and return only a summary. A script stops after 2 seconds of computing without waiting, after its time limit (30 seconds by default) or at 64 MB of memory.

## Setup

1. Install the plugin and enable it.
2. **Settings → Vault Librarian → Providers → Add provider.** Enter the base URL of an OpenAI-compatible server (the part before `/chat/completions`), your API key, and add at least one model with tool calling enabled. **Test connection** checks the `/models` endpoint before you save.
3. Open the chat from the ribbon icon or the **Open chat** command and ask something.

API keys are stored with Obsidian's `SecretStorage`, which is per device. On a new device the chat shows a banner asking for the key; nothing is sent until it is set. Keys never enter `data.json` or the session files.

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

The plugin talks to the endpoints you configure: the model provider, and any MCP server or WebDAV storage you add. Note contents reach the model provider when the agent reads them with a tool you approved, or when you attach a note or an image yourself. Files reach the WebDAV storage only through the storage tools, which ask first by default. The `http_request` tool is the exception: it sends a request to whatever URL the agent chooses, including URLs it found in notes or web pages, and a request can carry note contents. It asks first for each site by default. Allow the whole `http_request` row only if you are comfortable with the agent browsing on its own. Header values such as `Authorization` are masked on screen but are sent as written and stay in the session file. There is no telemetry.

The `find` and `grep` tools enumerate Markdown notes to search the vault; a folder restriction narrows the search results. They run only after the tool's permission check (Ask first by default). Opening the image picker enumerates vault file paths locally so you can choose an image. It sends only the image you attach, not the complete file list. Vault enumeration is necessary for these features and may be reported on the community scorecard.

When enabled, the vault-root `AGENTS.md` is included in the system prompt sent to your configured endpoint. Approved search results can include note paths and excerpts. No files outside the vault are read, except on the WebDAV storage you connect. Scripts from `run_js` cannot read files or the network directly; they only call the tools above.

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
