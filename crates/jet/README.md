# Jet browser host

`cargo run -p jet -- --listen 127.0.0.1:8787 --data-dir ./jet-data` serves the chat in a normal browser. `jet --help` lists deployment options. The data directory owns settings, transcript, session, notes, the app registry and the files: the ones Jet has written and the ones the user attached. `--ui-dir` points to the static `ui/` directory when the executable is copied elsewhere.

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
- `GET /api/voice`: `{ available, reason, hear: { available, reason }, cues: [{ tag, weight }] }`, whether Jet can speak and whether it can hear, and the vocal cues such as `<laugh>` that the voice performs (listed even when voice is off). `POST /api/voice/speech`: `{ text, mood }` (`mood` optional: `hello` is said warm and bright, `insulted` clipped and irritated), a piece of Markdown of at most 2,000 characters; answers the words that are spoken as raw `audio/L16;rate=24000;channels=1`, and an empty body when there is nothing to say aloud. A refusal is `{ kind, message }`: 503 `notConfigured`, 413 `tooLong`, 429 `rateLimited`, 502 `rejected` (Google refused the key or the voice) or `http`. The key, the voice (`GEMINI_VOICE_ID`) and the model (`GEMINI_TTS_MODEL`, optional) are read on each call from the environment or the nearest `.env`, are never part of Settings, and never reach the page. `POST /api/voice/hear?vocabulary=Jet&vocabulary=Quanty`: a raw body of 16 kHz 16-bit mono PCM (`audio/L16;rate=16000;channels=1`, any body is read as PCM; at most 20 seconds); answers `{ text }`, empty when nothing was said, or a refusal as above: 413 `tooLong` past 20 seconds, 429 `rateLimited` over four calls at once, 90 seconds of audio a minute or the daily allowance (`GEMINI_HEAR_DAILY_MINUTES`, default 60). The model is `GEMINI_HEAR_MODEL` (default `gemini-3.5-transcribe`) and hearing needs only the key. `--disable-voice` turns all three routes off.
- `GET/POST /api/apps`: the deterministic registry operations documented in the app contract.
- `POST /api/files?name=<name>`: saves an uploaded file, sent as the raw request body, and returns its details (`id`, `name`, `kind`, `bytes`, `details`, `origin`, `attached`, `at`). The name's extension and the first bytes of the file must agree on one of PDF, Markdown, HTML, `.xlsx`, CSV, text, PNG, JPEG, GIF or WebP, or the answer is 415. A file over 32 MiB, or one that would take the store past 2 GiB, is 413. A file the reader process cannot describe is refused with 415 and not kept. The file stays hidden from Jet until a message names its id.
- `DELETE /api/files/{id}`: deletes an upload that was never sent (204). A file that was sent, one Jet wrote, or an id that is not a UUID is 404.
- `GET /api/files/{id}` and `GET /api/files/{id}/view`: a file Jet wrote or one that was uploaded, as a download and for opening in a tab. The id must be a UUID; anything else is 404. Responses carry `nosniff`. Everything except a PDF also carries a `sandbox` content security policy; a PDF carries none, because Chrome's PDF viewer stays blank under one.
- `POST /api/chat/send` also takes `attachments`, a list of at most 10 upload ids. The text may be blank when there are attachments. An id that is not an upload is 400.

## The file reader

Every parse of a stored file (its details at upload, and `files_read`) runs in a child of the running program started as `jet --read-file`, and never in the server itself. The child sets `RLIMIT_AS` to 2 GiB before it reads the job from standard input, and prints one JSON answer; the server allows 30 seconds and 16 MiB of output, runs two children at a time, and kills a child that is late. A crash, an abort from a failed allocation or a hang therefore gives only a refused file. The child sets the core dump limit to 1, not 0, because the host sends core dumps to a helper program that the kernel skips only at 1.

Provider paths come from server settings. Process-command MCP configuration is rejected; the host never launches legacy app processes.

A lost acknowledgment is retried with the same request ID. The transcript records acceptance before provider dispatch, so restart can recover the association. An orphaned accepted turn becomes interrupted without repeating its tools. The bounded event tail, active-turn snapshot and last 512 cancelled request IDs live in memory; there is no durable event database. Stop ends pending browser send retries and targets one request, so a delayed Stop cannot cancel a later reply. Cancellation IDs for requests never accepted are retained only until eviction or server restart.

A reply is drained on the server independently of browser connections. The server cancels active provider work on shutdown, invalidates review timers, cancels an active review, and bounds browser connection drain. Idle memory review retains the existing 91-second schedule. Shutdown does not start a new unbounded exit review.

## UI

`ui/bridge/browser-agent.js` is the transport. `ui/chat/main.js` composes the existing thread, composer, character, settings and drawer. `ui/chat/turn.js` also restores server snapshots without resending input or repeating feeling classification.

Voice is off until the speaker button inside the message box is pressed, and the choice is kept in the browser (`jet.voice`), because sound belongs to the device. A reply sent from this page while voice is on is held back and shown word by word as Gemini speaks it (`ui/chat/voice/`); a reply restored from another page or from history is never spoken.

Listening is off until the mic button beside the speaker is pressed; the two sit in one pill (`#voice`, then `#hear`) at the right end of the message box, and the mic's choice is kept in the browser (`jet.hear`). The engine in `ui/chat/hear/engine/` (voice detector, endpointer, thought judge, utterance queue and `hearing.js`) has no page elements and is tested in Node. The microphone, `hear/capture.js` with its audio worklet, needs a browser and is handed to the engine. `hear/connect.js` is the only place that joins the engine to the page, and it loads the detector and builds the engine on the first start, never before. `hear/hear-toggle.js` shows the engine's state on the mic (`data-state`, tooltip, announcement through `#announce`, the ring through `--level`), `hear/dictation.js` lands heard words in the field one every 35 ms (all at once under reduced motion) and keeps the message's auto-send flag, and `composer/view.js` gives them `dictate`, `sendNow` (the Enter path, so a spoken turn while Jet replies is held), the Send halo `setPending` and the "Listening…" placeholder. The voice player gains `duck`/`unduck` (a second gain node) and `audible` for barge-in. The microphone starts only from a click, or from a remembered choice with a permission the browser reports as granted; a context the browser leaves suspended waits for the first touch.

Markdown still passes through the Rust renderer. The character policy and animation modules remain unchanged. Web/mail links open through the browser. Source images resolve against the tool call’s registered stable app ID and use its contained mount. Invalid, removed-app, direct/external and historical filesystem images show an unavailable fallback. See the [image contract](../../docs/app-contract.md#tool-result-images).

## Verification

From the repository root run the commands in the root README. `tests/integration/` starts the actual host binary against a Python provider fixture and tests HTTP acceptance/retry, reconnect, restart, busy/Stop, saved commands and bounded shutdown. JavaScript tests cover transport cursor/retry behavior and the existing character/chat rules. The [browser harnesses](tests/browser/README.md) exercise actual Chrome, app recovery, contained images, retained frames and network separation; unit tests alone do not prove those paths.
