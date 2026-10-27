# Jet browser host

`cargo run -p jet -- --listen 127.0.0.1:8787 --data-dir ./jet-data` serves the chat in a normal browser. `jet --help` lists deployment options. The data directory owns settings, transcript, session, notes, the app registry and the files Jet has written. `--ui-dir` points to the static `ui/` directory when the executable is copied elsewhere.

The [root guide](../../README.md) covers registration, commands, Quanty launch and
existing-data reuse. Chat starts in the main content beside one drawer. Selecting
an app collapses that drawer to an icon rail; Jet returns to the preserved chat.
`/tools` uses the main content, and settings stay at the drawer footer. The
workspace retains visited frames and chat drafts across navigation. `/app reload`
refreshes only its target with current registry endpoints. Live iframe state does
not survive a full browser reload. App disable prevents new tool calls while
retaining its UI and configuration.

## Browser bridge

The browser uses JSON commands and one server-sent event stream:

- `GET /api/snapshot`: history, active turn, server epoch and event cursor.
- `GET /api/events?epoch=...&cursor=...`: bounded replay followed by live events. A stale cursor or a new epoch produces a fresh snapshot.
- `POST /api/chat/send`: client-generated `requestId`, `clientId`, message/model/persona fields. Returns the accepted server `turnId` and user entry. Reusing a request ID with different content returns conflict.
- `POST /api/chat/stop`: `requestId` of the request to cancel; `POST /api/chat/forget` clears the conversation and deletes the files Jet wrote.
- `GET/PUT /api/settings`, `GET/PUT /api/memory`.
- `GET /api/status`, `POST /api/markdown`, `POST /api/feel`.
- `GET/POST /api/apps`: the deterministic registry operations documented in the app contract.
- `GET /api/files/{id}` and `GET /api/files/{id}/view`: a file written by `files_export`, as a download and for opening in a tab. The id must be a UUID; anything else is 404. Responses carry `nosniff`. HTML and Markdown also carry a `sandbox` content security policy; a PDF carries none, because Chrome's PDF viewer stays blank under one.

Provider paths come from server settings. Process-command MCP configuration is rejected; the host never launches legacy app processes.

A lost acknowledgment is retried with the same request ID. The transcript records acceptance before provider dispatch, so restart can recover the association. An orphaned accepted turn becomes interrupted without repeating its tools. The bounded event tail, active-turn snapshot and last 512 cancelled request IDs live in memory; there is no durable event database. Stop ends pending browser send retries and targets one request, so a delayed Stop cannot cancel a later reply. Cancellation IDs for requests never accepted are retained only until eviction or server restart.

A reply is drained on the server independently of browser connections. The server cancels active provider work on shutdown, invalidates review timers, cancels an active review, and bounds browser connection drain. Idle memory review retains the existing 91-second schedule. Shutdown does not start a new unbounded exit review.

## UI

`ui/bridge/browser-agent.js` is the transport. `ui/chat/main.js` composes the existing thread, composer, character, settings and drawer. `ui/chat/turn.js` also restores server snapshots without resending input or repeating feeling classification.

Markdown still passes through the Rust renderer. The character policy and animation modules remain unchanged. Web/mail links open through the browser. Source images resolve against the tool call’s registered stable app ID and use its contained mount. Invalid, removed-app, direct/external and historical filesystem images show an unavailable fallback. See the [image contract](../../docs/app-contract.md#tool-result-images).

## Verification

From the repository root run the commands in the root README. `tests/integration/` starts the actual host binary against a Python provider fixture and tests HTTP acceptance/retry, reconnect, restart, busy/Stop, saved commands and bounded shutdown. JavaScript tests cover transport cursor/retry behavior and the existing character/chat rules. The [browser harnesses](tests/browser/README.md) exercise actual Chrome, app recovery, contained images, retained frames and network separation; unit tests alone do not prove those paths.
