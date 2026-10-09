<div align="center">

# ZCode JetBrains Plugin

<img src="logo/zcgui-window-soft.svg" width="120" height="120" alt="ZCode GUI" />

**English** · [简体中文](README.md)

[![GitHub Stars](https://img.shields.io/github/stars/csuftt/zcode-jetbrains-plugin?style=flat-square)](https://github.com/csuftt/zcode-jetbrains-plugin/stargazers) [![GitHub Forks](https://img.shields.io/github/forks/csuftt/zcode-jetbrains-plugin?style=flat-square)](https://github.com/csuftt/zcode-jetbrains-plugin/forks) [![GitHub Issues](https://img.shields.io/github/issues/csuftt/zcode-jetbrains-plugin?style=flat-square)](https://github.com/csuftt/zcode-jetbrains-plugin/issues) [![License](https://img.shields.io/github/license/csuftt/zcode-jetbrains-plugin?style=flat-square)](LICENSE)

</div>

Bring the [ZCode](https://zcode.z.ai/cn) coding assistant into your JetBrains IDE — no terminal switching, no leaving the editor. Sessions, chats, models, and task management all live in a single tool window, and the AI's browser-use tools can directly drive the plugin's embedded browser.

> 🙏 Special thanks to the open-source project **[CC GUI (jetbrains-cc-gui)](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui)** (MIT) — the author of this project is a long-time user of the CC GUI + Claude Code workflow, and the UI design draws heavily on it: overall layout, status panels, input-area interactions, and the theming system; the file-type icons are also taken from that project. Thanks to [zhukunpenglinyutong](https://github.com/zhukunpenglinyutong) for the open-source work.

> Third-party community plugin, not affiliated with ZCode / Z.ai. Requires a locally installed and logged-in ZCode CLI.
>
> This is a personal hobby project — I'll do my best to maintain it, but can't guarantee timely responses. Pull requests are welcome!

## Why this project

I write code in the JetBrains family (IDEA + PyCharm) and got used to the **CC GUI plugin + Claude Code** combo — managing AI sessions in the IDE sidebar, watching streaming output and tool calls without ever switching to a terminal.

Then two things collided: Claude Code was reported to collect data without users' knowledge, and my company disabled it for data-security reasons; ZCode, a great replacement, had no JetBrains plugin. I couldn't give up my JetBrains habits, and I didn't want to give up ZCode — so I built this myself, bringing the familiar CC GUI experience to ZCode.

Using CLI-based AI tools inside an IDE is awkward for everyone, no matter whose CLI it is:

- **Switching to the terminal loses context**: hit ALT+F12, type a command, and while the AI works you scroll logs wondering what it's actually doing
- **Fragmented session management**: to revisit old sessions or run several tasks in parallel, you have to dig through the CLI's local storage
- **No runtime control**: switching models, tuning thinking depth, checking remaining context and quota — all require remembering command-line arguments

This project has exactly one goal: **use ZCode's core capabilities where you write code**. Open the tool window, run one task per tab, watch streaming conversations render in real time, and see what subagents are doing, how the task list is progressing, and which files were changed — at a glance.

## Features

**Chat** — streaming output (thinking / content / tool calls rendered live), Markdown / Mermaid / code highlighting, thinking-time stats, message queuing (Enter while generating queues the message; queued cards can be sent or removed instantly, or steered into the running turn — the AI receives the instruction mid-turn and adjusts course without interruption, steered messages carry a ⚡ badge, and queued messages can be reordered up/down), edit-and-resend for the latest user message (auto rewinds that turn and regenerates), one-click resend of AI replies (with a clear reason when not allowed), per-session input drafts that survive session switches and IDE restarts, in-session scheduled sends (preset time + prompt fired automatically, with target model / new-session options and a cross-session task list; the AI can create scheduled tasks too), Ctrl+F in-session search (case / whole-word / regex), message anchor navigation (user-message dots + hover preview)

**Multi-tasking** — parallel sessions in multiple tabs (each tab has an isolated context; the new-session dialog can ask whether to replace the current tab or open a new one), auto-restore on IDE restart, session list / rename (with AI title regeneration from recent conversation) / search / batch multi-select delete, session pinning (shares the same store as the official ZCode desktop client), unread badges (sessions that received messages while out of sight are flagged, cleared on open), red badges for sessions waiting for approval / input, archiving for rarely-used sessions (auto-archive supported), one-click forking from any earlier reply (works even while a task is running), tab renaming

**Process visibility** — live task list (TodoWrite) progress, subagent (Agent) panel with execution-process / final-report popups, a background-work hub (status panel groups background tasks / agent tasks), per-turn file-change bar (which files this turn touched, added/removed lines, one-click undo of the whole turn), turn artifact preview cards (files created or modified in the turn, click to preview), file-change stats (click to open in the editor, inline before/after diff), AskUserQuestion interaction dialogs (docked at the bottom, minimizable, waits indefinitely by default, reviewable after the turn), plan-mode (ExitPlanMode) approval panel (docked above the input box, waits indefinitely, accepts feedback to refine the plan)

**Goal mode** — set a long-running goal with `/goal` and it drives itself across multiple turns: after each turn the server independently verifies progress (timeline separator cards show pass/fail plus the next action), auto-continuing until the goal is met; the corner goal card tracks iterations / elapsed time / verifying status in real time, with pause / resume / replace / confirm-to-clear controls, and goal state survives restarts

**Embedded browser** — the Header globe button expands a browser column to the right of the chat area: multiple tabs (globally shared, persist across sessions), back / forward / refresh / address bar / free-size viewport (DevTools device-toolbar style virtual screen) / DevTools / open externally, native Ctrl+wheel zoom with a percentage indicator, plus a browser console (CDP) for clearing site data and site overview; the plugin hosts the browser-use reverse protocol, so the AI can drive this browser — navigate, screenshot, execute JS, run playwright locators and CUA mouse/keyboard actions — with zero configuration

**Runtime control** — model dropdown (builtin channels follow the active channel in the ZCode client; manual refresh inside the dropdown; a Z.ai subscription account channel connects via OAuth with no API key, and the quota page shows the plan usage), permission mode (build / edit / plan / yolo) and thinking level (per model), adjustable; preselectable in the standby state (before a session exists), applied when the session is created; context-capacity ring (usage breakdown + cache hits, double-click to compact the context), 5-hour / weekly quota queries, and a quota banner that warns when the 5-hour pool runs low and shows the reset time

**Settings center** — ten tabs: General (Appearance: theme / font / language / custom colors; Environment: manual paths or auto-detection; Behavior: input-history completion and more), Models (builtin channels follow the ZCode client config — only the active one is shown, annotated with how it was resolved: client-selected or fallback; a Z.ai account channel connects via OAuth; builtin channels support a custom API Key — team-plan users can fill in a team project key from the BigModel open platform to bill the team quota, with the card showing the key actually used for billing (masked by default, revealable) and its source, plus a billing reminder when unset; third-party providers can be toggled, with preset cards for common providers where you only fill in the key; paths follow data-directory migration; add/remove guides you to ZCode config with one-click open), Usage (App usage: local session stats covering third-party models, 7-day / 30-day / all ranges; GLM plan usage: quota cards + model/tool usage curves and detail tables, with the queried credential source and key (masked) labeled), Memory (AGENTS.md instruction memory + auto memory, creatable when missing, full-text search), Skills (global / project / plugin three-source scan, inline enable/disable), Subagents (custom agent definitions), MCP (server list / tool list / connection logs), Browser (embedded browser controls and site-data cleanup), Processes (resident / child / suspected-orphan groups with precise kill), Other (input-history completion toggle and history management)

**Mobile remote sessions** — view and control desktop IDE sessions from the Z.ai mobile app: task list, model selection and device naming work end to end; HTTP proxy environments are supported

**Environment check** — on startup verifies Node.js (≥18) / ZCode CLI / login credentials; on failure the top bar shows a notice with per-item fix entry points and a re-check button (missing credentials no longer block startup — a hint is shown instead); paths can be configured manually and are auto-detected when left blank

**IDE integration** — right-click a file in the project view / editor tab to send it, right-click selected code in the editor to send it to the input box (Ctrl+Alt+K), copy selection reference (path + line numbers); files, memory, skills, and MCP configs all open in the editor with one click

**Input enhancements** — `@` file references (chip + completion; pasted absolute paths or files dragged from the OS become chips, folders supported), `$` skill mentions (a second skill entry alongside `/` slash commands; same-named skills fold by source), a current-file context chip that follows the editor's active file and selection (checked: carried implicitly with the message, the bubble only shows what you typed), `/` skill invocation, long-paste collapsing, input-history browsing with prefix ghost completion (Tab to accept)

**Multi-language** — 简体中文 / English / 日本語 / 한국어 / 繁體中文, switches automatically with the IDE UI language

## Screenshots

**Embedded browser · browser-use host (a highlight of ZCode client, recreated here)**

![Embedded browser: editor / AI session / embedded browser side by side, showing this plugin's repo page](docs/screenshots/embedded-browser.png)

The Header globe button expands a browser column to the right of the chat area (above: the full IDE with editor, AI session and embedded browser side by side): toolbar with back / forward / refresh / address bar / free-size viewport / DevTools / open externally; tabs are globally shared and persist across sessions; the width is draggable and pages survive collapse.

It is more than a built-in browser — the plugin implements the ZCode app-server's **browser-use host protocol** (reverse requests `interaction/browserList` / `browserExecute`), so when the AI calls browser-use tools they land **with zero configuration** in this embedded JCEF browser:

- **Navigation & capture**: newTab / navigate / screenshot / evaluate — screenshots go straight back to the model
- **playwright locator passthrough**: getByRole / getByText / label / testid / and / or / nth / css selector chains; ARIA-tree DOM snapshots for the AI to read
- **CUA mouse & keyboard**: coordinate clicks / typing / drag / scroll / key combos; JS dialogs are suspended for handling
- **Tab lifecycle**: markDeliverable / markHandoff / finalize markers and read-back; tab.close really closes
- **Free-size viewport**: DevTools device-toolbar style — centered virtual screen in a mailbox, zoom levels, size persistence
- When playwright is unavailable, the AI degrades **gracefully** with title / get_visible_dom / screenshot, so the pipeline always works

> The browser column in the screenshot above shows this plugin's own repository page; screenshots, DOM reading and GUI acceptance can all be self-driven by the AI through browser-use.

**Chat & process visibility** (screenshots below are taken from the real IDE with demo sessions)

| Streaming: thinking blocks / live subagent counters / stop button | Full session: tool-group cards / task lists / AI summary /<br>per-turn file-change bar with one-click undo |
| :---: | :---: |
| ![Streaming](docs/screenshots/streaming.png) | ![Full session](docs/screenshots/chat-main.png) |
| **Subagent execution popup: task instructions / tool calls / summary** | **Subagent final-report popup: full Markdown reading,<br>switchable with the execution popup** |
| ![Subagent execution](docs/screenshots/subagent-detail.png) | ![Subagent final report](docs/screenshots/subagent-report.png) |

| **Plan-mode approval (ExitPlanMode): full plan docked above the input box;<br>approve / reject / give feedback to refine the plan; waits indefinitely** | **AskUserQuestion dialog: docked at the bottom, waits indefinitely,<br>reviewable after the turn** |
| :---: | :---: |
| ![Plan-mode approval](docs/screenshots/plan-mode.png) | ![AskUserQuestion dialog](docs/screenshots/ask-dialog.png) |

**Goal mode (/goal auto-continuing turns)**

| Multi-turn progress: per-turn verification separator cards<br>(not passed → next action) + goal card iterations / elapsed / verifying | All turns done: final verification passed, goal card switches to complete |
| :---: | :---: |
| ![Goal mode in progress](docs/screenshots/goal-processing.png) | ![Goal mode complete](docs/screenshots/goal-done.png) |

**Scheduled tasks · mobile remote · runtime control**

| Manually creating a scheduled send (preset time or quick presets,<br>target model / new session) | An AI-created scheduled task (execution card + queued preview<br>before it fires; send now / edit / cancel) |
| :---: | :---: |
| ![Scheduled send creation](docs/screenshots/scheduled-send.png) | ![AI-created scheduled task](docs/screenshots/scheduled-task.png) |
| **Mobile remote pairing: scan to connect and control desktop<br>sessions from the phone (pairing credential masked)** | **Model switcher dropdown: grouped by channel,<br>marked selected / default, with a manage entry** |
| ![Mobile remote pairing](docs/screenshots/remote-pairing.png) | ![Model switcher](docs/screenshots/model-switcher.png) |

**Input enhancements & multi-tasking**

| `@` file reference completion | `$` skill mentions (folded by source) | `/` skill invocation |
| :---: | :---: | :---: |
| ![@ file completion](docs/screenshots/input-at.png) | ![$ skill mentions](docs/screenshots/input-dollar.png) | ![Skill completion](docs/screenshots/input-slash.png) |

| **Session list (pin / unread badges / search / multi-select delete)** | **Welcome page (standby preselect of mode & thinking level)** |
| :---: | :---: |
| ![Session list](docs/screenshots/history.png) | ![Welcome page](docs/screenshots/welcome.png) |

**Settings center**

| General (theme / font / language / custom colors) | Model management (account channel / provider presets / third-party toggles) |
| :---: | :---: |
| ![General settings](docs/screenshots/settings-basic.png) | ![Model management](docs/screenshots/settings-models.png) |
| **Usage (App usage: local session stats + third-party model details)** | **Memory (instruction / auto memory management)** |
| ![Usage](docs/screenshots/settings-usage.png) | ![Memory](docs/screenshots/settings-memory.png) |
| **Skills (three-source scan & enable management)** | **MCP (server list / tool list / connection logs)** |
| ![Skills](docs/screenshots/settings-skills.png) | ![MCP](docs/screenshots/settings-mcp.png) |
| **Processes (resident / child / suspected-orphan, precise kill)** | **Other (input-history completion & management)** |
| ![Processes](docs/screenshots/settings-process.png) | ![Other](docs/screenshots/settings-other.png) |

## Quick start

```bash
# One-click clean + rebuild (recommended):
#   clean Gradle build dirs + webview cache → build both webview artifacts (multi-file + sourcemap / singlefile fallback) → buildPlugin
#   Output: intellij-plugin/build/distributions/ZC-GUI-<version>.zip (offline install in the IDE)
./build.sh               # full clean + rebuild
./build.sh --skip-clean  # incremental build, no clean

# ... or step by step:
cd webview && npm install && npm run build && npm run build:single && cd ..
./gradlew :intellij-plugin:buildPlugin

# ... or launch a sandbox IDE to try it out directly
./gradlew :intellij-plugin:runIde
```

The frontend can be developed standalone, independent of the IDE (auto-switches to a mock data source): `cd webview && npm run dev`

In production mode the plugin serves the multi-file build from a built-in HttpServer (127.0.0.1, random port) — the webview gets a real origin and sourcemaps, so DevTools can show TS/TSX sources with breakpoints; if the server fails to start it automatically falls back to singlefile loading.

## How it works

The plugin starts ZCode's app-server as a child process (`node zcode.cjs app-server`) and drives sessions over JSON-RPC on stdin/stdout; events are dispatched per session, throttled, and pushed to JCEF in batches, where a frontend reducer incrementally folds them into the message tree and derived state (tasks / subagents / file changes). The plugin also acts as a host implementing the app-server's browser-use host protocol (reverse requests `interaction/browserList` / `browserExecute`), landing the AI's browser tools in the embedded JCEF browser.

```mermaid
graph LR
    UI[webview React UI] <-->|"JCEF bridge (16ms event batching)"| Plugin[Intellij Plugin<br/>multi-tab + JS bridge + embedded browser]
    Plugin --> Client[protocol-client<br/>JSON-RPC client]
    Client <-->|"stdio"| CLI[ZCode app-server]
    CLI --> API[Z.ai / GLM API]
    CLI -.->|"browser-use reverse requests"| Plugin
```


## Acknowledgments

- **[codicon](https://microsoft.github.io/vscode-codicons/)** (MIT) — UI icons
- **[ZCode](https://zcode.z.ai/cn)** — the AI coding service this plugin integrates with

## Disclaimer

This is a personal open-source project, not an official ZCode / Z.ai product; the "ZCode" and "Zai" names and logos belong to their respective owners. Fees and quota consumption are charged to your ZCode account; please comply with the ZCode terms of service. The protocol implementation is based on analysis of the CLI app-server interface and may need adaptation as official versions evolve.

## License

[MIT](LICENSE)
