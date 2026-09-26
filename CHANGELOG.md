# Changelog

## [2.17.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.16.1...2.17.0) (2026-09-26)


### Features

* open more chats in tabs, each keeping its session across restarts ([f556372](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/f55637258a8aa58788dfc2aa554e009b229f78ec))
* run each session on its own, so opening another never stops one at work ([f556372](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/f55637258a8aa58788dfc2aa554e009b229f78ec))
* say when a session out of sight waits for approval, finishes or fails ([f556372](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/f55637258a8aa58788dfc2aa554e009b229f78ec))
* show the session in a head line, badge the others and list them in an Active group ([f556372](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/f55637258a8aa58788dfc2aa554e009b229f78ec))

## [2.16.1](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.16.0...2.16.1) (2026-09-25)


### chore

* list refactors in the changelog and release the split as 2.16.1 ([16e0f70](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/16e0f708335d35fd758dd029afba1d4553cbccc7))


### Code Refactoring

* **agent:** move sub-agent runs, the approval queue and retry state out of the controller ([d90be1b](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/d90be1b2b29b47f0495fc6b911906822f2578a89))
* **settings:** move the editor modals out of settings-tab.ts ([b7180c8](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/b7180c83dfc1a50ee043811d01c3309d263685d3))
* **ui:** split the chat view into ConversationPane and Composer ([7dcac81](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/7dcac817146fee7628ade33015ca2de76828f1d1))

## [2.16.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.15.0...2.16.0) (2026-09-25)


### Features

* stream a note into its timeline chip and draw text as Markdown while it arrives ([94444aa](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/94444aaea25981f2c06cfe3350ce9a0764530b7f))


### Bug Fixes

* draw the agent pane again only when its log or state changes ([caae095](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/caae095857bd23b2fa07eff18b8776efcdd967b0))
* keep a spinner turning when the chat or the agent pane is drawn again ([4f6bd11](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/4f6bd11f5efc351c9b6eb4f7e9afbb3be146e49a))

## [2.15.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.14.1...2.15.0) (2026-09-25)


### Features

* define sub-agents in .agents/agents in Claude Code's format ([a615cbb](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/a615cbb8c673f61ce91a856c93548e1ee34ab60e))
* hand a Responses API model its earlier reasoning back ([f2f6868](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/f2f68682686eb9cf9b585fe9be932878270694e6))
* run sub-agents with spawn_agent, start the custom prompt from the default, fit tool results ([c73afab](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/c73afabeb2adcdbb15600bcc732eb329d865b749))
* show sub-agents as rows on the timeline and their conversation in an agent pane ([2590cdc](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/2590cdc62c4bcc07ad82ab4f4b1d794560633319))


### Bug Fixes

* replay a Responses API conversation without the reasoning its log lacks ([bddd18c](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/bddd18c2b93b25e1848e6efc73e98893d9ffb99b))
* rewind a note the shell removed, keep a long sub-agent answer's agent_id ([f3e54da](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/f3e54da740355c4bc06c57c86ba61e0c510dcf2c))
* run an agent whose model Settings lacks on the main model ([bc11c3b](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/bc11c3b915bcf4a8a56e9dc150b4a602d57b32ff))
* say a 401 went without a key, and link a citation written with %20 ([bd9658d](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/bd9658d6f02eaee7af3ab4694107150c47d64f37))
* show a sub-agent waiting for its start approval, and a resume under its own agent ([855d551](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/855d551885fe769ef364e9c04298a278922fe337))

## [2.14.1](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.14.0...2.14.1) (2026-09-25)


### Bug Fixes

* ask for citations the chat can link, and link en dash ranges ([6d674bf](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/6d674bf2c44058f205f3b33cf423c704435c5ef8))
* link a cited note when the citation sits in parentheses or quotes ([082d7b0](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/082d7b070132033d7b6d7f57c504b43354e24710))
* show a command's output as text in the step popover ([dc77d89](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/dc77d897f6ade73bf16bf66a8ccb2197ac688911))

## [2.14.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.13.0...2.14.0) (2026-09-25)


### Features

* add a command that opens the chat in the right sidebar ([434de96](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/434de96a4a33df97e7ac9c77b4fd127c40f5946b))


### Bug Fixes

* give the conversation room at the top and the timeline chips more space around them ([434de96](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/434de96a4a33df97e7ac9c77b4fd127c40f5946b))
* keep the streamed text fade-in, without the blur, when the system asks for reduced motion ([434de96](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/434de96a4a33df97e7ac9c77b4fd127c40f5946b))
* show a spinner on the thinking step while the thinking still grows ([434de96](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/434de96a4a33df97e7ac9c77b4fd127c40f5946b))

## [2.13.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.12.1...2.13.0) (2026-09-24)


### Features

* compact the conversation into a handoff summary, as Codex does ([a1797f4](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/a1797f4f08da3c8127e1a1d8d4ecf26104023da1))


### Bug Fixes

* stream thinking in the step popover with the same fade-in as the answer ([a1797f4](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/a1797f4f08da3c8127e1a1d8d4ecf26104023da1))

## [2.12.1](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.12.0...2.12.1) (2026-09-24)


### Bug Fixes

* drop the bash popover's summary line, which repeated its Command section ([fcb68be](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/fcb68be2ecc41fb00b61405b2a94cb34d33e9975))
* keep the step popover's spinner turning while thinking streams ([fcb68be](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/fcb68be2ecc41fb00b61405b2a94cb34d33e9975))
* take every setting another device syncs instead of writing old ones back over them ([fcb68be](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/fcb68be2ecc41fb00b61405b2a94cb34d33e9975))

## [2.12.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.11.0...2.12.0) (2026-09-24)


### Features

* show each request's work as a folding timeline with live step popovers ([080cefc](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/080cefcf3f0fa0b5410a0d6a926407a84a339ff9))

## [2.11.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.10.0...2.11.0) (2026-09-24)


### Features

* back up settings to a file and call OpenAI reasoning models through the Responses API ([875974f](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/875974fa64c7a7d04d7adc3f30a8f63fc373be17))


### Bug Fixes

* keep a browser sign-in waiting while tool calls ask for another one ([875974f](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/875974fa64c7a7d04d7adc3f30a8f63fc373be17))
* keep a sign-in handed to a phone until its server arrives with the settings ([875974f](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/875974fa64c7a7d04d7adc3f30a8f63fc373be17))
* say why an MCP server refused a request instead of printing its whole reply ([875974f](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/875974fa64c7a7d04d7adc3f30a8f63fc373be17))
* send Gemini's thought signatures back with its tool calls ([875974f](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/875974fa64c7a7d04d7adc3f30a8f63fc373be17))
* sign in to MCP servers in the system browser instead of Obsidian's web viewer ([875974f](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/875974fa64c7a7d04d7adc3f30a8f63fc373be17))

## [2.10.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.9.0...2.10.0) (2026-09-24)


### Features

* carry keys and MCP sign-ins to other devices with a sync passphrase ([7c5702c](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/7c5702cbe6d0f3af9d303b9e2203d8ab4a940e26))

## [2.9.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.8.0...2.9.0) (2026-09-24)


### Features

* show MCP sign-in state, take console OAuth clients, and open answer links in a new tab ([864f99a](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/864f99af08bf8c9de92f1f86a5f0d817dda83d43))


### Bug Fixes

* keep binary files byte for byte in the bash filesystem and curl ([#48](https://github.com/PubCyBerry/obsidian-vault-librarian/issues/48)) ([864f99a](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/864f99af08bf8c9de92f1f86a5f0d817dda83d43))

## [2.8.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.7.0...2.8.0) (2026-09-23)


### Features

* explain why an MCP server refuses sign-in, and line up buttons and the activity line ([ea389ca](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/ea389ca7e60160a151c417980cf883080ee2eb25))


### Bug Fixes

* fall back to requestUrl when a covered desktop window fails a CORS request ([fac983b](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/fac983bcad6602dfd3acdc86cf4b424a8da8a1e3))

## [2.7.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.6.1...2.7.0) (2026-09-23)


### Features

* run read tools without asking and in parallel, and rebuild the settings on Obsidian's groups ([c6dcf79](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/c6dcf79aa83a5889b4619417eb3cfd5d931bd10a))

## [2.6.1](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.6.0...2.6.1) (2026-09-23)


### Bug Fixes

* let Stop end storage calls that wait for a request or for the app to return ([72d0096](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/72d009684d3a4582a7e608bc081149fb5c5fd176))

## [2.6.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.5.0...2.6.0) (2026-09-23)


### Features

* desktop MCP sign-in through 127.0.0.1, and easier defaults for a new install ([c0e600c](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/c0e600cd99a1e3b13b40a75431f8b3377d82088d))

## [2.5.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.4.1...2.5.0) (2026-09-23)


### Features

* defer skills behind skill_search, name what is deferred, and lift the iteration limit ([54ad808](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/54ad808ee73b03b46e8f84d12bcec4b05b987518))

## [2.4.1](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.4.0...2.4.1) (2026-09-23)


### Bug Fixes

* draw a reopened conversation's tool cards in their saved state ([b88ab7f](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/b88ab7fadaf84abed6d0379375ca645d0d9be4c7))
* show user bubbles on every pane, and set skill paths apart in the settings ([86c9a4a](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/86c9a4a3ffb1237bec10a89805af077095866564))

## [2.4.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.3.0...2.4.0) (2026-09-23)


### Features

* queue messages sent while the agent works, and animate the send button ([dfb3eba](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/dfb3eba26d648ae52389a07b1d1f837bc52f2082))

## [2.3.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.2.0...2.3.0) (2026-09-23)


### Features

* manage sessions from the settings, and show the four token counts ([3a382bd](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/3a382bd3b825fb1ddc2c42a5ea6c73556e1eb733))
* read the AGENTS.md of each folder the agent reaches ([368d530](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/368d5304362045548ac3d96e33dabe96c36b9d90))

## [2.2.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.1.0...2.2.0) (2026-09-23)


### Features

* one permission for the shell, and settings split into pages ([a287b27](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/a287b27f6def0d8a577ec303e584ca7661908ae5))

## [2.1.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/2.0.0...2.1.0) (2026-09-23)


### Features

* reach the settings from the chat, and stop passing off curl and obsidian as tools ([0de73e5](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/0de73e5c01fdc71ec9f76fb333bf0e00bccf11af))

## [2.0.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.14.0...2.0.0) (2026-09-23)


### ⚠ BREAKING CHANGES

* replace the four script tools with one bash tool

### Features

* replace the four script tools with one bash tool ([d593bfb](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/d593bfb13934434bc979feea6f0616c81a456439))

## [1.14.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.13.0...1.14.0) (2026-09-23)


### Features

* open the plugin settings from the chat view menu ([47bd31d](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/47bd31de0ee82d4071932e594bd88744a330ddb2))

## [1.13.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.12.0...1.13.0) (2026-09-23)


### Features

* call any url, run obsidian commands and combine tools in a sandboxed script ([68c9e93](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/68c9e93b7cb42be4941c95ab74e8a5c6edbba4ce))

## [1.12.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.11.1...1.12.0) (2026-09-23)


### Features

* reach a WebDAV storage such as a NAS with nine storage tools ([e4e477a](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/e4e477a9c828710dab95a63a849057803cb2c148))

## [1.11.1](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.11.0...1.11.1) (2026-09-23)


### Bug Fixes

* do not misread failures while the app is in the background ([1cfc196](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/1cfc19686f78acd84ae1c8337d9d91855596e7c6))

## [1.11.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.10.2...1.11.0) (2026-09-23)


### Features

* finish the turn when the phone sends the app to the background ([30cc626](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/30cc626443aeabd28fb1d96028fcdb6063bd8f91))

## [1.10.2](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.10.1...1.10.2) (2026-09-22)


### Bug Fixes

* apply the provider default effort when the chat opens without a session ([b18240f](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/b18240f24c9abdb68533b904c4ff39d7282a826a))

## [1.10.1](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.10.0...1.10.1) (2026-09-22)


### Bug Fixes

* tablet send button padding and the theme floating bookmark action ([8f1e64e](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/8f1e64e8e456fa2f3651e6b8ef141d0bf5806cc1))

## [1.10.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.9.1...1.10.0) (2026-09-22)


### Features

* cache hit rate in the context popover, hidden folder access, delete session menu ([7ec35be](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/7ec35be808f2bea6f8752ac085f5c348229e88c9))


### Bug Fixes

* retry once when the response body is cut mid-stream ([66408a8](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/66408a8a3605a617d56fbda7b47f3f2fadc8dcb4))

## [1.9.1](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.9.0...1.9.1) (2026-09-22)


### Bug Fixes

* generic settings text, live tool default limits, deferred tools noted in the prompt ([ec386f6](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/ec386f663a05029ef3d9e7b227a61f676f54364c))

## [1.9.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.8.1...1.9.0) (2026-09-22)


### Features

* tool registry with deferred tools and a BM25 tool_search, plus three phone fixes ([cb96c56](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/cb96c5624901daa0cfc5942a14cec6d7988783d8))

## [1.8.1](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.8.0...1.8.1) (2026-09-22)


### Bug Fixes

* phone composer keeps only its own margin above the open keyboard ([4b79a3c](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/4b79a3c09b8df032394a4e79f7c992e672005ad4))

## [1.8.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.7.0...1.8.0) (2026-09-22)


### Features

* tool scheduler with a global and per-tool execution mode and a per-file mutation queue ([f015439](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/f015439cf80fd2558058310b6b06f2d4c1f912c5))

## [1.7.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.6.1...1.7.0) (2026-09-22)


### Features

* tools and mentions accept every file type, error blocks say when and how a request broke ([b975b70](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/b975b70f9ead4bc2a47bb01ddc2221fddf33cf26))

## [1.6.1](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.6.0...1.6.1) (2026-09-22)


### Bug Fixes

* phone composer rides up with the keyboard and fills the navbar slot, quieter send disc ([d917764](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/d91776422afaffdfe37664f8c90b33204e037344))

## [1.6.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.5.10...1.6.0) (2026-09-22)


### Features

* agent skills from .agents/skills folders and [@mention](https://github.com/mention) autocomplete for notes and folders ([5d18150](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/5d181501c54c3061309567cd81a20c9b75ba9e9d))

## [1.5.10](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.5.9...1.5.10) (2026-09-22)


### Bug Fixes

* drop ellipses and arrows from UI strings ([937fde6](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/937fde6ab8236c4c340393712a87df4c1f80a0f1))

## [1.5.9](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.5.8...1.5.9) (2026-09-22)


### Bug Fixes

* drop the middle dot and em dash from UI strings ([04e3794](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/04e3794e7252c27c010e81318f44885eea151b96))

## [1.5.8](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.5.7...1.5.8) (2026-09-22)


### Bug Fixes

* phone layout of the permission rows and MCP server rows, tap shows the icon meaning ([4a6c62f](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/4a6c62f8a33fad5f64225a98077e016c418f29f7))

## [1.5.7](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.5.6...1.5.7) (2026-09-22)


### Bug Fixes

* normalize the root AGENTS.md check and follow the vault's config folder name ([d1bcefe](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/d1bcefe8a648a3412fe67153e1dfaa2b4bd014ee))

## [1.5.6](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.5.5...1.5.6) (2026-09-22)


### Bug Fixes

* show only the usage the provider reported for the last response ([f6715a5](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/f6715a5e50f6cbc08e1245bd1a8cfcb8c9c4956e))

## [1.5.5](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.5.4...1.5.5) (2026-09-22)


### Bug Fixes

* quieter composer controls and icon-only permission buttons ([436aebf](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/436aebf629be009e4fe40ed50557d0973ec162bf))


### Reverts

* drop the 4,000-character write cap now that the server streams tool calls ([0dcb911](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/0dcb9113db6fd3e34a6dcc6081e2fa0b2dcdd61e))

## [1.5.4](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.5.3...1.5.4) (2026-09-22)


### Bug Fixes

* keep the composer text area flat on hover and focus ([701a36e](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/701a36e91800713114b2fcd32092b72ab0064920))

## [1.5.3](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.5.2...1.5.3) (2026-09-22)


### Bug Fixes

* give the model pill horizontal padding that the row-wide button rule was zeroing ([9ebc91b](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/9ebc91b3976bf2df0610e1ded1048c715a341f5b))

## [1.5.2](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.5.1...1.5.2) (2026-09-22)


### Bug Fixes

* let long tool names wrap their permission controls and size the model pill to its text ([50161c0](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/50161c008f156076bd51ddcdcdabcb831ce6b805))

## [1.5.1](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.5.0...1.5.1) (2026-09-22)


### Bug Fixes

* keep the composer above the phone keyboard and navbar, unclip the input, unify the icon row ([04791b9](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/04791b9310ef36bf5955073f6f33429cfae2affa))

## [1.5.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.4.1...1.5.0) (2026-09-22)


### Features

* rebuild the composer with an attach menu, model picker and an arrow send button ([87238a3](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/87238a3ed808070fc4ba340d3974b6712b5a2aa8))

## [1.4.1](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.4.0...1.4.1) (2026-09-21)


### Bug Fixes

* say when the MCP server rejected the saved sign-in and run its tools one at a time ([266f02c](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/266f02c1102803c4963ef6dd07407afa9cb428f3))

## [1.4.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.3.0...1.4.0) (2026-09-21)


### Features

* let write append parts so long notes survive servers that buffer tool calls ([a8ac28a](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/a8ac28a608bff614b45561116b994dc61d4222ee))

## [1.3.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.2.0...1.3.0) (2026-09-21)


### Features

* add slash commands, [@path](https://github.com/path) note references, main-area chat and selectable text ([3c73b02](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/3c73b02917bdf95c9210ebe485693b8873868835))

## [1.2.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.1.1...1.2.0) (2026-09-21)


### Features

* connect remote MCP servers with OAuth or API key under the same tool permissions ([a563304](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/a5633049781c01fa8c7c8a9ee88c6a8a4bddfbae))

## [1.1.1](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.1.0...1.1.1) (2026-09-21)


### Bug Fixes

* stop yanking the chat scroll to the bottom while streaming ([4d9e9c8](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/4d9e9c808725b7735088215fc91ed164a5baa2f3))

## [1.1.0](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.0.4...1.1.0) (2026-09-21)


### Features

* dim Send with nothing to send and fade in streamed text ([1cdfbc2](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/1cdfbc2f53c1fa39215fc6b26ee0a8e1951bd7c4))

## [1.0.4](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.0.3...1.0.4) (2026-09-21)


### Bug Fixes

* make chat text readable with the note font size and a Hangul-safe code font ([5118d9f](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/5118d9fe1afe3f5242a91e3f96ba2b6f589abb60))

## [1.0.3](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.0.2...1.0.3) (2026-09-21)


### Bug Fixes

* use compatible dotted borders for source links ([9f07b04](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/9f07b04a7bd825099b862df6d53bb549d3038ab5))

## [1.0.2](https://github.com/PubCyBerry/obsidian-vault-librarian/compare/1.0.1...1.0.2) (2026-09-21)


### Bug Fixes

* address community review findings ([1fd9381](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/1fd9381861f82ce1f5c4951e680ddc9ef3faf2a9))

## 1.0.1 (2026-09-21)

### Bug fixes

* Use the unique name Vault Librarian for the community directory, keeping the plugin ID unchanged.
* Match the chat view title to the plugin name and simplify the open command to Open chat.

## 1.0.0 (2026-09-21)


### Features

* add the Librarian vault agent plugin ([39c74e5](https://github.com/PubCyBerry/obsidian-vault-librarian/commit/39c74e5e9cda362c9b4a3056f7d0b0b3e714178f))
