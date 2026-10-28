# Jet

Jet is a browser home for independently running apps, with one shared assistant conversation. Its Rust server runs the installed Claude Code or Codex CLI, keeps the transcript and notes, and serves the existing HTML/JavaScript interface.

## Run

```sh
cargo run -p jet -- --listen 127.0.0.1:8787 --data-dir ./jet-data
```

Open `http://127.0.0.1:8787/`. Install and sign in to Claude Code or Codex on the server, then select it in Settings. The browser never silently selects a pretend agent. A missing provider is shown as an actionable status/error.

For access from another computer, choose a reachable listen address. `--public-origin https://jet.example` records the externally visible origin for app forwarding. `--ui-dir PATH` selects the shipped static asset directory; the default is this checkout's `crates/jet/ui`. Keep the UI files with the executable when deploying a copied build. `--disable-feelings` disables optional JEV classification for offline development/testing.

Jet targets a trusted single-user deployment. Authentication is deferred. App processes run independently; Jet does not install, launch or stop them.

## This server's deployment

Jet's system service is `jet.service`; it starts at boot and restarts on failure.
The installed executable is `/home/ubuntu/.local/bin/jet`, with persistent data in
`/home/ubuntu/.local/share/jet` and UI assets from this checkout. Nginx forwards
HTTPS on port 443 to Jet on `127.0.0.1:8787`, with buffering disabled for event
streams and WebSocket forwarding enabled. UFW permits TCP ports 443 and 80;
port 80 redirects to HTTPS and supports certificate validation.

The deployment files are [the systemd unit](deploy/jet.service) and
[the Nginx site](deploy/jet.nginx.conf). The configured public origin is
`https://xchainanalytics.com`.
Public DNS points this name to `5.175.217.125`. Nginx uses a trusted Let's Encrypt
certificate under `/etc/letsencrypt/live/xchainanalytics.com/`; Certbot's enabled
renewal timer maintains it automatically. The live Nginx site is
`/etc/nginx/sites-available/jet`.
Jet has no authentication, so use this public deployment only with the access
policy appropriate to your trusted single-user setup.

To update the executable and restart Jet:

```sh
cargo build -p jet --release --locked
install -m 0755 target/release/jet /home/ubuntu/.local/bin/jet.new
mv /home/ubuntu/.local/bin/jet.new /home/ubuntu/.local/bin/jet
sudo systemctl restart jet
sudo systemctl status jet --no-pager
sudo journalctl -u jet -n 50 --no-pager
```

Quanty is registered at `http://127.0.0.1:7878/`. Its independently managed user
service has a `jet-integration.conf` drop-in enabling `--trusted-integration`
on loopback. Its descriptor and MCP endpoint are available independently of the
WASM UI bundle. If the UI reports that the bundle is missing, finish Quanty's UI
build, rebuild and deploy its server, then use `/app reload Quanty` to reload the app.

## Existing data

Point `--data-dir` at an existing conversation directory, or a copy. It contains `transcript.jsonl`, `session.json`, `MEMORY.md`, `USER.md` and `RECENT.md`. Copy the old desktop `settings.json` from its configuration directory into the selected data directory to retain provider/persona settings. Old transcript entries remain readable.

Old process-command app settings are rejected with re-registration instructions and never launched or silently erased. Follow [the app contract](docs/app-contract.md) to preserve the original file and register each running app by URL. New installs contain no machine-specific app defaults.

## Browser behavior

The server owns the active reply. Closing a tab, reconnecting or hiding the interface does not cancel it; Stop does. A browser request ID is saved with the accepted transcript entry before provider dispatch. Retrying a lost acknowledgment returns that same turn. After a server crash, unfinished accepted turns are marked interrupted and never rerun automatically.

An authoritative history/current-turn snapshot and bounded event replay restore browsers after reload. Settings and memory are saved on the server. Source images use the originating app’s stable mount, even after switching workspaces. Unsupported images, including historical filesystem references, show an unavailable fallback; Jet never reads arbitrary server files; `/api/files/{id}` serves only a file Jet wrote or the user uploaded, found by its UUID.

## Apps and workspace

Start the app independently, then use `/app add 7878 "Research"` or ask Jet to register it.
A port means loopback on the Jet server; a full HTTP(S) URL can reach another host.
Labels are editable and need not be unique; stable IDs identify registrations.
Ask Jet to change explicit UI/MCP endpoint overrides when an app has no descriptor.
An unreachable app is saved with a discovery error so you can retry later.

Jet chat fills the main content initially. One left drawer lists Jet, then each registered
app with its icon and label, then settings at the foot. Context capacity stays folded
behind a chevron beside Jet's name. Selecting an app fills the content and collapses the
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
| `/model [model-id]` | Show choices or save the model for the next reply. |
| `/thinking [level]` | Show valid levels or save thinking for the next reply. |
| `/tools [id-or-label]` | Browse the global tool catalogue or one app. |

Context shows the last measured tokens and the selected model’s available capacity. Provider limits are used when reported; Codex can also read its installed model metadata. Missing counts or limits stay unknown, and aggregate usage fallbacks are labelled estimates. Reload preserves measurements; a fresh conversation or Forget clears them.

Quoted labels work. Missing or ambiguous targets offer a choice. Slash commands
run directly without a model request; unknown commands show help.
Ordinary-language app management uses the same registry through the assistant.
Complete explicit commands execute without a second confirmation.

## Attaching files

The **+** at the left of the message box opens a picker for PDF, Markdown, HTML, Excel (`.xlsx`), CSV, text and image (PNG, JPEG, GIF, WebP) files. Dragging files onto the chat and pasting them into the field attach them too. Each file shows as a chip in the box and uploads at once; Send waits until every upload is done, and a chip that failed must be removed with its **×** first. A message may be files alone.

Jet sees an upload only after the message that carries it is sent, and then only its details (name, size, and pages, sheets, rows or pixel size) with an instruction to leave the file alone until asked. When the user asks about a file's contents, Jet reads it with `files_read`: PDFs by page, workbooks and CSV by row, other text by line, and pictures as a picture. A file you remove before sending is deleted from the server. The thread keeps the files on the message, and Forget deletes them all.

Jet is served publicly with no login, so every path is bounded: 32 MiB for a file, 10 files for a message and 2 GiB for the store of files. The extension and the first bytes must both match one of the kinds above, and a file Jet cannot read is refused. Every read of a stored file runs in a child process of the `jet` program (`jet --read-file`) with a 2 GiB memory cap and a 30 second limit, two at a time, so a file built to exhaust memory or to hang ends only that child. Uploads stay on disk until Forget, and an upload that was never sent counts toward the 2 GiB.

## App tools

Jet shares one HTTP MCP client between the assistant and tool browser. Commands and `/api/apps` share the registry; descriptors and explicit URL overrides locate each MCP endpoint. The provider sees only nine stable tools: `apps_list`, `apps_update`, `apps_open`, `tools_search`, `tools_describe`, `tools_call`, `files_export`, `files_list` and `files_read`. `files_export` writes a PDF, Markdown or HTML file from Markdown the provider composes, and the thread shows it as a download card; the files live under `files/` in the data directory until Forget. `files_list` lists the files Jet can read, and `files_read` reads one when the user asks (see Attaching files). Maths in a file is written as in chat (`\( \)`, `\[ \]`), and a single `$` is money. Search returns concise summaries; describe returns the actual schema and server instructions. Tool cards retain the real app ID, tool, arguments and result.

Tools shows searchable summaries, actual input/output schemas, annotations, server identity, capabilities and instructions. Refresh retries failed metadata; stale results remain visibly marked. Only explicitly marked free discovery operations can expand into a hierarchy. Inspect a leaf or use Ask Jet to draft a request; browsing never executes ordinary business tools. In particular, normal Quanty search can cost money.

Registry changes apply to the next discovery or dispatch without resetting the conversation. A visible app is context, not a capability filter. Disabling or removing an app rejects new calls while an already dispatched call can finish. Stop cancels upstream requests. An uncertain write is never replayed automatically. Refresh failures retain the last metadata with an explicit stale status.

The stable `/mcp` endpoint requires a random per-turn header supplied by the host. Browser actions carry the initiating turn and browser IDs; a completed or stopped turn cannot open apps later. This correlation is not deployment authentication.

Read-only browser APIs are `GET /api/apps/{id}/tools`, `POST` to the same URL for refresh, and `POST /api/apps/{id}/discovery` with `{requestId, tool, arguments}`. Discovery requires the explicit `jet/discovery` version 1 marker; generic read-only annotations grant no execution permission. The response contains `{result, catalogue}`. `POST /api/tools/cancel` accepts `{requestId}`. There is no browser business-tool runner.

Connections and catalogue refreshes have 15-second deadlines; calls have a 120-second deadline. Catalogues are capped at 64 pages, 4,096 tools and 2 MiB; results and SSE events are capped at 2 MiB. Search reports truncation after 128 apps or 200 matches. The installed MCP SDK is pinned to 3.5.1 for Quanty compatibility.

## Quanty

Quanty normally listens on `127.0.0.1:7878`. Jet integration needs its explicit
loopback-only trusted mode; ordinary password/token modes remain available for
standalone use.

For a working integration, prepare Quanty independently of Jet:

1. **Build the browser UI before the server.** Install Rust/Cargo, the
   `wasm32-unknown-unknown` target, and Trunk following Quanty's README. From the
   Quanty checkout, run:

   ```sh
   rustup target add wasm32-unknown-unknown
   (cd crates/web-ui && trunk build --release)
   cargo build --release --locked -p server
   ```

   The server embeds `crates/web-ui/dist` at build time. Repeat both builds after
   a UI change, install the new server executable, and restart Quanty. A server
   built without the bundle can expose its descriptor and MCP tools while `/`
   returns HTTP 503 with “The UI bundle is not built.” Successful tool discovery
   does not establish that the browser UI is ready. Keep Trunk's `public_url`
   set to `"./"` so assets work below Jet's `/apps/{id}/` mount.

2. **Prepare the library and its dependencies.** Normal library operations need
   Qdrant and FalkorDB, with persistent storage and matching connection settings
   in Quanty's `.env`. The usual local ports are Qdrant gRPC `6334` (HTTP `6333`)
   and FalkorDB `6379`; these stores stay on loopback. Configure
   `EMBEDDING_GEMINI_API_KEY` for embeddings, `CONVERTER_JEV_API_KEY` for PDF math
   conversion, and Poppler for PDF processing. On a host with an IPv6 address,
   check that Google serves it: if Gemini answers `User location is not supported`
   over IPv6 and `200` over IPv4, set `EMBEDDING_GEMINI_IPV4_ONLY=true` in
   Quanty's `.env` (see Quanty's `docs/troubleshooting.md`). Install and sign in to the selected

   Codex or Claude CLI as the account running Quanty; keep `ANTHROPIC_API_KEY`
   unset for Quanty's subscription-based Claude use. These requirements depend
   on the operation; the isolated fixture below needs none of them. Use Quanty's
   health display to check stores and model tools; a responding HTTP process or
   MCP catalogue alone does not validate keys or library readiness.

3. **Run in trusted integration mode on loopback.** Leave `QUANTY_PASSWORD` and
   `QUANTY_MCP_TOKEN` unset or empty in both the service environment and the
   library's `.env`. Trusted mode rejects configured credentials and a non-loopback
   listener. Unsetting shell variables alone is insufficient when `.env` still
   supplies them. Keep the library/home path explicit, since it selects `.env`
   and library data. With the release build above:

   ```sh
   /path/to/quanty/target/release/quanty --home /path/to/your/library \
     --listen 127.0.0.1:7878 --trusted-integration
   ```

4. **Keep Quanty running independently.** Jet only registers and forwards to it.
   Its service needs the correct home/working directory, `.env`, executable and
   `PATH`, plus persistent store services. On this server, inspect
   `systemctl --user status quanty quanty-stores` and
   `journalctl --user -u quanty -n 50 --no-pager`. The user services need lingering
   enabled to survive logout and start at boot. After changing a unit or drop-in,
   run `systemctl --user daemon-reload` and restart Quanty.

5. **Verify UI and tools separately, then register.** On the Jet server:

   ```sh
   curl --fail http://127.0.0.1:7878/
   curl --fail http://127.0.0.1:7878/jet-app.json
   ```

   Expect the UI to return HTTP 200 and the descriptor to declare
   `embedding: "relative-paths"`, `ui: "./"` and `mcp: "mcp"`. In Jet, run
   `/app add 7878 "Quanty"` once; for an existing registration, use
   `/app reload Quanty`. Open `/tools Quanty` to check MCP discovery without
   executing paid searches. On this deployment, 18 tools were discovered with
   no stale/error status. Finally open Quanty in Jet and check its UI renders.

For HTTPS Jet, set `--public-origin` to the actual public HTTPS origin (here,
`https://xchainanalytics.com`). Only Jet's reverse proxy needs public ports 443
and 80; Quanty remains on loopback HTTP and needs no separate public port or
certificate. The proxy must support streaming and WebSockets. Trusted Quanty
inherits Jet's access boundary; Jet currently has no authentication.

For a free, isolated trial, use a separate port and fresh home. This does not
replace an already running Quanty:

```sh
QUANTY_TEST_HOME=$(mktemp -d /tmp/quanty-jet-acceptance.XXXXXX)
env -i PATH="$PATH" /path/to/quanty/target/release/quanty \
  --home "$QUANTY_TEST_HOME" --listen 127.0.0.1:18878 \
  --fixture black-scholes --trusted-integration
```

Add `18878` in Jet. The trusted fixture exposes free tools: `catalog` lists them
by group, `search` and `fixture_page` read a built-in sample with a figure for
source cards and citations, and a fake `ingest_pdf` starts a job that
`watch_job` follows through the stages of a real ingest. Normal search is
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
