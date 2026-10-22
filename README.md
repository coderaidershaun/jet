# Jet

Jet is a desktop chat app built around a front-end agent. You talk to Jet, a small blue kite with round resting eyes, and Jet hands work to other agents and tools: it runs the Claude Code or Codex command-line program as a child process, and it can call tools that other programs expose over MCP.

> **Work in progress.** This is not plug and play. Expect rough edges, missing pieces and changes without notice. It is a decent starting point for a chat interface that fronts other agents, not a finished product.

## What is in here

- **Chat window.** A Tauri 2 desktop app with a chat page, streamed replies, saved threads, and Markdown and math rendered safely.
- **Front-end agent.** Jet is a persona on top of the installed Claude Code or Codex CLI. It keeps its own notes between sessions, so a conversation can carry on after a restart.
- **Calls other agents and tools.** Jet can use the tools of any MCP server you enable in Settings. The app starts and watches each server as a child process.
- **Character and feelings.** Jet stands beside its last reply, flies on a send, waves hello, reacts when insulted, and becomes a spinner while waiting. Optional JEV classification reads how each message makes Jet feel before the provider starts; without a key it immediately uses neutral.
- **Browser mode.** The chat page also runs in a plain browser against a pretend agent, so you can work on the interface without installing anything else.

## Layout

| Path | What it is |
| --- | --- |
| `crates/agent` | The agent side, with no window. It runs the provider programs, reads their output, keeps the saved thread and notes, and manages the MCP servers. |
| `crates/jet` | The desktop app: the Tauri window, the animated character, and the chat page in `ui/`. |

[The app README](crates/jet/README.md) covers commands, settings, the pretend agent and page architecture. [The character policy](crates/jet/character-policy.md) defines the geometry, motion and emotion checklist.

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

## Optional feelings

On each message, the Rust side reads `JEV_API_KEY` from the environment. If it is absent or blank, it searches from the process's current directory upward and reads the nearest `.env` file. That file owns the configuration even if it contains no key; it does not continue to a more distant file. `.env` is ignored by Git. There is no feelings setting in the app.

With a key, the user's message is sent to JEV at `api.typesafe.ai` for classification. This is a separate network service from the chat provider. The backend allows two seconds with no retry; the page falls back to neutral after 2.2 seconds or an error. See [the contract and timing](crates/jet/README.md#feelings-and-reply-timing).

## Local checks

Run from the repository root:

```sh
cargo build --workspace
REX_PROD_API=false cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
(cd crates/jet/ui && node --test)
```

These checks use stand-in provider/MCP programs and local HTTP fixtures; they need no account or external service. The live JEV test returns without making a request unless `REX_PROD_API=true`. Deliberately enabling it with a configured key contacts the paid/network service and prints measured latency:

```sh
REX_PROD_API=true cargo test -p agent --test feeling_live -- --nocapture
```

Browser sequences, native Tauri appearance, and live JEV quality and latency remain manual checks; passing local tests does not establish those results.

## Status

Early and changing. Setup is manual, the provider integrations follow the command-line programs as they stand today, and parts of the app are tied to the author's own tools. Read the code before you rely on it.
