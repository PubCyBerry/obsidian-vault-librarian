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

The plugin only talks to the endpoint you configure. Note contents reach that endpoint when the agent reads them with a tool you approved, or when you attach a note or an image yourself. There is no telemetry.

The `find` and `grep` tools enumerate Markdown notes to search the vault; a folder restriction narrows the search results. They run only after the tool's permission check (Ask first by default). Opening the image picker enumerates vault file paths locally so you can choose an image. It sends only the image you attach, not the complete file list. Vault enumeration is necessary for these features and may be reported on the community scorecard.

When enabled, the vault-root `AGENTS.md` is included in the system prompt sent to your configured endpoint. Approved search results can include note paths and excerpts. No files outside the vault are read.

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
