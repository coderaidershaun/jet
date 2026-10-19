# Jet

Jet is a desktop chat app built around a front-end agent. You talk to Jet, a small animated character, and Jet hands work to other agents and tools: it runs the Claude Code or Codex command-line program as a child process, and it can call tools that other programs expose over MCP.

> **Work in progress.** This is not plug and play. Expect rough edges, missing pieces and changes without notice. It is a decent starting point for a chat interface that fronts other agents, not a finished product.

## What is in here

- **Chat window.** A Tauri 2 desktop app with a chat page, streamed replies, saved threads, and Markdown and math rendered safely.
- **Front-end agent.** Jet is a persona on top of the installed Claude Code or Codex CLI. It keeps its own notes between sessions, so a conversation can carry on after a restart.
- **Calls other agents and tools.** Jet can use the tools of any MCP server you enable in Settings. The app starts and watches each server as a child process.
- **Workstation page.** A second page that shows a live feed from an outside program. It is specific to the author's own trading libraries, and you can ignore it.
- **Browser mode.** The pages also run in a plain browser against a pretend agent, so you can work on the interface without installing anything else.

## Layout

| Path | What it is |
| --- | --- |
| `crates/agent` | The agent side, with no window. It runs the provider programs, reads their output, keeps the saved thread and notes, and manages the MCP servers. |
| `crates/jet` | The desktop app: the Tauri window, the animated character, and the chat and workstation pages in `ui/`. |

`crates/jet/README.md` goes into detail on commands, settings, the pretend agent and how the pages fit together.

## Requirements

- A recent stable Rust toolchain (the workspace uses edition 2024).
- The Tauri 2 CLI: `cargo install tauri-cli --version "^2" --locked`
- At least one agent program, installed and signed in:
  - Claude Code (`claude`), or
  - the Codex CLI (`codex`, run `codex login` once).

The app starts without these, but it cannot answer until one of them works.

## Run it

```sh
cd crates/jet
cargo tauri dev
```

To try the pages in a browser, with no window and no agent program:

```sh
cargo run -p jet --example serve
```

Then open `http://127.0.0.1:8787/`.

## Tests

```sh
cargo test
```

The tests use stand-in programs for Claude Code, Codex and the MCP servers, so they need no accounts or network.

## Status

Early and changing. Setup is manual, the provider integrations follow the command-line programs as they stand today, and parts of the app are tied to the author's own tools. Read the code before you rely on it.
