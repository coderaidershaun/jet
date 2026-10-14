# jet

Jet is the first-mate character: a circle that stands up, waves, spins while it works and melts back. This crate is Jet's desktop home, a Tauri 2 window around a small animation player and a chat page that Jet lives in. `CONTEXT.md` holds the words this crate uses, and `character-policy.md` holds the rules for how Jet looks and moves.

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

It prints two addresses. `http://127.0.0.1:8787/` is the chat, running on a pretend agent that keeps its thread in the browser's storage. `http://127.0.0.1:8787/lab.html` is the lab, a page of buttons and dials for trying every clip. Edits to files in `ui/` show on reload.

The pretend agent answers from the words in your message. A word counts when a word of the message starts with it, in any case.

| Write | What happens |
| --- | --- |
| a mood word: `neutral`, `happy`, `excited`, `thinking`, `curious`, `sorry`, `alert`, `annoyed` or `hello` | the reply starts with that mood; with no mood word, every third reply gets one anyway |
| `slow` | the first word comes after 12 s instead of 2.6 s, so the working loop has time to spin and Stop has time to be pressed |
| `code` | the reply holds a code block |
| `fresh` | a new session starts, with a notice in the thread |
| `error` | the reply fails the way Claude Code does when it is not logged in |
| `missing` | the reply fails as if Claude Code was not installed |
| `timeout` | the reply fails with "Claude stopped responding after 2 minutes." |

Tests:

```sh
cargo test --workspace && cargo clippy --workspace --all-targets
cd crates/jet/ui && node --test
```

What they cover:

| Test | Covers |
| --- | --- |
| `src/rig.rs` `embedded_rig_is_complete` | the embedded rig has its version, a full pose set, the eye positions and the rest colour |
| `src/rig.rs` `every_grounded_pose_shares_the_foot` | the foot stays planted in every pose that is not airborne |
| `src/rig.rs` `airborne_poses_never_sink_below_the_ground` | a rolling or flying pose never goes below the ground |
| `src/rig.rs` `wrong_pose_size_is_reported` | a pose with the wrong number of values is refused, with the number found |
| `src/settings.rs` `missing_file_means_defaults` | no settings file yet gives the defaults |
| `src/settings.rs` `settings_survive_a_round_trip` | what is saved is what is loaded |
| `src/settings.rs` `new_fields_round_trip` | the persona, body colour, model and the other chat fields are saved and loaded |
| `src/settings.rs` `old_files_with_missing_fields_still_load` | an older file gets defaults for the fields it lacks |
| `src/settings.rs` `broken_file_names_the_path` | a file that cannot be read fails with its path in the message |
| `src/settings.rs` `json_uses_camel_case_for_the_frontend` | the page reads `reducedMotion`, not `reduced_motion` |
| `src/chat/error.rs` `bridge_error_serialises_as_kind_and_message` | every command error reaches the page as `{ kind, message }` |
| `src/chat/mod.rs` `every_mood_word_is_handled_by_the_director` | the words of `agent::Mood` and `MOODS` in `ui/jet/director.js` are the same set |
| `rig/poses.rs` `generator_prints_the_committed_rig` | the generator prints exactly `rig/jet.json` |
| `ui/bridge/fake-agent.test.mjs` | a reply's events in order, a fresh session, the three failures, stop, and what the storage keeps |
| `ui/bridge/settings.test.mjs` | the defaults carry the chat fields; merge fills gaps from them |
| `ui/chat/composer/state.test.mjs` | centred until the first send, Send becomes Stop, Enter and Escape |
| `ui/chat/drawer/cache.test.mjs` | the cache chip is warm until the TTL ends, then cold with the tokens to re-read |
| `ui/chat/drawer/log.test.mjs` | the log keeps the last 500 lines, tags each by type and pretty-prints JSON |
| `ui/chat/settings/form.test.mjs` | hex and rgb both ways, code-point counts, the master moves only the channels that follow it |
| `ui/chat/stage/flight.test.mjs` | the flight holds, lands on the slot, turns toward travel and mirrors going left; the cruise grows with distance |
| `ui/chat/thread/scroll.test.mjs` | the thread follows within 80 px of the bottom, and a send always follows |
| `ui/chat/thread/store.test.mjs` | grouping and day pills, the slot's life from waiting to its end, the held message |
| `ui/chat/thread/throttle.test.mjs` | markdown renders at most every 50 ms with a trailing call; the first reveal waits for the mood |
| `ui/jet/clip.test.mjs` | a time writer refuses a bare `t` |
| `ui/jet/clips/annoyed.test.mjs` | a centred or deferential Jet never glares, tints or narrows its eyes |
| `ui/jet/clips/catalogue.test.mjs` | in every clip: tracks run forward, shape 0 and eyes 0 hold, any interruption comes to rest |
| `ui/jet/clips/hello.test.mjs` | tracks run forward, ends at the circle, each dial does its job, the brief hello |
| `ui/jet/clips/working.test.mjs` | the loop opens top right, spins clockwise, slows after 8 s, continues, and closes after its turn |
| `ui/jet/clips/zoom.test.mjs` | the ground moves only mid-cruise, the host sets the cruise, the dials and reduced motion, a hello after a zoom |
| `ui/jet/director.test.mjs` | send, zoom and loop; quick reply; mood; done waits; stop; typing; unknown mood; reduced motion |
| `ui/jet/easing.test.mjs` | `cubicBezier` pins both ends |
| `ui/jet/maths.test.mjs` | `lerp` blends and may run past 1 |
| `ui/jet/player.test.mjs` | a clip starts from the live state and ends at rest |
| `ui/jet/rig.test.mjs` | `pathFrom` writes one closed path |
| `ui/jet/track.test.mjs` | the sampler holds the ends and applies the easing |

The frontend is plain ES modules with no bundler, so there is nothing to install for `ui/`. Tauri serves the folder as-is (`build.frontendDist` in `tauri.conf.json`), and so does the dev server.

Before adding a pose, a clip or a status, read `character-policy.md`. It says how Jet is meant to move and why the rig is built the way it is.

## Where things live

```
crates/jet
├── README.md                       this file
├── CONTEXT.md                      the words this crate uses, each with one meaning
├── character-policy.md             how to animate Jet; read first
├── Cargo.toml                      the library, the binary, and the poses and serve examples
├── build.rs                        the Tauri build step
├── tauri.conf.json                 window, security policy, bundling
├── capabilities/
│   └── default.json                what the window may ask of the Rust side
├── icons/                          generated from the rig's standing pose
│   ├── icon.png                    the full-size source icon, 1024 px
│   ├── 128x128@2x.png              256 px bundle icon
│   ├── 128x128.png                 128 px bundle icon
│   ├── 32x32.png                   32 px bundle icon
│   ├── icon.icns                   macOS bundle icon
│   └── icon.ico                    Windows bundle icon
├── dev/
│   └── serve.rs                    the dev server: serves ui/ to a browser, std only (cargo run -p jet --example serve)
├── rig/
│   ├── poses.rs                    prints rig/jet.json; poses are constructed, not drawn
│   ├── shape.rs                    the geometry a pose is built from: circles, ellipses, standing bodies
│   └── jet.json                    the rig: every pose × 10 anchors, eye positions, palette
├── src/
│   ├── main.rs                     desktop entry point
│   ├── lib.rs                      checks the rig, opens the window, registers the commands
│   ├── rig.rs                      the character definition, embedded and checked at start-up
│   ├── settings.rs                 remembers the dials and the chat settings between launches (app config folder)
│   └── chat/
│       ├── mod.rs                  the commands the chat page calls, and the channel that streams a reply to it
│       ├── error.rs                the error every chat command fails with, sent as `{ kind, message }`
│       └── review_timer.rs         the timer that keeps Jet's notes current once the chat goes quiet
└── ui/
    ├── index.html                  the chat page: header, drawer, thread, composer, settings dialog
    ├── chat.css                    the chat page's tokens, layout and header
    ├── lab.html                    the lab page: Jet, a button for every clip, and the dials
    ├── styles.css                  the lab's look, and the ground colour of Jet's eyes and ring
    ├── package.json                the `node --test` script, nothing to install
    ├── assets/
    │   └── tile.png                the pattern behind the thread
    ├── bridge/                     the pages' way to the Rust side, with browser fallbacks
    │   ├── rig.js                  loadRig: the rig from Rust, or rig/jet.json in a browser
    │   ├── settings.js             the Settings shape, defaults, behaviour presets, merge, load and save
    │   ├── settings.test.mjs       the defaults carry the chat fields; merge fills gaps from them
    │   ├── agent.js                connectAgent: the one way to talk to Claude, and the types of its events
    │   ├── fake-agent.js           the pretend Claude the chat runs on in a browser
    │   ├── fake-agent.test.mjs     a reply's events in order, a fresh session, the three failures, stop, storage
    │   ├── fake-script.js          what the pretend Claude says and the stream lines it writes
    │   └── markdown.js             a small, safe Markdown renderer for the browser fallback
    ├── chat/                       the chat page
    │   ├── main.js                 boot: loads the rig, settings and history, builds every part, hands each its parts
    │   ├── turn.js                 one turn: a send, each event of the reply, the end of the reply
    │   ├── clock.js                how the page writes times and days
    │   ├── dom.js                  helpers that build elements without markup strings
    │   ├── stage/                  the live Jet
    │   │   ├── live.js             the live Jet node, the director host, lane placement, the frame loop
    │   │   ├── flight.js           the path of Jet from where it stood to the new lane (pure)
    │   │   ├── flight.test.mjs     the flight holds, lands, turns and mirrors; the cruise grows with distance
    │   │   └── stage.css           the empty state, the hero spot and the live Jet's place in a lane
    │   ├── thread/                 the conversation
    │   │   ├── store.js            messages, notices, the running reply and the held message, as rows (pure)
    │   │   ├── store.test.mjs      grouping and pills; the slot's life; the held message
    │   │   ├── view.js             draws the rows: bubbles, lanes, marks, dots, code blocks, links
    │   │   ├── scroll.js           when the thread follows new text (pure)
    │   │   ├── scroll.test.mjs     follows within 80 px of the bottom; a send always follows
    │   │   ├── throttle.js         when streamed text becomes HTML: at most every 50 ms, stale answers dropped
    │   │   ├── throttle.test.mjs   the 50 ms rule with a trailing call; the first reveal waits for the mood
    │   │   └── thread.css          rows, bubbles, lanes, marks, pills and the Markdown inside bubbles
    │   ├── composer/               the field and the Send/Stop button
    │   │   ├── state.js            the composer's rules: where it sits, the button, Enter, Escape (pure)
    │   │   ├── state.test.mjs      centred until the first send; Send becomes Stop; Enter and Escape
    │   │   ├── view.js             the field, the button, the held chip, and the hop to the bottom
    │   │   └── composer.css        the composer's look
    │   ├── drawer/                 the side panel
    │   │   ├── view.js             the static Jet and name, the cache chip, the stream log, the gear
    │   │   ├── log.js              the last 500 raw stream lines, tagged, ready to pretty-print (pure)
    │   │   ├── log.test.mjs        the 500 cap, the tags, the pretty-print
    │   │   ├── cache.js            warm or cold wording for the cache chip (pure)
    │   │   ├── cache.test.mjs      warm until the TTL ends, then cold with the tokens to re-read
    │   │   └── drawer.css          docked beside the thread on wide screens, over it on narrow ones
    │   └── settings/               the settings sheet
    │       ├── sheet.js            the dialog and its nine sections; saves after the last edit
    │       ├── controls.js         the few form controls the sections are made of
    │       ├── persona.js          who Jet is: name, job title, how to talk
    │       ├── look.js             body colour, behaviour presets, expressiveness, reduced motion
    │       ├── model.js            model, effort, the budget for one turn, usage so far
    │       ├── memory.js           the three notes as editors
    │       ├── claude.js           where Claude Code is, and Forget this conversation
    │       ├── form.js             colour and counter arithmetic, the master's rules (pure)
    │       ├── form.test.mjs       hex and rgb both ways; code-point counts; the master moves its followers
    │       └── sheet.css           the sheet's look
    ├── jet/                        the engine
    │   ├── rig.js                  the rig as the page sees it; turns a pose into an SVG path
    │   ├── rig.test.mjs            pathFrom writes one closed path
    │   ├── state.js                Jet at one moment: the six tracks, the ring's numbers, colour
    │   ├── track.js                keyframe tracks and how to sample one
    │   ├── track.test.mjs          the sampler holds the ends and applies the easing
    │   ├── easing.js               cubic-bezier, same numbers as CSS
    │   ├── easing.test.mjs         cubicBezier pins both ends
    │   ├── maths.js                lerp and clamp
    │   ├── maths.test.mjs          lerp blends and may run past 1
    │   ├── clip.js                 what a clip is, and how the dials reach one (readDials, createClip, onOff)
    │   ├── clip.test.mjs           a time writer refuses a bare t
    │   ├── clips/                  one file per clip
    │   │   ├── catalogue.js        the one list of every clip: label, builder, whether it is a hold
    │   │   ├── catalogue.test.mjs  in every clip: tracks run forward, shape 0 and eyes 0 hold, any interruption comes to rest
    │   │   ├── beats.js            the beats the mood clips share: stand up, melt back, the dials they read
    │   │   ├── hello.js            stand up, wave, melt
    │   │   ├── hello.test.mjs      tracks run forward, ends at the circle, each dial does its job
    │   │   ├── zoom.js             wind up, roll past the scenery, brake
    │   │   ├── zoom.test.mjs       the ground moves only mid-cruise; a hello after a zoom stops it
    │   │   ├── working.js          the working loop and how it closes
    │   │   ├── working.test.mjs    the loop spins clockwise, slows after 8 s, continues, closes after its turn
    │   │   ├── thinking.js         head tilt, one slow blink
    │   │   ├── excited.js          hop, one arm up, squint, flush
    │   │   ├── annoyed.js          narrowed eyes and a flush, then a bow
    │   │   ├── annoyed.test.mjs    a centred or deferential Jet never glares
    │   │   ├── done.js             a quick squash and settle; a long one with a hop and a smile
    │   │   ├── needs-you.js        leans toward the user and waits to be noticed
    │   │   ├── error.js            a bow, with an optional stretch; calm, never a shake
    │   │   ├── interrupted.js      the loop collapses to the pip, waits, grows back
    │   │   └── lean.js             the lean while the user types, and the lean back (holds)
    │   ├── director.js             chooses and orders clips for each chat event; the MOODS list
    │   ├── director.test.mjs       send, zoom and loop; quick reply; mood; done waits; stop; typing; unknown mood; reduced motion
    │   ├── player.js               owns Jet's state, plays clips from wherever Jet is; no DOM
    │   ├── player.test.mjs         a clip starts from the live state and ends at rest
    │   ├── view.js                 draws a state into an SVG: body, ring, eyes; the only code that draws Jet
    │   └── scene.js                scenery in its own SVG layers, scrolled by the speed track; not part of Jet
    └── lab/                        the controls around Jet
        ├── main.js                 boot, frame loop, a step list for each button, replay-on-change, save-on-change
        ├── wheel.js                behaviour wheel, presets, axis sliders
        ├── dial.js                 expressiveness dial and the four channels
        └── readout.js              what the dials turned into, progress bar
```

Three ideas carry the design:

1. **The rig is data, the clips are code.** `rig/jet.json` holds poses as 60 numbers each (ten anchors, each a point with two handles). Every pose shares the same anchors, so any two poses blend. Each file in `ui/jet/clips/` writes keyframes from those poses using the dial values; nothing is a stored animation.
2. **The player blends from wherever Jet is.** `play()` puts the current state at the front of every track, so a new clip never cuts.
3. **Rust owns what must be true on every platform.** The rig ships inside the binary and is checked at start-up (it has the `circle` and `soft` poses and a rest colour, every pose has 60 numbers, every eye position belongs to a pose). A test, not start-up, holds the foot in place. Settings are read and written by Rust so the file format has one definition, with `serde(default)` so older files still load.

## Commands the window can call

The settings commands reject with a message string. The chat commands, from `agent_status` down, reject with `{ kind, message }`, where `kind` is `busy`, `claudeMissing`, `io` or `badLink`.

| Command | Takes | Returns | Notes |
| --- | --- | --- | --- |
| `rig` | nothing | the rig JSON as a string | the frontend parses it; one copy of the character |
| `load_settings` | nothing | `Settings` | defaults when no file exists yet |
| `save_settings` | `{ settings }` | nothing | |
| `agent_status` | nothing | where Claude Code is (`found`, `path`, `searched`), the data folder, whether a reply is running, and the prompt cache status | the page shows the missing-Claude banner and the cache chip from it |
| `load_history` | nothing | the last 200 entries of the transcript, ready to show | |
| `send_message` | `{ request, events }` | the saved user entry, at once | the reply streams over the `events` channel; fails with `busy` while a reply is running |
| `stop_reply` | nothing | nothing | ends the running reply and keeps the text so far |
| `forget_conversation` | nothing | nothing | the transcript is moved aside and the session is dropped; the notes stay; fails with `busy` while a reply is running |
| `load_memory` | nothing | the three notes and their length limits | |
| `save_memory` | `{ notes }` | the notes as saved, cut to their limits | the next message starts a fresh session so Claude sees them |
| `render_markdown` | `{ text }` | the text as HTML | the page asks while a reply streams |
| `open_link` | `{ url }` | nothing | opens `http`, `https` and `mailto` links in the user's own apps; any other scheme fails with `badLink` |

## Adding a clip

Write a `buildX(rig, params)` in `ui/jet/clips/`, next to `hello.js`. It makes two calls to `ui/jet/clip.js`. The first is `readDials(rig, params)`. It returns the dials as the numbers that a clip's formulas read, the circle pose, the rest colour, and the helpers `pose`, `eyes` and `hiddenEyes`, which already apply the shape and eyes dials. The second is `createClip(tempo)`, which the clip calls when it has worked out its tempo. It returns the empty clip, one writer for each track (`body`, `eye`, `colour`, `scale`, `ring`, `speed`) and `t()`, the time that the body has reached. Write `t()` with its brackets: the five writers that take a time throw when they are given a bare `t`, but `total` and the end of a phase are written by hand and nothing checks them. The new file then holds only its own choreography: its easing table, its tempo, its phases, its `info` and its readout rows (`onOff` gives the value of a row that is on or off). Set `total`, `phases`, `info` and `readout` on the clip and return it. `zoom.js` shows a clip that uses the ring (spin grooves) and the speed track (scenery), and `working.js` shows one that opens a loop over the pip. The player and the view need no changes.

Then list the clip in `ui/jet/clips/catalogue.js`. Every clip is listed there, with its label, its builder and whether it is a hold. The lab and the director both read that list. Give the clip a button in `ui/lab.html` and a step list in `BUTTONS` in `ui/lab/main.js` so it can be tried.

The director (`ui/jet/director.js`) decides which catalogue clip plays for each chat event, and which one plays for each mood word. To play the new clip for a mood, add it to the director's mood table. A new mood word must be added on both sides: `agent::Mood` in `crates/agent/src/chat.rs` and `MOODS` in `director.js`. The Rust test `every_mood_word_is_handled_by_the_director` fails until both agree.
