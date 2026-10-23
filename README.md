# Jet

Jet is a browser home for independently running apps, with one shared assistant conversation. Its Rust server runs the installed Claude Code or Codex CLI, keeps the transcript and notes, and serves the existing HTML/JavaScript interface.

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

An authoritative history/current-turn snapshot and bounded event replay restore browsers after reload. Settings and memory are saved on the server. Source images use the originating app’s stable mount, even after switching workspaces. Unsupported images, including historical filesystem references, show an unavailable fallback; Jet never reads arbitrary server files.

## Apps and workspace

Start the app independently, then use `/app add 7878 "Research"` or ask Jet to register it.
A port means loopback on the Jet server; a full HTTP(S) URL can reach another host.
Labels are editable and need not be unique; stable IDs identify registrations.
Ask Jet to change explicit UI/MCP endpoint overrides when an app has no descriptor.
An unreachable app is saved with a discovery error so you can retry later.

Jet chat fills the main content initially. One left drawer contains Jet, registered
apps, usage and settings. Selecting an app fills the content and collapses the
drawer to an icon rail. Jet returns to the preserved chat and desktop drawer;
last selected app context remains available to Jet. Narrow screens default to the
rail, with an expandable drawer and settings always available. `/tools` opens the
tool browser in the main content. Switching views preserves drafts, visited frames
and active replies. `/app reload` reloads only its target; a full browser reload
clears live iframe state. One reply can run across all tabs; other sends receive a
busy response.

| Command | Action |
| --- | --- |
| `/app add <address> [label]` | Register an app; missing address gives inline examples. |
| `/app list` | Show every registration. |
| `/app open <id-or-label>` | Show the app in this browser. |
| `/app edit [id-or-label]` | Show configuration and guidance to ask Jet for changes. |
| `/app reload [id-or-label]` | Reload the target or last selected app with current endpoints. |
| `/app remove <id-or-label>` | Forget the registration without stopping the app. |
| `/app enable <id-or-label>` / `/app disable <id-or-label>` | Allow or prevent new MCP calls. |
| `/tools [id-or-label]` | Browse the global tool catalogue or one app. |

Quoted labels work. Missing or ambiguous targets offer a choice. Slash commands
run directly without a model request; unknown commands show help.
Ordinary-language app management uses the same registry through the assistant.
Complete explicit commands execute without a second confirmation.

## App tools

Jet shares one HTTP MCP client between the assistant and tool browser. Commands and `/api/apps` share the registry; descriptors and explicit URL overrides locate each MCP endpoint. The provider sees only six stable tools: `apps_list`, `apps_update`, `apps_open`, `tools_search`, `tools_describe`, and `tools_call`. Search returns concise summaries; describe returns the actual schema and server instructions. Tool cards retain the real app ID, tool, arguments and result.

Tools shows searchable summaries, actual input/output schemas, annotations, server identity, capabilities and instructions. Refresh retries failed metadata; stale results remain visibly marked. Only explicitly marked free discovery operations can expand into a hierarchy. Inspect a leaf or use Ask Jet to draft a request; browsing never executes ordinary business tools. In particular, normal Quanty search can cost money.

Registry changes apply to the next discovery or dispatch without resetting the conversation. A visible app is context, not a capability filter. Disabling or removing an app rejects new calls while an already dispatched call can finish. Stop cancels upstream requests. An uncertain write is never replayed automatically. Refresh failures retain the last metadata with an explicit stale status.

The stable `/mcp` endpoint requires a random per-turn header supplied by the host. Browser actions carry the initiating turn and browser IDs; a completed or stopped turn cannot open apps later. This correlation is not deployment authentication.

Read-only browser APIs are `GET /api/apps/{id}/tools`, `POST` to the same URL for refresh, and `POST /api/apps/{id}/discovery` with `{requestId, tool, arguments}`. Discovery requires the explicit `jet/discovery` version 1 marker; generic read-only annotations grant no execution permission. The response contains `{result, catalogue}`. `POST /api/tools/cancel` accepts `{requestId}`. There is no browser business-tool runner.

Connections and catalogue refreshes have 15-second deadlines; calls have a 120-second deadline. Catalogues are capped at 64 pages, 4,096 tools and 2 MiB; results and SSE events are capped at 2 MiB. Search reports truncation after 128 apps or 200 matches. The installed MCP SDK is pinned to 3.5.1 for Quanty compatibility.

## Quanty

Quanty normally listens on `127.0.0.1:7878`. Jet integration needs its explicit
loopback-only trusted mode; ordinary password/token modes remain available for
standalone use. With a built Quanty checkout and its WASM bundle:

```sh
/path/to/quanty/target/debug/quanty --home /path/to/your/library \
  --listen 127.0.0.1:7878 --trusted-integration
```

For a free, isolated trial, use a separate port and fresh home. This does not
replace an already running Quanty:

```sh
QUANTY_TEST_HOME=$(mktemp -d /tmp/quanty-jet-acceptance.XXXXXX)
env -i PATH="$PATH" /path/to/quanty/target/debug/quanty \
  --home "$QUANTY_TEST_HOME" --listen 127.0.0.1:18878 \
  --fixture black-scholes --trusted-integration
```

Add `18878` in Jet. The trusted fixture exposes free `fixture_page` and `search`
tools, including a figure for source cards and citations. Normal search is
unchanged. This fixture needs no accounts, ingestion or paid provider calls;
asking a real chat provider to use it still uses that provider.

Mounted apps must use relative browser paths. Remote URLs do not supply login or
SSO, and framing restrictions still apply to direct embedding. Jet does not read
iframe DOM, selection or storage. See the [app contract](docs/app-contract.md)
for supported content URLs and deployment limits.

## Layout and checks

- `crates/agent`: provider processes, conversations, memory, app registry and tool contracts.
- `crates/jet`: browser server and static UI.
- [App integration contract](docs/app-contract.md): descriptors, stable registry identity and forwarding rules.
- [Host and UI notes](crates/jet/README.md).
- [Browser acceptance commands](crates/jet/tests/browser/README.md).
- [Character policy](crates/jet/character-policy.md).

```sh
cargo build --workspace
REX_PROD_API=false cargo test --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo fmt --all -- --check
(cd crates/jet/ui && node --test)
```

These checks use local free fixtures. Browser host integration tests require Python 3 for the controlled CLI stand-in. No desktop SDK or webview is needed.

Optional feelings use `JEV_API_KEY`, with the existing nearest-`.env` lookup. That service is separate from the provider; absence or failure falls back to neutral. Only deliberately run live tests with `REX_PROD_API=true` when intending to contact that service.
