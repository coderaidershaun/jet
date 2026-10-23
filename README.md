# Jet

Jet is a browser home for independently running apps, with one shared assistant conversation. Its Rust server runs the installed Claude Code or Codex CLI, keeps the transcript and notes, and serves the existing HTML/JavaScript interface.

This is a work in progress. App registration and the global MCP facade are available; the workspace and app proxy are being integrated.

## Run

```sh
cargo run -p jet -- --listen 127.0.0.1:8787 --data-dir ./jet-data
```

Open `http://127.0.0.1:8787/`. Install and sign in to Claude Code or Codex on the server, then select it in Settings. The browser never silently selects a pretend agent. A missing provider is shown as an actionable status/error.

For access from another computer, choose a reachable listen address. `--public-origin https://jet.example` records the externally visible origin for app forwarding. `--ui-dir PATH` selects the shipped static asset directory; the default is this checkout's `crates/jet/ui`. Keep the UI files with the executable when deploying a copied build. `--disable-feelings` disables optional JEV classification for offline development/testing.

Jet targets a trusted single-user deployment. Authentication is deferred. App processes run independently; Jet does not install, launch or stop them.

## Existing data

Point `--data-dir` at an existing conversation directory, or a copy. It contains `transcript.jsonl`, `session.json`, `MEMORY.md`, `USER.md` and `RECENT.md`. Copy the old desktop `settings.json` from its configuration directory into the selected data directory to retain provider/persona settings. Old transcript entries remain readable.

Old process-command app settings are rejected with re-registration instructions and never launched or silently erased. Follow [the app contract](docs/app-contract.md) to preserve the original file and register each running app by URL. New installs contain no machine-specific app defaults.

## Browser behavior

The server owns the active reply. Closing a tab, reconnecting or hiding the interface does not cancel it; Stop does. A browser request ID is saved with the accepted transcript entry before provider dispatch. Retrying a lost acknowledgment returns that same turn. After a server crash, unfinished accepted turns are marked interrupted and never rerun automatically.

An authoritative history/current-turn snapshot and bounded event replay restore browsers after reload. Settings and memory are saved on the server. Filesystem image access has been removed; old file images show an unavailable fallback until replaced with app content URLs.

## App tools

Jet shares one HTTP MCP client between the assistant and tool browser. Register each running app through `/api/apps`; descriptors and explicit URL overrides locate its MCP endpoint. The provider sees only six stable tools: `apps_list`, `apps_update`, `apps_open`, `tools_search`, `tools_describe`, and `tools_call`. Search returns concise summaries; describe returns the actual schema and server instructions. Tool cards retain the real app ID, tool, arguments and result.

Registry changes apply to the next discovery or dispatch without resetting the conversation. A visible app is context, not a capability filter. Disabling or removing an app rejects new calls while an already dispatched call can finish. Stop cancels upstream requests. An uncertain write is never replayed automatically. Refresh failures retain the last metadata with an explicit stale status.

The stable `/mcp` endpoint requires a random per-turn header supplied by the host. Browser actions carry the initiating turn and browser IDs; a completed or stopped turn cannot open apps later. This correlation is not deployment authentication.

Read-only browser APIs are `GET /api/apps/{id}/tools`, `POST` to the same URL for refresh, and `POST /api/apps/{id}/discovery` with `{requestId, tool, arguments}`. Discovery requires the explicit `jet/discovery` version 1 marker; generic read-only annotations grant no execution permission. The response contains `{result, catalogue}`. `POST /api/tools/cancel` accepts `{requestId}`. There is no browser business-tool runner.

Connections and catalogue refreshes have 15-second deadlines; calls have a 120-second deadline. Catalogues are capped at 64 pages, 4,096 tools and 2 MiB; results and SSE events are capped at 2 MiB. Search reports truncation after 128 apps or 200 matches. The installed MCP SDK is pinned to 3.5.1 for Quanty compatibility.

## Layout and checks

- `crates/agent`: provider processes, conversations, memory, app registry and tool contracts.
- `crates/jet`: browser server and static UI.
- [App integration contract](docs/app-contract.md): descriptors, stable registry identity and forwarding rules.
- [Host and UI notes](crates/jet/README.md).
- [Character policy](crates/jet/character-policy.md).

```sh
cargo build --workspace
REX_PROD_API=false cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
(cd crates/jet/ui && node --test)
```

These checks use local free fixtures. Browser host integration tests require Python 3 for the controlled CLI stand-in. No desktop SDK or webview is needed.

Optional feelings use `JEV_API_KEY`, with the existing nearest-`.env` lookup. That service is separate from the provider; absence or failure falls back to neutral. Only deliberately run live tests with `REX_PROD_API=true` when intending to contact that service.
