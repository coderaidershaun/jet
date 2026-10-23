# Jet browser host

`cargo run -p jet -- --listen 127.0.0.1:8787 --data-dir ./jet-data` serves the chat in a normal browser. `jet --help` lists deployment options. The data directory owns settings, transcript, session, notes and the app registry. `--ui-dir` points to the static `ui/` directory when the executable is copied elsewhere.

## Browser bridge

The browser uses JSON commands and one server-sent event stream:

- `GET /api/snapshot`: history, active turn, server epoch and event cursor.
- `GET /api/events?epoch=...&cursor=...`: bounded replay followed by live events. A stale cursor or a new epoch produces a fresh snapshot.
- `POST /api/chat/send`: client-generated `requestId`, `clientId`, message/model/persona fields. Returns the accepted server `turnId` and user entry. Reusing a request ID with different content returns conflict.
- `POST /api/chat/stop`: `requestId` of the request to cancel; `POST /api/chat/forget` clears the conversation.
- `GET/PUT /api/settings`, `GET/PUT /api/memory`.
- `GET /api/status`, `POST /api/markdown`, `POST /api/feel`.
- `GET/POST /api/apps`: the deterministic registry operations documented in the app contract.

Provider paths come from server settings. Process-command MCP configuration is rejected; the host never launches legacy app processes. The existing provider-process helpers remain available to both CLI adapters.

A lost acknowledgment is retried with the same request ID. The transcript records acceptance before provider dispatch, so restart can recover the association. An orphaned accepted turn becomes interrupted without repeating its tools. The bounded event tail, active-turn snapshot and last 512 cancelled request IDs live in memory; there is no durable event database. Stop ends pending browser send retries and targets one request, so a delayed Stop cannot cancel a later reply. Cancellation IDs for requests never accepted are retained only until eviction or server restart.

A reply is drained on the server independently of browser connections. The server cancels active provider work on shutdown, invalidates review timers, cancels an active review, and bounds browser connection drain. Idle memory review retains the existing 91-second schedule. Shutdown does not start a new unbounded exit review.

## UI

`ui/bridge/browser-agent.js` is the real transport. `ui/chat/main.js` composes the existing thread, composer, character, settings and drawer. `ui/chat/turn.js` also restores server snapshots without resending input or repeating feeling classification.

A deliberately configured development page may set `globalThis.__JET_FAKE__ = true` before loading the chat to use the in-browser fixture. This is never inferred from missing desktop globals. Production settings and notes remain server-owned.

Markdown still passes through the Rust renderer. The character policy and animation modules remain unchanged. Native opening and arbitrary filesystem image reads are gone; web/mail links open through the browser, and unavailable file images show the existing fallback.

## Verification

From the repository root run the commands in the root README. `tests/integration/` starts the actual host binary against a Python provider fixture and tests HTTP acceptance/retry, reconnect, restart, busy/Stop, saved commands and bounded shutdown. JavaScript tests cover transport cursor/retry behavior and the existing character/chat rules. Actual browser screenshots and reload checks are separate acceptance evidence, not implied by unit tests.
