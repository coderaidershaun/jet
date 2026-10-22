# jet

Jet is the first-mate character: a blue kite that stands, flies, waves and becomes a spinner while it works. This crate is Jet's desktop home, a Tauri 2 window around a small animation player and a chat page that Jet lives in. [CONTEXT.md](CONTEXT.md) holds the vocabulary; [character-policy.md](character-policy.md) holds the geometry, motion and emotion rules. Jet reacts to `hello` and `insulted`; `neutral` has no animation.

## Models

Use **Model** and **Thinking** directly below the message box. Models are grouped under
Codex and Claude; selections are saved and apply to the next reply. Changing the model or
thinking level starts a fresh provider session while retaining the visible thread and memory.
The default is **Codex / GPT-6.1 Sol / Medium**.

Install the Codex CLI and run `codex login` once with your ChatGPT account. Jet launches
`codex exec --json` headlessly and uses that sign-in, without an API key. Claude remains
available through its installed `claude` CLI. Custom paths are in Settings → Agent programs.
Codex must support `--ignore-user-config` and `--ignore-rules` (tested with CLI 0.162.1).

Codex can call every tool exposed by enabled library MCP servers. Jet grants those servers
headless tool permission; managed Codex restrictions still apply. No shell tools are exposed.

Codex supports chat resume, the configured library MCP tools, and structured memory review
using GPT-6 Luna. Thinking choices depend on the model. Codex token usage is displayed;
dollar spend is unknown because the CLI does not report it, and the USD budget control
applies only to Claude. See [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

## Run it

The app:

```sh
cargo install tauri-cli --version "^2" --locked   # once
cd crates/jet
cargo tauri dev
```

The pages in a plain browser, with no window and no Claude Code. This starts a small static server that listens on `127.0.0.1` only and sends the app's security policy with every file:

```sh
cargo run -p jet --example serve            # port 8787
cargo run -p jet --example serve -- 9000    # another port
```

It prints two addresses. `http://127.0.0.1:8787/` is the chat, running on a pretend agent that keeps its thread in the browser's storage. `http://127.0.0.1:8787/workstation.html` is the whole workstation on a pretend feed, and its left panel (the toolbar, the latency table and the charts) is built in `ui/workstation/toolbar/`, `latency/` and `chart/`. `http://127.0.0.1:8787/workstation.html?tape=1` replays `ui/bridge/fixtures/polysim-tape.jsonl`, 21 s of real polysim-bridge output recorded from the sim engine, over and over, so the page shows real numbers; commands change nothing in a replay. Without the parameter, or when the tape cannot load, the pretend market runs. Edits to files in `ui/` show on reload. `http://127.0.0.1:8787/workstation/chart/dev.html` is the workstation's charts on their own, on a made-up feed; add `?mode=candles` or `?series=pnl` to start in candles or on PnL, and `?hover=0.6` to put the pointer over the chart.

The pretend agent classifies messages locally and answers from trigger words. Feeling triggers match whole words; the other scenario triggers match a word prefix, ignoring case.

| Write | What happens |
| --- | --- |
| `hi`, `hello`, `hey`, `bye` or `goodbye` | pretend classification resolves `hello` after 400 ms; the reply follows that feeling and Jet waves |
| `useless`, `idiot`, `stupid`, `moron` or `shut up` | pretend classification resolves `insulted` after 400 ms (takes precedence over a greeting); Jet plays the flip and holds the text until the finger is raised |
| other words | pretend classification resolves `neutral` after 400 ms; the reply follows it, with no reaction |
| `slow` | the first word comes after 12 s instead of 2.6 s, so the working loop has time to spin and Stop has time to be pressed |
| `code` | the reply holds a code block |
| `math` | the reply holds inline and display math, a dollar amount, a table of numbers and a code block |
| `fresh` | a new session starts, with a notice in the thread |
| `error` | the reply fails the way Claude Code does when it is not logged in |
| `missing` | the reply fails as if Claude Code was not installed |
| `timeout` | the reply fails with "Claude stopped responding after 2 minutes." |
| `quanty` | a library search comes first: the call and what the library gave back reach the page as `toolStarted` and `toolFinished` events, and as the stream lines behind them, then the answer streams; the `started` event lists the servers of the `mcp` setting. The search is the recorded one plus three hits added by hand, a formula, a table of Greeks and a figure, so every kind of source shows; in a browser the figure reads "Picture unavailable" |
| `quanty down` | the search fails with quanty's own advice, so the thread shows the failed card with the health hint, and the reply says the library is down |
| `engines` | a polysim listing comes first and the thread shows the engine card with four pretend engines; Start, Stop and the mode choice change a pretend fleet that lasts until the page is reloaded, and nothing trades. The next message carries the line the card's actions made, and the reply quotes it after `Noted:` |

The pretend feed makes up the book, the quotes and every line polysim-bridge would send, from a clock and a source of chance, so a browser needs no engine. It trades BTCUSDT and ETHUSDT, and answers every command of the protocol:

| Do | What happens |
| --- | --- |
| `select` an instrument | a new book for BTCUSDT or ETHUSDT, `AWAITING BOOK` for half a second, the whole chart and every row sent again |
| `next_peer` (the link bar's engine chip) | the feed steps to a second, pretend engine that is stale: the ladder pill reads `STALE 850 ms` and from one second `STALE 1.2 s`, as polysim writes it, and the chart holds still, with no new buckets. The next step goes back to the live one |
| any other command | the next tick shows its effect, and the System channel gets a row for it |

## Local checks

From the repository root:

```sh
cargo build --workspace
REX_PROD_API=false cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
(cd crates/jet/ui && node --test)
```

The current suite has 157 Node tests and 65 local Rust tests, plus the live JEV test that returns without a request unless explicitly opted in. Local checks use stand-in programs and local HTTP fixtures; they do not call the live classifier.

The deliberate live check below requires a configured key, contacts the paid/network JEV service and prints latency. Do not put it in default validation:

```sh
REX_PROD_API=true cargo test -p agent --test feeling_live -- --nocapture
```

What they cover:

| Test | Covers |
| --- | --- |
| `src/settings.rs` `missing_file_means_defaults` | no settings file yet gives the defaults |
| `src/settings.rs` `settings_survive_a_round_trip` | what is saved is what is loaded, including the page shown last, written as the word `workstation` |
| `src/settings.rs` `new_fields_round_trip` | the persona, model, the five thinking levels (xhigh and max included), the MCP servers, the workstation and the other chat fields are saved and loaded |
| `src/settings.rs` `old_files_with_missing_fields_still_load` | an older file gets defaults for missing fields, keeps reduced motion, persona and budget, and drops obsolete customization fields when saved again |
| `src/settings.rs` `broken_file_names_the_path` | a file that cannot be read fails with its path in the message |
| `src/settings.rs` `default_settings_match_the_ui_fixture` | `ui/bridge/default-settings.json` is exactly the defaults Rust writes |
| `src/settings.rs` `json_uses_camel_case_for_the_frontend` | the page reads `reducedMotion`, not `reduced_motion` |
| `src/chat/error.rs` `bridge_error_serialises_as_kind_and_message` | every command error reaches the page as `{ kind, message }`, a library call that failed as the kind `library` with the server's own sentence |
| `../agent/tests/workstation_feed.rs` `feed_passes_bridge_lines_and_commands_until_stopped` | polysim-bridge gets the strategy, every link in order and the token; Jet's `starting` line comes first and never shows the token; the bridge's lines pass unchanged while plain text, broken JSON, arrays and an object with script after it are dropped; commands come back echoed in order; a second sink that takes the running bridge over (a page reload) gets Jet's newest `bridge` line, then the bridge's own `hello` and `link` word for word, then the echo of a `resync`, while the first sink hears nothing more; after a stop the process is gone, no line follows and nothing can take the feed over |
| `../agent/tests/workstation_feed.rs` `a_crashed_bridge_restarts_after_each_delay` | a bridge that crashes is started again after each delay and the last delay repeats; the `restarting` line names the exit code and the last error line, its quotes escaped |
| `../agent/tests/workstation_feed.rs` `a_bridge_on_another_protocol_is_stopped_and_not_restarted` | the hello passes, then `exited` names both protocols; a bridge that ignores its input closing is killed, and nothing starts it again |
| `../agent/tests/workstation_feed.rs` `a_missing_bridge_is_reported_once` | a program that is not there gives `starting`, then one `missing` naming the path, and no restart; a command then fails with "not running" |
| `../agent/tests/workstation_feed.rs` `a_bridge_that_rejects_its_arguments_is_stopped_after_two_tries` | a bridge that exits with an error within a second of starting, before any `hello`, is tried once more and then given up: `starting`, `restarting`, `starting`, `exited` naming the exit code and the error line, and no third try |
| `src/chat/image.rs` `a_picture_in_the_library_comes_back_as_a_data_address` | a relative and an absolute path, a PNG, a `.JPG` and a `.jpeg` come back as a `data:` address whose bytes equal the file |
| `src/chat/image.rs` `pictures_outside_the_library_of_another_kind_or_too_large_are_refused` | no quanty folder, a folder that does not exist, a path that leaves the folder, a link that points out of it, a GIF, a folder named `dir.png`, a file over 8 MB and a missing file are each refused with their own error |
| `../agent/src/feeling/mod.rs` | supported finite scores in [0.5, 1] select the highest, ties follow vocabulary order; one question per animated mood; classifier errors propagate safely |
| `../agent/src/feeling/key.rs` | environment wins, then nearest parent `.env`, no process-environment mutation; a nearer file without the key blocks farther files |
| `../agent/src/feeling/jev.rs` | local HTTP checks exact questions/body, complete numeric answer decoding, secret-safe errors and Debug, two-second timeout without retry |
| `../agent/src/conversation/persona.rs` | supported feeling context precedes preface and user words, unknown context cannot inject prompt lines; prompt fingerprint is pinned |
| `../agent/tests/feeling_live.rs` | explicit `REX_PROD_API=true` only: live response scores and latency; otherwise no request |
| `src/chat/mod.rs` `every_mood_word_is_handled_by_the_director` | the words of `agent::Mood` and `MOODS` in `ui/jet/director.js` are the same set |
| `src/chat/libraries.rs` `the_page_reaches_only_the_engine_tools` | the page may call polysim's four engine tools and nothing else, so a mistake in the page can never reach quanty's paid tools |
| `../agent/src/markdown/mod.rs` `math_and_tables_match_the_shared_vectors` | the app's renderer gives the html of every case in `ui/bridge/fixtures/math-vectors.json`: math in prose, display math, money, delimiters that open nothing, code, lists, number columns; and never writes a `style` attribute |
| `ui/bridge/fake-agent.test.mjs` | a reply's events in order with one `message_start`, climbing `message_delta` lines and a result with timing fields; `finished` carries output tokens, thinking tokens and the model; a fresh session, the three failures, stop, and what the storage keeps; 400 ms pretend feelings and matching reply mood; the `quanty` word replays the recorded library search as tool events before the answer; the `engines` word lists the pretend fleet as a tool call, `mcpCall` starts, stops and re-modes it and refuses what polysim would refuse, and a preface is quoted at the start of the reply |
| `ui/bridge/markdown.test.mjs` | the browser fallback gives the same html as the app's renderer for every shared case, with no `style` attribute |
| `ui/bridge/settings.test.mjs` | the defaults carry the chat fields; legacy saves keep reduced motion and persona while obsolete customization fields disappear on a load/save round trip; `defaults_match_the_rust_fixture`: the page's defaults are exactly `ui/bridge/default-settings.json` |
| `ui/bridge/tauri-agent.test.mjs` | with Tauri each agent method (`feel` and `readLibraryImage` too) calls its command with the right argument keys, `mcpCall` through `mcp_call` and `reloadLibraries` through `mcp_reload`, and failures reach the page as `{ kind, message }`; without Tauri the pretend agent is used |
| `ui/bridge/tauri-workstation.test.mjs` | with Tauri the workstation calls its three commands one after another with the right keys, lines of a replaced or stopped channel are dropped, and failures reach the page as `{ kind, message }`; without Tauri the pretend feed is used |
| `ui/bridge/fake-market.test.mjs` `the market opens with hello, link, lifecycle and catalog…` | every line and tick section of the pretend market has the shape, keys and value words of the protocol, and survives JSON unchanged; the hello carries the four channel words and the first tick's channel entries are `full` |
| `ui/bridge/fake-market.test.mjs` `ticks walk the mid, keep the ladder full…` | the mid moves at most one tick a frame, the ladder keeps its rows, channels send only new rows (never `full` after the first tick), chart and risk buckets are only appended, every bucket has all its prices, and a `gap` bucket turns up about every 45 s |
| `ui/bridge/fake-workstation.test.mjs` `each command changes what the market sends next` | every command of the protocol changes the next tick as it should, including a new session, a resync and a pause; a stale engine adds no chart bucket, and its pill reads `STALE 850 ms` and then `STALE 1.2 s` |
| `ui/bridge/fake-workstation.test.mjs` `the recorded tape is real bridge output…` | `ui/bridge/fixtures/polysim-tape.jsonl` is whole lines of JSON, each an object with a `kind`, under the 1 MiB commit limit; it holds hello, link, lifecycle, catalog and tick lines, every one of the ten tick sections, and `seq` runs from 1 with no gap |
| `ui/bridge/fake-workstation.test.mjs` `with a tape the pretend feed replays it…` | the replay says `starting`, plays the tape's lines in order and waits before each tick, ignores commands, starts over after the last line, and is silent after a stop, even when the tape loads after it; a tape that cannot load, or has no tick, falls back to the pretend market with one warning |
| `ui/bridge/fake-workstation.test.mjs` `the pretend feed runs on its clock…` | the feed says `starting`, opens, ticks on its clock, takes a command sent from inside its first lines, and is silent after a stop |
| `ui/workstation/store.test.mjs` `lines land in the store by name…` | each line lands under its kind or section name, listeners hear sections in the protocol's order, every painter runs every frame, a broken listener or painter does not stop the others, and a gap in `seq` is reported |
| `ui/workstation/store.test.mjs` `view commands and the latest pause or resume are remembered…` | the commands that make the view are repeated after a restart, each unit keeps its own grouping, and the latest pause or resume comes last |
| `ui/chat/composer/state.test.mjs` | centred until the first send, Send becomes Stop, Enter and Escape |
| `ui/chat/drawer/cache.test.mjs` | the cache chip is warm until the TTL ends, then cold with the tokens to re-read |
| `ui/chat/drawer/caption.test.mjs` | the gear caption reads the model word and the thinking level |
| `ui/chat/drawer/format.test.mjs` | counts group thousands with commas and shorten from 10 000 up, a dash for a time or a turn count not known yet; spend reads reported, est., no rate or a dash; the model line is the short name and the thinking level |
| `ui/chat/drawer/log.test.mjs` | the log keeps the last 500 lines, tags each by type and pretty-prints JSON |
| `ui/chat/drawer/rates.test.mjs` | the recorded Sonnet turn costs 0.007334 at list price; Haiku 5.5 moves to its long-prompt prices at 100 000 prompt tokens; a model with no price has no estimate |
| `ui/chat/drawer/usage.test.mjs` | the recorded Sonnet turn read line by line (live counts, then the reported cost and timings, then the totals); a second reply at another thinking level gets its own row; a stopped reply keeps its tokens; stray lines change nothing |
| `ui/chat/page-state.test.mjs` | the page switches between the chat and the workstation, and a page already shown or not known changes nothing; Esc closes the sheet first, then takes the workstation back to the chat, then is left to the composer; the page shown last is saved and opens again, and an unknown saved page opens the chat; a wide drawer becomes the rail beside the workstation and is docked as the user left it on the chat, and a narrow drawer is the overlay on both pages |
| `ui/chat/settings/form.test.mjs` | code-point counts |
| `ui/chat/stage/flight.test.mjs` | holds before cruise, bows right, overshoots by 5 px and lands on the slot; scale never exceeds 1 and cruise grows with distance |
| `ui/chat/stage/live.test.mjs` | hero hovers, lanes/reduced motion stay grounded, idle draws at least 30 fps; measured scale widens strokes, carry follows flight timing even during settle, stale reduced-motion fades cannot reparent a newer turn |
| `ui/chat/turn.test.mjs` | flight and classification start together; dispatch waits for feeling/fallback, 2200 ms timeout and failures use neutral with one warning; early successful HTML and announcement obey the reveal deadline; Stop cancels classification/held completion, restores preface, and stale results/events cannot affect the next turn |
| `ui/chat/thread/cards/engines.test.mjs` | the rows, badges and detail lines of a polysim listing; the button follows the state and Start asks unless the fresh mode is off or sim; an action is pending until it settles and a failure stays on its row; each action makes a line for the thread and a preface for the next message |
| `ui/chat/thread/cards/model.test.mjs` | each tool reads as what it is doing while it runs and sums up what came back; a failed call shows the server's advice with the health hint split off, and a call the reply outran says it stopped; each kind of hit (chunk, formula, table, figure, code, footnote, unknown) is shown its own way, with its row line and a page's breadcrumbs |
| `ui/chat/thread/cards/cite.test.mjs` | `[n]` in Jet's text links to the nearest earlier card that holds source n; `[0]`, `[x]` and `[1234]` are not citations; a page's pieces are not sources |
| `ui/chat/thread/math.test.mjs` | a formula is drawn once per mode and the newest are kept; each is labelled for screen readers; a formula KaTeX cannot read keeps its TeX and is tried again; KaTeX's drawings reach the page with no `style` attribute and keep their width |
| `ui/chat/thread/scroll.test.mjs` | the thread follows within 80 px of the bottom, and a send always follows |
| `ui/chat/thread/store.test.mjs` | grouping and day pills, the slot's life from waiting to its end, the held message, a reply's tool calls as they start and finish, and one still running at the end kept as unfinished |
| `ui/chat/thread/throttle.test.mjs` | Markdown renders at most every 50 ms with a trailing call; absolute reveal holds also delay early successful completion, extensions discard stale HTML, cancellation drops delayed work |
| `ui/jet/easing.test.mjs` | `cubicBezier` pins both ends; the motion scripts' curves (ease in-out, out, in, out-back, smooth step, ramp, pulse) give their exact values |
| `ui/jet/maths.test.mjs` | `lerp` blends numbers and arrays, and keeps going past 1 |
| `ui/jet/parts/forms.test.mjs` | the resting kite's 52 points match the reference kite drawing to 0.05 and mirror about the centre line; a lifted corner rises along its pivot arc, stretch adds reach and the left corner mirrors the right; the spinner lies in its band with its opening at the top, and no blend of kite and spinner crosses itself |
| `ui/jet/parts/hand.test.mjs` | the hand fades in between 3 and 13 degrees and its fold and crease share end points on the outline, bowed 3 units into the body; the speed lines appear above 35 degrees a second, trail the motion and mirror on the left |
| `ui/jet/parts/eyes.test.mjs` | eyes A, B and C match the three eye drawings to 0.05 on the lid line (A's fourth corner sits on its slanted edge); a shut lid hides the shape and shows the arch; the lowest point of every kind is on the lid line |
| `ui/jet/parts/string.test.mjs` | the string is 16 segments of 3.75 from the tip and each points 90 degrees plus the wind; a pose blends in base-first with lag and overshoot; payout scales the length and a pose keeps its chords; a written route grows with its length and ends inside the palm; a lying string never goes below the floor; drag leans the chain away from the motion; the points are the same at 30, 60 and 144 frames a second |
| `ui/jet/draw/paint.test.mjs` | the painter's tree has the 52-segment body, the string, two hands and two eyes with the same shape every frame, and no `style` attribute; the right hand's fold is invisible at lift 0 and clear at 30; the spinner has no hands or eyes; every stroke stays at least 0.8 px wide at lane size |
| `ui/jet/draw/view.test.mjs` | the view builds its elements once, only sets attributes afterwards and never writes a style |
| `ui/jet/track.test.mjs` | `sample` holds the first and last values and applies the easing of the key it arrives at; `hold` gives the latest key at or before the time, so a step track never blends |
| `ui/jet/clip.test.mjs` | a writer refuses a time written without its brackets and says how to write it, and `t()` follows the latest key; `finish` refuses a `revealFrom` that is not a phase |
| `ui/jet/player.test.mjs` | a clip plays from the live state and is never changed; the body rolls a tenth of the lift 100 ms late across a clip change; stretch follows the lift speed on the moving corner only; the idle layers stay on during a clip and go off with `layers: false`; the foot stays put at y 0 and y never goes below 0; blinks come on a random gap of 4 to 9 s with a 40 ms hold and never under reduced motion; a keyed eye kind waits for shut lids and round returns on the first idle blink 3 s after a clip; carry adds no position, leans the body into the motion and trails the string behind it |
| `ui/jet/clips/hello.test.mjs` | the played wave matches the sampled wave drawing's roll, hand opacity and wink (the golden, from `fixtures/wave.json`); the brief wave ends at 1650 ms with no wink, both reveal from the wag, their tracks run forward and the kite ends at rest |
| `ui/jet/clips/insulted.test.mjs` | flip golden checks roll, height and eye corners every fifth frame within 0.05, string only during fully blended J (2.0–3.74 s); payout about 1.592, route writes/unwinds, reveal at 2720 ms, hovering endpoint and grounded reduced motion |
| `ui/jet/clips/fly.test.mjs` | the flight has its four phases and a cruise as long as asked (never under the 220 ms ease down), and y overshoots to 64 then settles at 58.8; from standing it crouches and the lying string lets go base-first during the launch, from a hover it dips 4 units |
| `ui/jet/clips/settle.test.mjs` | the landing takes 1080 ms: it rises a touch, the eyes shut and turn round at contact, the body squashes at y 0 and the string lies out to the left |
| `ui/jet/clips/working.test.mjs` | the eyes shut before the body melts and the spin starts 240 ms into the melt; the spinner turns clockwise at 1.1 s a turn, then 1.8 s after eight seconds, and a continuation keeps the angle and the slow spin; the end finishes the turn within 200 to 700 ms, never turns back and opens the eyes only after the form is back to the kite; reduced motion melts and holds the roll |
| `ui/jet/clips/catalogue.test.mjs` | every clip's tracks and phases run forward from a standing and a hovering start; any clip interrupting any clip ends with the kite whole, upright in its squash and lift, eyes open and at rest height, unless it is the spinner |
| `ui/jet/director.test.mjs` | send → flight → feeling reaction → spinner; fast replies skip spinner, late/duplicate feeling ignored, same reply mood adds no reaction, different mood extends absolute reveal; done keeps queued reactions then settles, failed/stopped drop them; reduced motion never flies; four status words |
| `ui/workstation/monitor/cells.test.mjs` | the account's status row (a halt takes the row with its reason, otherwise the last refusal beside ARMED or `--`); side counts (lost turns invalid above zero, a leak shows `+N`); a feature row (changed shows the bar, stale dims the name and greys the value, a value never sent is grey too) |
| `ui/workstation/monitor/channels.test.mjs` | channel deltas go on top newest first and each ring keeps its newest 256; a full set, a new session, generation or instrument, and a new bridge start the rings over, while a tick without those sections does not |
| `ui/workstation/monitor/following.test.mjs` | a list at the top counts nothing, scrolled away it counts what was appended since and the badge says so; the badge brings a list back, and each channel follows on its own |
| `ui/workstation/chart/layout.test.mjs` | the stack splits 70 / 30 under a 30 px strip, each plot is inset 10 with a 72 px gutter, and a pill stays inside the stack; the label count is floor(h / 22) in single precision, and zero when h / 13.2 is under 5 |
| `ui/workstation/chart/model.test.mjs` | buckets append by index, the open bucket is replaced, and a new generation or a new bridge starts over; the window spans capacity slots; a hole or a gap flag breaks the line and a candle takes its colour from close against open; the crosshair picks the bucket under the pointer and shows the frame's own labels |
| `ui/workstation/latency/model.test.mjs` | the latency grid puts the bridge's rows under its column headers, keeps each cell's tone (a short row is padded with `--`, a long one cut) and sets the slot column apart |
| `ui/workstation/toolbar/model.test.mjs` | the toolbar lists the catalog's instruments and shows the view's, defaults to Line, and colours the execution badge like the desktop app: OFF in the border fill, SIM in warning, LIVE in negative |
| `ui/workstation/ladder/controls.test.mjs` | the level stepper steps and drags inside 12 to 30 and reads (N) when fewer rows fit; the grouping list comes from hello for the current unit and each choice sends its own command |
| `ui/workstation/ladder/rows.test.mjs` | the ladder fits floor(side / 8.5) rows, at most 30, and its text shrinks with the row to a 7 px floor; the order shows before the wanted quote; the pointer finds the ask or bid row and the readout spells it out inside the ladder; a chevron shows for each quote off the rows |
| `ui/workstation/linkbar/chips.test.mjs` | the link bar reads "no engine attached" until a link line, then its chips in order; only the engine chip is a button, and only when the bridge allows; the button asserts the next state |

The frontend is plain ES modules with no bundler, so there is nothing to install for `ui/`. Tauri serves the folder as-is (`build.frontendDist` in `tauri.conf.json`), and so does the dev server.

Before adding a clip or a status, read `character-policy.md` for the character rules.

## Where things live

The main paths (tests live beside their JavaScript modules):

```text
crates/agent/src/
  chat/                 Mood vocabulary and public chat types
  conversation/         persona.md, prompt feeling context, sessions and reply lifecycle
  feeling/              mod.rs selection/questions, jev.rs wire client, key.rs discovery
  turn/                 provider processes and stream parsing
crates/jet/
  README.md, CONTEXT.md, character-policy.md
  Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json
  icons/                32x32.png, 128x128.png, 128x128@2x.png,
                        icon.png (512 px), icon.icns, icon.ico
  dev/
    serve.rs            browser server and security policy
    frames.mjs          real-player SVG/PNG frames and contact sheets
    golden.mjs          reference wave/flip fixture extraction
  src/
    lib.rs, main.rs     desktop startup and registered commands
    settings.rs         persisted settings and defaults
    workstation.rs      workstation commands
    chat/
      mod.rs            chat commands and streamed events
      feel.rs           blocking classifier worker exposed as feel_message
      error.rs, image.rs, libraries.rs, provider.rs, review_timer.rs
  ui/
    index.html, chat.css, dom.js, package.json, workstation.html
    assets/tile.png     page background
    bridge/             agent/settings/workstation contracts, Tauri and pretend implementations
      default-settings.json, models.js, fixtures/, markdown.js
    chat/
      main.js, turn.js, clock.js, page-state.js
      composer/         message field, Send/Stop and held message
      drawer/           static kite, cache, usage and log
      settings/         sheet, controls, persona, motion, model, memory,
                        libraries, workstation and agent program sections
      stage/            live.js host, flight.js screen path, stage.css
      thread/           store/view, reveal throttle, math/scroll and cards/
    jet/
      state.js, track.js, clip.js, easing.js, maths.js, geometry.js
      player.js         live state, secondary motion, idle layers and blinks
      director.js       event/feeling queue, absolute reveal deadlines and statuses
      emotions.js       neutral (none), hello, insulted
      parts/            forms.js, eyes.js, hand.js, string.js, routes.js
      draw/             palette.js, paint.js, view.js
      clips/            catalogue.js, hello.js, insulted.js, fly.js,
                        settle.js, working.js (working and workingEnd)
      fixtures/         wave.json, flip.json
    vendor/katex/       KaTeX, 20 fonts, license and version
    workstation/        page/shell/store, controls/, chart/, latency/,
                        monitor/, ladder/, linkbar/, lifecycle/, toolbar/
```

Three ideas carry the design:

1. **The character and clips are JavaScript.** `ui/jet/parts/` builds the kite, eyes and string. Each file in `ui/jet/clips/` writes tracks for the player; `ui/jet/draw/` turns the resulting frame into SVG.
2. **The player blends from wherever Jet is.** `play()` puts the current state at the front of every track, so a new clip never cuts.
3. **Rust owns saved settings in the app.** Settings use `serde(default)` so older files still load; unsupported fields disappear when saved. The browser uses the same defaults and keeps settings in local storage.

## The usage panel

The drawer's Usage panel sits between the cache chip and the raw stream log. It has three groups:

- **This reply**: its status (idle, streaming, done, stopped or failed) beside the heading, then a label and a value on each row: the tokens by kind (in, cache read, cache write as 5 minute and 1 hour, out, thinking), its spend, and its timings (first token, API time, total, turns, stop reason).
- **Session**: replies, tokens and spend since the app started, as three tiles, and under them a table of the same by model and thinking level, hidden until a reply has used tokens. "Session" here means since the app started, not one Claude Code session. Nothing is saved between launches.
- **Model**: the model and thinking level of the current or last reply, the first 8 characters of the Claude Code session id with a Copy button for the whole id, and the date of the list prices. The caption under the gear shows what the next reply will use.

A value not known yet shows a dash. The tokens tile shortens counts from 10 000 up (for example 41.6K); the table under it keeps full counts.

The numbers come from the stream lines while a reply runs: the init line names the session and model, `message_start` gives the prompt tokens, and `message_delta` gives the output tokens so far. While there is no reported cost the spend reads "est." and is worked out from the list prices of 2026-10-14 in `ui/chat/drawer/rates.js`. A model with no price there reads "no rate". The `result` line carries the cost Claude Code reports, the timings and the final counts; from then on the spend reads "reported", and that cost is what the totals add. A reply that is stopped has no reported cost, so the totals add its estimate. The thinking tokens are part of the output tokens and are never added twice.

The `finished` event's `usage` may also carry `outputTokens`, `thinkingTokens` and `model`. The Rust side (`Usage` in `crates/agent/src/chat/usage.rs`) fills them from the result line. When they are there the tracker prefers them to what it read from the stream.

The five thinking levels are `low`, `medium`, `high`, `xhigh` and `max`. The pretend agent writes `message_start` and `message_delta` lines like the real CLI, so in a browser the counts and the timings fill in during a reply too.

The settings sheet's "This session" block reads the same totals, so the two places show the same tokens and the same cost. The sheet writes the tokens in full, and the tile shortens them from 10 000 up.

## Pages and the rail

The main area shows one of two pages: the chat or the workstation. The chat keeps its state and keeps streaming while the workstation shows.

- **There and back.** The Workstation button in the drawer, in the full drawer and in the rail, opens the workstation, and pressing it again goes back. Beside the workstation a wide drawer narrows to the rail, 64 px wide: Jet at the top, the workstation button, and the gear at the bottom. Jet, labelled "Back to" and the persona's name, takes the user back to the chat with the drawer as they left it, docked open or docked closed.
- **Esc.** An open settings sheet closes first. Then the workstation goes back to the chat. Then the composer's own rules apply: the narrow drawer closes, then Stop. A part of the workstation that uses Esc itself calls `event.preventDefault()`, and the page then leaves that Esc alone.
- **Narrow windows** (759 px and less). The drawer is the overlay on both pages and the rail never shows. The workstation's header has its own menu button that opens it.
- **Settings.** `page` is `chat` or `workstation`, and the window opens on it again. `workstation` holds `bridgePath`, `polysimDir`, `strategyId`, `links` and `token`, edited in Settings under Workstation; the workstation starts again a moment after an edit.
- **The workstation** is built, and its feed started, the first time its page opens. The feed gets `pause` while the chat shows and `resume` when the workstation is back. When the bridge reports `missing`, a setup card with an Open Settings button takes the place of the workstation.

## Math and tables

A reply's math is typeset with KaTeX, and a table's columns of numbers are right-aligned. Type `math` into the pretend agent to see both.

- **Delimiters.** `\( … \)` is inline math. `\[ … \]` and `$$ … $$` are display math. A single `$` is money and is never math, so "$100" stays as written.
- **Code is left alone.** Inside a code span or a fenced block, delimiters stay as written.
- **What does not open math shows as written.** An unclosed `\(`, a stray `\)`, an empty `\(\)` and a pair split by a blank line come back as the text they were. While a reply streams, a formula whose closer has not arrived yet shows as text.
- **The markup.** The Markdown renderer (Rust in the app, `ui/bridge/markdown.js` in a browser) draws nothing. Each formula becomes `<span class="math" data-tex="…">…</span>`, with `math-display` added for display math, or `<div class="math math-display" data-tex="…">` when display math is alone in its paragraph. `typeset(node)` in `ui/chat/thread/math.js` finds the `.math` elements below a node and draws each one. A formula KaTeX cannot read keeps its TeX, gets the class `math-error` and is tried again on the next paint.
- **Tables.** A column whose body cells are all numbers (`100`, `-0.25`, `$5`, `5%`, `1,200.50`) gets `class="num"` on its header and its cells, and is right-aligned. A table never carries a `style` attribute. Markdown alignment colons are accepted and ignored. A table keeps its words whole and scrolls sideways when the window is too narrow for it.
- **One set of cases.** `ui/bridge/fixtures/math-vectors.json` holds the cases both renderers must give the same html for. The Rust test and the node test both run it.
- **KaTeX.** KaTeX 0.16.47 (MIT) is vendored in `ui/vendor/katex/`: `katex.mjs`, `katex.min.css`, the 20 `.woff2` fonts and the licence, copied unchanged from the npm tarball. `VERSION` there has the tarball address and its checksum. The page's security policy blocks `style` attributes, and KaTeX writes a few of them itself (the arrow over a vector, tall braces), so `math.js` builds KaTeX's tree through the DOM and moves those styles onto the element's style object, which the policy allows.

To upgrade KaTeX: download the new tarball from the npm registry, check its sha512 against the registry's `dist.integrity` and its `version`, copy the same files byte for byte, and update `VERSION`. Then check that `katex.__renderToDomTree` still exists (it is not a public API) and that `ui/chat/thread/math.test.mjs` still passes.

## Commands the window can call

The settings commands reject with a message string. The chat commands, from `agent_status` down, and the workstation commands reject with `{ kind, message }`, where `kind` is `busy`, `claudeMissing`, `io`, `badLink` or `library`; a workstation command only ever fails with `io`.

| Command | Takes | Returns | Notes |
| --- | --- | --- | --- |
| `load_settings` | nothing | `Settings` | defaults when no file exists yet |
| `save_settings` | `{ settings }` | nothing | |
| `agent_status` | nothing | where Claude Code is (`found`, `path`, `searched`), the data folder, whether a reply is running, and the prompt cache status | the page shows the missing-Claude banner and the cache chip from it |
| `load_history` | nothing | the last 200 entries of the transcript, ready to show | |
| `feel_message` | `{ text }` | `{ mood, scores }` | optional JEV classification; no key immediately returns neutral; failure uses a secret-safe `io` message |
| `send_message` | `{ request, events }` | the saved user entry, at once | the reply streams over the `events` channel; optional `request.feeling` adds supported-word prompt context; fails with `busy` while a reply is running |
| `stop_reply` | nothing | nothing | ends the running reply and keeps the text so far |
| `forget_conversation` | nothing | nothing | the transcript is moved aside and the session is dropped; the notes stay; fails with `busy` while a reply is running |
| `load_memory` | nothing | the three notes and their length limits | |
| `save_memory` | `{ notes }` | the notes as saved, cut to their limits | the next message starts a fresh session so Claude sees them |
| `render_markdown` | `{ text }` | the text as HTML | the page asks while a reply streams; math comes back as `.math` elements for the page to typeset |
| `read_library_image` | `{ path }` | a `data:image/png;base64,…` or `data:image/jpeg;base64,…` address | a relative path is read from the quanty folder (`mcp.quanty.cwd`); a file outside it once links are followed, not .png/.jpg/.jpeg, or over 8 MB is refused with kind `io` |
| `open_link` | `{ url }` | nothing | opens `http`, `https` and `mailto` links in the user's own apps; any other scheme fails with `badLink` |
| `mcp_call` | `{ server, tool, args }` | the tool's result: its structured content, else its text as JSON, else the text | only polysim's four engine tools (`list_strategies`, `start_strategy`, `stop_strategy`, `set_execution_mode`); fails with `library` when the server refused, is not running in Jet or did not answer within 30 s |
| `mcp_reload` | nothing | nothing | reads the saved settings again, stops the shared servers that changed or were switched off, then starts the new ones |
| `workstation_start` | `{ workstation, events }` | nothing | starts polysim-bridge from the workstation settings; its lines stream over the `events` channel, each as the JSON object it is. When the bridge is still kept running from the same settings (a page reload), it is not restarted, so the link to the engine stays up: the new channel gets Jet's newest `bridge` line and the bridge's newest `hello`, `link`, `lifecycle` and `catalog`, and a `resync` is sent to the bridge. With different settings, or when the bridge was given up on, the running one is stopped and a new one started |
| `workstation_command` | `{ command }` | nothing | sends one command object to the bridge; fails with `io` when the bridge is not running |
| `workstation_stop` | nothing | nothing | stops polysim-bridge; nothing happens when it is not running |

## The workstation feed

The workstation page reads one stream of lines. Inside the app they come from polysim-bridge, which Jet runs and starts again when it fails; in a browser they come from the pretend feed. Every line is one JSON object with a `kind`: `hello`, `link`, `lifecycle`, `catalog`, `tick` (whose sections are `view`, `ladder`, `summary`, `account`, `features`, `channels`, `latency`, `chart`, `risk` and `gaps`, present only when they changed) and `bye` come from the bridge. `ui/bridge/workstation.js` holds the type of each.

Jet adds its own `{ "kind": "bridge", "status", "detail" }` line, and `detail` is a plain sentence for the user:

| `status` | When |
| --- | --- |
| `starting` | a run is about to start, the first one or one after a failure |
| `restarting` | a run ended on its own; the detail names the exit code, the last error line and the wait |
| `exited` | the bridge speaks another protocol, or it stopped twice in a row within a second of starting and before its `hello`; either way it is not started again |
| `missing` | the program or its folder is not there, or no path is set; nothing more happens until the next `workstation_start` |

A stop that Jet asked for sends no line. Only a line that is one whole JSON object with a string `kind` reaches the page, because the webview runs what a channel sends as script; plain text and broken lines are dropped, and the first one of a run is printed on Jet's own error output. A failed run is started again after 1 s, then 2 s, then 5 s, then every 10 s, and the waits start over after a run of 30 s. A bridge that stops twice in a row within a second of starting, before it says `hello`, failed on its arguments or its start-up, so a third try would fail the same way: Jet sends `exited` with the exit code and the last error line, and asks you to check the settings (strategy, links, token). A bridge that crashes after its `hello` is still started again. The link token is never printed or logged by Jet, but polysim-bridge takes it as an argument, so it shows in the process list.

The page folds every line into its store and paints once per animation frame. It sends `resync` when a tick's `seq` jumps inside one session, and after each `hello` it sends its view commands again (the last `select`, `chart_mode`, `dom_unit`, `dom_grouping` for each unit, `dom_levels`, `dom_fit`, `chart_ticks` and `risk_series`, and the latest `pause` or `resume`), so a restarted bridge shows the same view.

Where the protocol leaves a choice, the pretend feed makes this one. A chart bucket's `cl` is a mid with the extra decimal, such as `118000.005`. A chart bucket always has all its prices; `gap` is true on the first bucket after the book lost snapshots, and the pretend feed marks one about every 45 s. Prices in the ladder, the trades and the fills are decimal strings. A ticks grouping is `{ unit: "ticks", perBucket, label }`.

The tape, `ui/bridge/fixtures/polysim-tape.jsonl`, is polysim-bridge's own output recorded while it was attached to the sim engine: the first 255 lines of the recording, which are the opening lines (`hello`, three `link`, two `lifecycle` and `catalog`) and 248 ticks, about 21 s. It is cut there to stay under the 1 MiB limit of the commit hook; never edit or re-indent a line of it. `workstation.html?tape=1` plays it with `REPLAY_TICK_MS` (84 ms, the average gap between its ticks) before each tick, and when it ends it sends a `starting` bridge line and plays it again, so every area starts over as after a bridge restart. To record a new one, run this from the polysim root with the sim engine on 127.0.0.1:9310, where `$JET` is the path of this crate, `crates/jet`:

```sh
sleep 40 | ./target/release/polysim-bridge --strategy strat-micro-recorder --link 127.0.0.1:9310 > tape.jsonl
head -n 255 tape.jsonl > "$JET/ui/bridge/fixtures/polysim-tape.jsonl"
```

Stdin has to stay open, because the bridge runs until its stdin closes: with `< /dev/null` it ends at once. The tape test says when the file is too big.

Each part of the workstation is an area: a folder `ui/workstation/<area>/` whose `mount.js` exports `mount({ root, store })`. `root` is the area's mount point. The `store` has `onFrame(name, fn)` for every line kind and section name, `register(name, painter)` with `painter(nowMs)` called every animation frame, `send(command)`, `latest(name)` and `leave()`. Adding an area changes no shared file. Mount every area before calling `store.start()`: an area that folds the append-only sections (`chart`, `risk` and `channels`) needs the `catalog` and the full window that arrive right after the start. The areas are `toolbar`, `latency`, `chart`, `monitor`, `ladder`, `linkbar` and `lifecycle`; one that is missing or fails to mount shows its raw sections instead.

## Libraries over MCP

Jet's Claude reaches two libraries through MCP servers: quanty, the user's library of quantitative finance books, and polysim, which runs the trading engines. The `mcp` settings key holds one entry for each, `{ enabled, command, cwd }`. The defaults point at this machine's quanty and polysim checkouts, which suits a single-user desktop app for now. The page sends the key with every message.

How a reply reaches them:

- The enabled servers go inline as `--mcp-config` JSON. It is built from the settings and from the addresses of the shared servers (below), which stay the same for the whole session, so it is the same bytes every turn and Claude's prompt cache keeps hitting. A shared server is an `http` entry, `{"timeout":300000,"type":"http","url":"http://127.0.0.1:<port>/mcp"}`. Any other server starts through `/bin/sh` in its own folder, because Claude Code ignores a `cwd` in the config, and has a 300 second timeout.
- `--tools ToolSearch` keeps the tool descriptions out of the prompt: Claude loads one when it needs it.
- `--allowedTools` names every tool exactly, so a tool a server adds later stays off, and the four polysim engine tools, `set_execution_mode` included, are named; Jet asks the user before any step toward live.
- `--safe-mode` is gone because it drops MCP servers. `--setting-sources '' --disable-slash-commands` and the variables `CLAUDE_CODE_DISABLE_CLAUDE_MDS` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY` do the rest of its job: no CLAUDE.md, no Claude Code memory, no user settings or commands. The notes review keeps the same isolation and gets no servers.
- A library whose program does not take `--http` is not shared: Claude Code starts its own copy for each reply and closes it when the reply ends, so an engine polysim started, or a quanty ingest, stops with the reply, and the persona tells Jet so.

Shared servers. Jet keeps one copy of each enabled library running for the whole app session (`SharedServers` in `crates/agent/src/mcp/`). Claude's replies and the page's engine card reach that same copy, so an engine that either one starts is seen by the other and outlives the reply:

- The program is started as `<program> --http <port>` in its folder, on a free port of this machine. polysim is also given `--watch-stdin` and a pipe for its input that Jet holds open and never writes to; quanty has no such flag, and an older polysim-mcp that does not know it exits at once, so it is not shared. It is ready when its error output says `listening on http://127.0.0.1:<port>/mcp`. A program that exits within 2 seconds of its first start, before that line, has no `--http` mode: it is not shared, and the persona describes the per-reply lifetime again.
- The settings are read at launch and again after a change (`mcp_reload`). A server whose settings did not change is left alone. One that changed or was switched off is stopped first, and only then is a new copy started, so two copies of one library never run side by side. Sends and card calls wait while that happens.
- A server is stopped with SIGTERM (polysim's pipe is closed just before) and given up to 25 seconds to put its affairs in order (polysim stops its engines), then it is killed. The same happens when the app closes. A shared server that dies is started again on the same port after 1, 2, 5 and then 10 seconds.
- When Jet ends however it ends (a quit, SIGTERM, a force quit, a crash, `cargo tauri dev` restarting the app), the system closes polysim's pipe, and polysim stops its engines and exits. A quanty-mcp has no such pipe and outlives a Jet that is killed. Only a polysim-mcp that itself crashes leaves its engines running, and the next copy cannot see them.
- The page calls the shared server with `mcp_call`, through a small MCP client over local HTTP (`ureq`; JEV uses the same crate with rustls for HTTPS). A library that is not shared fails the call with a plain message instead of starting a short-lived copy, because a short-lived polysim would stop what it started and could not see engines that run elsewhere.

The engine card. When Claude's result for `polysim/list_strategies` arrives, the thread draws a card above the reply: a row for each engine with its state, its mode, `Start` or `Stop`, a mode choice and, where the listing has a link, `Open in workstation`. Every card in the thread shows the newest listing; a listing restored from the saved thread says it is from an earlier reply until the card lists again. Start always lists first and applies the live rule to that fresh row: it asks unless the mode is exactly `off` or `sim`, so a live engine, one whose config cannot be read and one with a mode nobody knows all ask. Setting a mode to `live` always asks, and Claude cannot change a mode at all. An action shows a spinner on its row, then a line in the thread (`You started … · 22:41`), and the next message carries a preface for Claude in front of the user's words (`[Jet: the user started … at 22:41]`); the saved thread keeps only the user's words. After each action the card lists again, and it lists quietly when Claude starts or stops an engine itself. A failed action leaves its message on its row.

Settings has a Libraries section with a switch, a program and a folder for each library. A switch takes effect when its save lands; a program or folder takes effect when Settings closes, so typing a path never restarts polysim. Changing polysim, or switching it off, restarts it, and every engine it started stops.

What the page gets:

- `started` carries `mcp`: each server and its state. Only `failed` means offline; `pending` is still starting.
- `toolStarted` when Claude has written a call (`id`, `server`, `tool`, `input`) and `toolFinished` when it comes back (`ok`, `result`, a one-line `summary` such as `quanty · search · 5 results`, and `durationMs`). Only MCP tools make events; Claude Code's own ToolSearch stays in the raw log. A call still running when the reply ends gets no `toolFinished`.
- The saved entry keeps its finished calls in `tools`. Entries without calls look as they did before.
- The thread shows each call as a card above the reply: a spinner while it runs, then a folded card of what came back. `[n]` in the reply becomes a chip that opens source n of the nearest card above it. A figure's picture is read through `read_library_image` when its row opens.
- While a call runs, Claude may stay silent three times as long as usual, so a reply times out after 6 minutes of silence then.
- The text of separate calls to the model is joined with a blank line, and a mood line that opens a later call is removed too; the first mood of the reply counts.

The recording `crates/agent/tests/fixtures/quanty-search-reply.jsonl` is a real reply to "what is vega?". These tests of the agent crate cover the feature: `turn::stream::tests::parses_the_recorded_quanty_search`, `turn::tools::tests::calls_are_paired_summed_up_and_set_apart_from_text`, `turn::claude::args::tests::chat_and_review_args_are_exact_without_safe_mode_which_drops_mcp_servers`, `chat::event::tests::event_json_matches_the_ui_contract`, the two persona tests `the_prompt_teaches_the_libraries` and `the_fingerprint_of_the_defaults_is_pinned`, and the contract test `a_recorded_quanty_search_reaches_the_page_and_the_thread`, which runs the recording through `fake-claude`, `Conversation` and the saved thread. The shared servers have contract tests in `crates/agent/tests/shared_servers.rs`, with the `fake-mcp` program standing in for the library programs: `a_shared_server_gets_its_own_port_and_answers_over_one_session`, `an_event_stream_reply_gives_the_response_with_the_matching_id`, `a_crashed_server_is_unreachable_then_comes_back_on_the_same_address_and_a_lost_session_is_opened_again`, `a_program_without_http_is_left_to_claude`, `a_settings_change_stops_the_old_copy_first_restarts_only_that_server_and_switching_off_sends_sigterm` and `a_shared_polysim_watches_its_input_and_stops_when_it_closes`. The preface is covered by `vanished_session_retries_once_fresh_with_a_notice`.

## Feelings and reply timing

`agent.feel(text)` calls the Tauri command `feel_message(text)`; its blocking worker returns `Feeling { mood, scores }`. On **each call**, Rust first reads a nonblank `CONVERTER_JEV_API_KEY` environment value. Otherwise it walks from the current working directory upward to the nearest `.env` file and reads that file only. A nearer file with no usable key prevents falling through to an ancestor. `.env` is ignored by Git; no key is stored in Settings and there is no feelings section. No key returns neutral immediately.

With a key, JEV receives the user's message over HTTPS at `https://api.typesafe.ai/v1/systemone`, bearer authorization, model `jev-1.13.0`. The request is `{ state: {}, model, questions: { hello: { type: "noul", instructions: { line: text, question } }, insulted: { ... } } }`. There is one yes/no question per animated emotion, none for neutral. The answer is `{ answers: { hello: { noul: number }, insulted: { noul: number } } }`; missing, malformed or nonnumeric required answers fail decoding. Selection accepts only supported finite scores in [0.5, 1], chooses the highest, and breaks ties in `Mood::ALL` order (`hello` before `insulted`); otherwise neutral. Returned scores retain the received map.

The backend caps one request at **2 s**, with no retry or redirect. The page caps classification at **2200 ms**, falls back to neutral on timeout/error and warns once per page lifetime without server details. Client Debug hides the key; errors carry only `MissingKey`, `Http`, `Rejected { status }` or `Decode`, with no transport details or response body. The production no-key path returns neutral rather than a missing-key error. Local HTTP fixtures verify the wire contract; real service quality and latency remain unmeasured here.

On send, flight and classification start together. Model dispatch waits only for classification/fallback. `SendRequest.feeling: Option<String>` becomes `Message.feeling`; only a supported word reaches the prompt as `[Jet: reading this, you feel insulted]`, before any engine preface and user words. The persona asks the provider to let this colour its answer and start with that mood unless the reply changes the feeling. This context applies to both providers.

The director queues a feeling's clip after the flight brake. Text waits for `revealAt`, an **absolute monotonic deadline** consumed by `holdUntil(at)`: hello's wag starts at 650 ms, insulted's hold at 2720 ms, measured from the reaction's start. An early successful terminal waits too: final HTML, announcement and held-next-message dispatch stay behind that deadline. A reply mood equal to the feeling, or neutral, adds no reaction; a different animated mood queues after spinner closure and extends the hold. Spinner starts only after classification/reaction and only while no reply has arrived. A quick answer skips it.

Done preserves queued reactions then settles. Failure and Stop discard queued reactions, cancel the reveal hold and settle after closing a spinner as needed. Stop during classification prevents model dispatch and returns a taken engine preface. Turn identity guards ignore stale classifier results and provider events; reduced-motion fade callbacks also check their generation. The actual fly launch ends at 500 ms; screen carry follows the returned cruise timing, not a fixed illustrative send timeline.

## Settings

The sheet has **eight sections**, in order, built by `ui/chat/settings/sheet.js`:

| Section | Contents |
| --- | --- |
| Persona | Name, job title, notes on how to talk |
| Motion | Reduced-motion switch; combined with system preference |
| Model and thinking | Provider/model, supported effort choices, Claude budget and current usage |
| Memory | MEMORY, USER and RECENT editors |
| Libraries | quanty/polysim switches, programs and folders |
| Workstation | Bridge path, folder, strategy, links and link token |
| Agent programs | Codex/Claude paths and provider status |
| Forget this conversation | Confirmation to clear the thread while keeping notes |

Edits save after 600 ms without another edit. Library switches reload after saving; typed library paths wait until the sheet closes. Settings Rust/JavaScript defaults are checked against `ui/bridge/default-settings.json`; legacy fields are ignored and disappear on a save. The character palette and authored motion have no customization fields.

## Adding a clip or emotion

Use `buildX(start, options)` and `createClip()` track writers, `t()`, `phase()` and `finish({ revealFrom })`. Times are milliseconds and reveal names a phase's **start**. Bring tracks the clip does not own back to rest with `returnToRest(start, ownedTracks)`, so interruption resets the previous form, lift, scowl and string data. Add the builder to `clips/catalogue.js`; `working` is the sole hold.

For an emotion, also add `EMOTIONS`, the single-line `MOODS` export, Rust `Mood`/`ALL`/word mapping, persona mood description, JEV question, golden coverage and a row in the test table. Follow the complete [emotion checklist and visual QA](character-policy.md#adding-an-emotion). No vocabulary entry comes before its authored animation.

## Preview and icons

From this crate, `node dev/frames.mjs hello /tmp/jet-preview` and `node dev/frames.mjs insulted /tmp/jet-preview` play the real player at 25 fps and write SVG frames, 2× and lane-size PNGs plus contact sheets. `--layers off` disables idle layers for reference comparisons; `--standing` and `--reduced-motion` exercise variants. The tool requires `/opt/homebrew/bin/rsvg-convert`. See [the policy's render commands](character-policy.md#before-you-show-it).

The six checked-in desktop icons are generated from the real standing blue kite, round eyes, bow and no string. The source recipe is `node dev/frames.mjs still --standing --no-string <temporary-folder>`, then adapt the temporary SVG's preview background to the icon's square dark rounded background with transparent corners and centre the standing body/bow. Feed that SVG to `cargo tauri icon <svg> -o <temporary-icon-folder>` (tauri-cli 2.12.2 supports SVG). Copy only `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, `icon.icns`, `icon.ico`; the other generated desktop/mobile formats stay outside the repository. Inspect all sizes, especially 32 px and the bow's bottom margin.

Offline frames and local tests do not verify whole-page or native behavior. Browser checks for greetings, insults, neutral sends, Stop/retry, early completion and reduced motion, native Tauri drawer/lane/icon appearance, and real JEV quality/latency remain outstanding manual QA. Do not open Tauri or make a live JEV call as part of the default checks.
