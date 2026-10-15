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
| `math` | the reply holds inline and display math, a dollar amount, a table of numbers and a code block |
| `fresh` | a new session starts, with a notice in the thread |
| `error` | the reply fails the way Claude Code does when it is not logged in |
| `missing` | the reply fails as if Claude Code was not installed |
| `timeout` | the reply fails with "Claude stopped responding after 2 minutes." |
| `quanty` | a recorded library search comes first: the call and what the library gave back reach the page as `toolStarted` and `toolFinished` events, and as the stream lines behind them, then the answer streams; the `started` event lists the servers of the `mcp` setting |

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
| `src/rig.rs` `airborne_poses_never_sink_below_the_ground` | a rolling, flying, falling or dangling pose never goes below the ground |
| `src/rig.rs` `wrong_pose_size_is_reported` | a pose with the wrong number of values is refused, with the number found |
| `src/settings.rs` `missing_file_means_defaults` | no settings file yet gives the defaults |
| `src/settings.rs` `settings_survive_a_round_trip` | what is saved is what is loaded, including the page shown last, written as the word `workstation` |
| `src/settings.rs` `new_fields_round_trip` | the persona, body colour, model, the five thinking levels (xhigh and max included), the MCP servers, the workstation and the other chat fields are saved and loaded |
| `src/settings.rs` `old_files_with_missing_fields_still_load` | an older file gets defaults for the fields it lacks, and keeps what it saved: a 1.00 budget stays 1.00 although the default is now 10.00; the MCP servers come back as the defaults |
| `src/settings.rs` `broken_file_names_the_path` | a file that cannot be read fails with its path in the message |
| `src/settings.rs` `default_settings_match_the_ui_fixture` | `ui/bridge/default-settings.json` is exactly the defaults Rust writes |
| `src/settings.rs` `json_uses_camel_case_for_the_frontend` | the page reads `reducedMotion`, not `reduced_motion` |
| `src/chat/error.rs` `bridge_error_serialises_as_kind_and_message` | every command error reaches the page as `{ kind, message }` |
| `src/chat/mod.rs` `every_mood_word_is_handled_by_the_director` | the words of `agent::Mood` and `MOODS` in `ui/jet/director.js` are the same set |
| `../agent/src/markdown/mod.rs` `math_and_tables_match_the_shared_vectors` | the app's renderer gives the html of every case in `ui/bridge/fixtures/math-vectors.json`: math in prose, display math, money, delimiters that open nothing, code, lists, number columns; and never writes a `style` attribute |
| `rig/poses.rs` `generator_prints_the_committed_rig` | the generator prints exactly `rig/jet.json` |
| `ui/bridge/fake-agent.test.mjs` | a reply's events in order with one `message_start`, climbing `message_delta` lines and a result with timing fields; `finished` carries output tokens, thinking tokens and the model; a fresh session, the three failures, stop, and what the storage keeps; the `quanty` word replays the recorded library search as tool events before the answer |
| `ui/bridge/markdown.test.mjs` | the browser fallback gives the same html as the app's renderer for every shared case, with no `style` attribute |
| `ui/bridge/settings.test.mjs` | the defaults carry the chat fields; merge fills gaps from them; `defaults_match_the_rust_fixture`: the page's defaults are exactly `ui/bridge/default-settings.json` |
| `ui/bridge/tauri-agent.test.mjs` | with Tauri each agent method calls its command with the right argument keys and failures reach the page as `{ kind, message }`; without Tauri the pretend agent is used |
| `ui/chat/composer/state.test.mjs` | centred until the first send, Send becomes Stop, Enter and Escape |
| `ui/chat/drawer/cache.test.mjs` | the cache chip is warm until the TTL ends, then cold with the tokens to re-read |
| `ui/chat/drawer/caption.test.mjs` | the gear caption reads the model word and the thinking level |
| `ui/chat/drawer/format.test.mjs` | counts group thousands with commas and shorten from 10 000 up, a dash for a time or a turn count not known yet; spend reads reported, est., no rate or a dash; the model line is the short name and the thinking level |
| `ui/chat/drawer/log.test.mjs` | the log keeps the last 500 lines, tags each by type and pretty-prints JSON |
| `ui/chat/drawer/rates.test.mjs` | the recorded Sonnet turn costs 0.007334 at list price; Haiku 5.5 moves to its long-prompt prices at 100 000 prompt tokens; a model with no price has no estimate |
| `ui/chat/drawer/usage.test.mjs` | the recorded Sonnet turn read line by line (live counts, then the reported cost and timings, then the totals); a second reply at another thinking level gets its own row; a stopped reply keeps its tokens; stray lines change nothing |
| `ui/chat/page-state.test.mjs` | the page switches between the chat and the workstation, and a page already shown or not known changes nothing; Esc closes the sheet first, then takes the workstation back to the chat, then is left to the composer; the page shown last is saved and opens again, and an unknown saved page opens the chat; a wide drawer becomes the rail beside the workstation and is docked as the user left it on the chat, and a narrow drawer is the overlay on both pages |
| `ui/chat/settings/form.test.mjs` | hex and rgb both ways, code-point counts, the master moves only the channels that follow it |
| `ui/chat/stage/flight.test.mjs` | the flight holds, lands on the slot, turns toward travel (never more than 25°) and mirrors going left; a flight profile it cannot fly fails, a clip name and an inherited name too; the cruise grows with distance; every profile closes the gap without turning back and lands, and the drop and the abseil never turn or mirror; the drop speeds up until 40% and then slows; the abseil hangs at three heights |
| `ui/chat/thread/math.test.mjs` | a formula is drawn once per mode and the newest are kept; each is labelled for screen readers; a formula KaTeX cannot read keeps its TeX and is tried again; KaTeX's drawings reach the page with no `style` attribute and keep their width |
| `ui/chat/thread/scroll.test.mjs` | the thread follows within 80 px of the bottom, and a send always follows |
| `ui/chat/thread/store.test.mjs` | grouping and day pills, the slot's life from waiting to its end, the held message |
| `ui/chat/thread/throttle.test.mjs` | markdown renders at most every 50 ms with a trailing call; the first reveal waits for the mood |
| `ui/jet/clip.test.mjs` | a time writer refuses a bare `t`; a face is drawn in the ground colour (tint 0) and hidden eyes are faint (tint 1) |
| `ui/jet/clips/abseil.test.mjs` | the rope comes down in the launch and stays through the cruise, Jet kicks off three times, the rope whips up and fades on landing; no ground speed or grooves |
| `ui/jet/clips/annoyed.test.mjs` | a centred or deferential Jet never glares, tints or narrows its eyes |
| `ui/jet/clips/antics.test.mjs` | the ball lands on the bat every 520 ms with the bat in the right hand, the body gives after each landing, and a continued loop carries on from the landing; a deferential Jet swings the bat less; the doze closes faint eyes to slits, sways 3% and holds still under reduced motion |
| `ui/jet/clips/catalogue.test.mjs` | in every clip: tracks run forward, shape 0 and eyes 0 hold, any interruption comes to rest with both props hidden; no prop shows at shape 0, below motion 3 or under reduced motion, and every prop a clip names is a known kind |
| `ui/jet/clips/drop.test.mjs` | the umbrella opens 40% into the cruise, pops past its size, stays above the head and folds in the brake; the face holds still while Jet falls, and only above eyes 6; no ground speed or grooves |
| `ui/jet/clips/hello.test.mjs` | tracks run forward, ends at the circle, each dial does its job, the brief hello |
| `ui/jet/clips/send-reactions.test.mjs` | every send reaction is over within 350 ms (the blink within 300) with a body key in each phase; the salute reaches higher when candid and bows when deferential; the blink shuts a face in ink twice, and holds it open under reduced motion; the nod and the hop keep faint eyes the size they are at rest, riding the body |
| `ui/jet/clips/lean.test.mjs` | the peer stands taller and narrower with faint narrowed eyes; the held creep stays wider and taller than the lean, with its foot planted |
| `ui/jet/clips/working.test.mjs` | the loop opens top right, spins clockwise, slows after 8 s, continues, and closes after its turn |
| `ui/jet/clips/zoom.test.mjs` | the ground moves only mid-cruise, the host sets the cruise, the dials and reduced motion, a hello after a zoom; the drop and the abseil take the zoom's phases and time |
| `ui/jet/director.test.mjs` | send, zoom and loop, with the zoom's own timing, the roll profile and the random the director was given; a send reaction plays before the travel and the take-off waits for it; a mood during it plays after the travel, and a stop drops the travel; a serious Jet skips the blink; quick reply; mood; done waits; stop; typing; unknown mood; reduced motion; typing picks a typing hold with the random; a stall plays an antic only when idle or leaning, and typing, an empty field, a send, a hello or reduced motion ends it; the drop and the abseil only for a move mostly straight down; a drop keeps its own timing and the loop follows it |
| `ui/jet/easing.test.mjs` | `cubicBezier` pins both ends |
| `ui/jet/maths.test.mjs` | `lerp` blends and may run past 1 |
| `ui/jet/player.test.mjs` | a clip starts from the live state and ends at rest; at rest the circle opens faint eyes, a hold keeps its own and eyes below 1.5 show none; the faint eyes blink on a random gap of 4 to 9 s and never under reduced motion; breathing of 1.8%; a clip's props play with it and a clip with no prop track fades them within 200 ms |
| `ui/jet/rig.test.mjs` | `pathFrom` writes one closed path |
| `ui/jet/view.test.mjs` | an eye blends from the ground colour to a light tint of the body, and six eye numbers draw as before; each kind of prop draws where its track puts it, as faint as the spin grooves, and hides at opacity 0; no inline styles |
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
    ├── index.html                  the chat page: header, drawer, thread, composer, the workstation page, settings dialog
    ├── chat.css                    the chat page's tokens, layout and header
    ├── lab.html                    the lab page: Jet, a button for every clip, and the dials
    ├── styles.css                  the lab's look, and the ground colour of Jet's eyes and ring
    ├── package.json                the `node --test` script, nothing to install
    ├── assets/
    │   └── tile.png                the pattern behind the thread
    ├── bridge/                     the pages' way to the Rust side, with browser fallbacks
    │   ├── rig.js                  loadRig: the rig from Rust, or rig/jet.json in a browser
    │   ├── settings.js             the Settings shape, defaults, behaviour presets, merge, load and save
    │   ├── settings.test.mjs       the defaults carry the chat fields; merge fills gaps from them; the defaults equal the Rust fixture
    │   ├── default-settings.json   the defaults as Rust writes them, read by a test on each side so the two cannot drift
    │   ├── agent.js                connectAgent: the one way to talk to Claude, and the types of its events
    │   ├── tauri-agent.js          the real agent: each method calls a Rust command, and a reply streams back over a channel
    │   ├── tauri-agent.test.mjs    each method calls its command with the right keys; failures arrive as { kind, message }
    │   ├── fake-agent.js           the pretend Claude the chat runs on in a browser
    │   ├── fake-agent.test.mjs     a reply's events in order incl. the live stream lines and usage, a fresh session, the three failures, stop, storage
    │   ├── fake-script.js          what the pretend Claude says and the stream lines it writes: message_start, message_delta, tool use and tool result, a result with timing fields, real model ids
    │   ├── fixtures/
    │   │   ├── math-vectors.json   the cases both Markdown renderers must agree on, run by a test on each side
    │   │   └── quanty-search.js    a real quanty search recorded from Claude Code: the call, what the library gave back and the answer, which the pretend agent replays
    │   ├── markdown.js             a small, safe Markdown renderer for the browser fallback, with math and tables
    │   └── markdown.test.mjs       the shared math and table cases, with no style attribute
    ├── chat/                       the chat page
    │   ├── main.js                 boot: loads the rig, settings and history, builds every part, hands each its parts
    │   ├── turn.js                 one turn: a send, each event of the reply, the end of the reply
    │   ├── clock.js                how the page writes times and days
    │   ├── dom.js                  helpers that build elements without markup strings
    │   ├── page-state.js           which page shows, what Esc does first, and how the drawer looks beside each page (pure)
    │   ├── page-state.test.mjs     the page switch, the Esc order, the saved page, the rail and the docked drawer
    │   ├── stage/                  the live Jet
    │   │   ├── live.js             the live Jet node, the director host, lane placement, the frame loop
    │   │   ├── flight.js           the path of Jet from where it stood to the new lane: a roll, a drop, or an abseil in three steps (pure)
    │   │   ├── flight.test.mjs     the flight holds, lands, turns (capped at 25°) and mirrors; an unknown profile fails; the cruise grows with distance; every profile lands; the drop's speed-up and the abseil's three heights
    │   │   └── stage.css           the empty state, the hero spot and the live Jet's place in a lane
    │   ├── thread/                 the conversation
    │   │   ├── store.js            messages, notices, the running reply and the held message, as rows (pure)
    │   │   ├── store.test.mjs      grouping and pills; the slot's life; the held message
    │   │   ├── view.js             draws the rows: bubbles, lanes, dots, code blocks, links
    │   │   ├── math.js             draws the formulas of a reply with KaTeX, keeps each drawing, moves KaTeX's style attributes onto the element
    │   │   ├── math.test.mjs       once per mode, the newest kept, labelled; a bad formula is tried again; no style attribute
    │   │   ├── scroll.js           when the thread follows new text (pure)
    │   │   ├── scroll.test.mjs     follows within 80 px of the bottom; a send always follows
    │   │   ├── throttle.js         when streamed text becomes HTML: at most every 50 ms, stale answers dropped
    │   │   ├── throttle.test.mjs   the 50 ms rule with a trailing call; the first reveal waits for the mood
    │   │   └── thread.css          rows, bubbles, lanes, pills and the Markdown inside bubbles
    │   ├── composer/               the field and the Send/Stop button
    │   │   ├── state.js            the composer's rules: where it sits, the button, Enter, Escape (pure)
    │   │   ├── state.test.mjs      centred until the first send; Send becomes Stop; Enter and Escape
    │   │   ├── view.js             the field, the button, the held chip, and the hop to the bottom
    │   │   └── composer.css        the composer's look
    │   ├── drawer/                 the side panel
    │   │   ├── view.js             the static Jet and name, the cache chip, the usage panel, the stream log (it folds away), the gear
    │   │   ├── usage.js            tokens, time and spend of the replies since the app started, read from the stream lines and the finished event (pure)
    │   │   ├── usage.test.mjs      the recorded Sonnet turn line by line; a second row per thinking level; a stop keeps its tokens; stray lines change nothing
    │   │   ├── rates.js            the list prices and their date, the estimate they give, and the model names (pure)
    │   │   ├── rates.test.mjs      the recorded turn costs 0.007334; Haiku 5.5's tier edge; an unknown model has no estimate
    │   │   ├── caption.js          the words under the gear, such as "Sonnet · medium" (pure)
    │   │   ├── caption.test.mjs    the model word and the thinking level
    │   │   ├── format.js           how the usage panel writes its numbers and words, with a dash for a value not known yet (pure)
    │   │   ├── format.test.mjs     counts, dollars, seconds and turns; the four spend wordings; the model line
    │   │   ├── log.js              the last 500 raw stream lines, tagged, ready to pretty-print (pure)
    │   │   ├── log.test.mjs        the 500 cap, the tags, the pretty-print
    │   │   ├── cache.js            warm or cold wording for the cache chip (pure)
    │   │   ├── cache.test.mjs      warm until the TTL ends, then cold with the tokens to re-read
    │   │   ├── drawer.css          docked beside the thread on wide screens, over it on narrow ones
    │   │   └── rail.css            the rail beside the workstation, and the Jet and workstation buttons
    │   └── settings/               the settings sheet
    │       ├── sheet.js            the dialog and its ten sections; saves after the last edit
    │       ├── controls.js         the few form controls the sections are made of
    │       ├── persona.js          who Jet is: name, job title, how to talk
    │       ├── look.js             body colour, behaviour presets, expressiveness, reduced motion
    │       ├── model.js            model, five thinking levels, the budget for one turn, usage since the app started
    │       ├── memory.js           the three notes as editors
    │       ├── workstation.js      where polysim-bridge and the polysim folder are, the strategy, the engine links and their token
    │       ├── claude.js           where Claude Code is, and Forget this conversation
    │       ├── form.js             colour and counter arithmetic, the master's rules (pure)
    │       ├── form.test.mjs       hex and rgb both ways; code-point counts; the master moves its followers
    │       └── sheet.css           the sheet's look
    ├── jet/                        the engine
    │   ├── rig.js                  the rig as the page sees it; turns a pose into an SVG path
    │   ├── rig.test.mjs            pathFrom writes one closed path
    │   ├── state.js                Jet at one moment: the seven tracks, the ring's and the props' numbers, colour
    │   ├── track.js                keyframe tracks and how to sample one
    │   ├── track.test.mjs          the sampler holds the ends and applies the easing
    │   ├── easing.js               cubic-bezier, same numbers as CSS
    │   ├── easing.test.mjs         cubicBezier pins both ends
    │   ├── maths.js                lerp and clamp
    │   ├── maths.test.mjs          lerp blends and may run past 1
    │   ├── clip.js                 what a clip is, and how the dials reach one (readDials, createClip, onOff)
    │   ├── clip.test.mjs           a time writer refuses a bare t; faces in the ground colour, hidden eyes faint
    │   ├── clips/                  one file per clip
    │   │   ├── catalogue.js        the one list of every clip: label, builder, whether it is a hold
    │   │   ├── catalogue.test.mjs  in every clip: tracks run forward, shape 0 and eyes 0 hold, any interruption comes to rest; props hidden at the end and under the low dials
    │   │   ├── beats.js            the beats the mood clips share: stand up, melt back, the dials they read
    │   │   ├── hello.js            stand up, wave, melt
    │   │   ├── hello.test.mjs      tracks run forward, ends at the circle, each dial does its job
    │   │   ├── send-reactions.js   the short clips as a message goes out: salute, nod, blink, hop
    │   │   ├── send-reactions.test.mjs  each within 350 ms with a beat per phase; the salute's reach and bow; the double blink; faint eyes on the nod and the hop
    │   │   ├── zoom.js             wind up, roll past the scenery, brake; the timing every travel shares
    │   │   ├── zoom.test.mjs       the ground moves only mid-cruise; a hello after a zoom stops it; the drop and the abseil keep its time
    │   │   ├── drop.js             crouch, fall, an umbrella pops open, land as it folds
    │   │   ├── drop.test.mjs       the umbrella opens 40% into the cruise above the head and folds in the brake
    │   │   ├── abseil.js           a rope comes down, three kicks on the way down, the rope whips away
    │   │   ├── abseil.test.mjs     the rope down in the launch, three kicks, the whip on landing
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
    │   │   ├── lean.js             the lean, the peer and the creep while the user types, and the lean back (holds)
    │   │   ├── lean.test.mjs       the peer is taller and narrower; the held creep stays bigger than the lean
    │   │   ├── antics.js           bat and ball, and the doze, while the user stalls; and the clips that end them (holds)
    │   │   └── antics.test.mjs     the ball lands on the bat on the beat; a deferential Jet swings less; the doze's slits and sway
    │   ├── director.js             chooses and orders clips for each chat event; the MOODS list
    │   ├── director.test.mjs       send, zoom (its timing, profile and random) and loop; a send reaction before the travel, a mood or a stop during it, no blink when serious; quick reply; mood; done waits; stop; typing; unknown mood; reduced motion; typing holds; stalls and antics; the drop and the abseil only straight down
    │   ├── player.js               owns Jet's state, plays clips from wherever Jet is; breathes and blinks faint eyes at rest; no DOM
    │   ├── player.test.mjs         a clip starts from the live state and ends at rest; faint eyes and their blink; breathing; props fade with their clip
    │   ├── view.js                 draws a state into an SVG: props, body, ring, eyes with their tint; the only code that draws Jet
    │   ├── view.test.mjs           the eye tint in two layers and six numbers as before; each prop kind draws and hides
    │   └── scene.js                scenery in its own SVG layers, scrolled by the speed track; not part of Jet
    ├── vendor/
    │   └── katex/                  KaTeX 0.16.47 (MIT), copied unchanged from npm: katex.mjs, katex.min.css, fonts/ (20 .woff2), LICENSE and VERSION
    ├── lab/                        the controls around Jet
    │   ├── main.js                 boot, frame loop, a step list for each button, replay-on-change, save-on-change
    │   ├── wheel.js                behaviour wheel, presets, axis sliders
    │   ├── dial.js                 expressiveness dial and the four channels
    │   └── readout.js              what the dials turned into, progress bar
    └── workstation/                the workstation page as the chat window shows it
        ├── shell.js                its header, the setup card and the workstation itself, built and its feed started the first time the page opens; the feed is paused while the chat shows
        └── shell.css               the chat's header, thread and composer step aside; the page's header, link chip and setup card
```

Three ideas carry the design:

1. **The rig is data, the clips are code.** `rig/jet.json` holds poses as 60 numbers each (ten anchors, each a point with two handles). Every pose shares the same anchors, so any two poses blend. Each file in `ui/jet/clips/` writes keyframes from those poses using the dial values; nothing is a stored animation.
2. **The player blends from wherever Jet is.** `play()` puts the current state at the front of every track, so a new clip never cuts.
3. **Rust owns what must be true on every platform.** The rig ships inside the binary and is checked at start-up (it has the `circle` and `soft` poses and a rest colour, every pose has 60 numbers, every eye position belongs to a pose). A test, not start-up, holds the foot in place. Settings are read and written by Rust so the file format has one definition, with `serde(default)` so older files still load.

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
- **Tables.** A column whose body cells are all numbers (`100`, `-0.25`, `$5`, `5%`, `1,200.50`) gets `class="num"` on its header and its cells, and is right-aligned. A table never carries a `style` attribute. Markdown alignment colons are accepted and ignored.
- **One set of cases.** `ui/bridge/fixtures/math-vectors.json` holds the cases both renderers must give the same html for. The Rust test and the node test both run it.
- **KaTeX.** KaTeX 0.16.47 (MIT) is vendored in `ui/vendor/katex/`: `katex.mjs`, `katex.min.css`, the 20 `.woff2` fonts and the licence, copied unchanged from the npm tarball. `VERSION` there has the tarball address and its checksum. The page's security policy blocks `style` attributes, and KaTeX writes a few of them itself (the arrow over a vector, tall braces), so `math.js` builds KaTeX's tree through the DOM and moves those styles onto the element's style object, which the policy allows.

To upgrade KaTeX: download the new tarball from the npm registry, check its sha512 against the registry's `dist.integrity` and its `version`, copy the same files byte for byte, and update `VERSION`. Then check that `katex.__renderToDomTree` still exists (it is not a public API) and that `ui/chat/thread/math.test.mjs` still passes.

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
| `render_markdown` | `{ text }` | the text as HTML | the page asks while a reply streams; math comes back as `.math` elements for the page to typeset |
| `open_link` | `{ url }` | nothing | opens `http`, `https` and `mailto` links in the user's own apps; any other scheme fails with `badLink` |

## Libraries over MCP

Jet's Claude reaches two libraries through MCP servers: quanty, the user's library of quantitative finance books, and polysim, which runs the trading engines. The `mcp` settings key holds one entry for each, `{ enabled, command, cwd }`. The defaults point at this machine's quanty and polysim checkouts, which suits a single-user desktop app for now. The page sends the key with every message.

How a reply reaches them:

- The enabled servers go inline as `--mcp-config` JSON. It is built from the settings alone, so it is the same bytes every turn and Claude's prompt cache keeps hitting. Each server starts through `/bin/sh` in its own folder, because Claude Code ignores a `cwd` in the config, and has a 300 second timeout.
- `--tools ToolSearch` keeps the tool descriptions out of the prompt: Claude loads one when it needs it.
- `--allowedTools` names every tool exactly, so a tool a server adds later stays off, and so does polysim's `set_execution_mode`: an engine's mode changes only from the UI.
- `--safe-mode` is gone because it drops MCP servers. `--setting-sources '' --disable-slash-commands` and the variables `CLAUDE_CODE_DISABLE_CLAUDE_MDS` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY` do the rest of its job: no CLAUDE.md, no Claude Code memory, no user settings or commands. The notes review keeps the same isolation and gets no servers.
- Claude Code starts the servers for each reply and closes them when it ends. An engine polysim started, or a quanty ingest, stops with the reply, and the persona tells Jet so.

What the page gets:

- `started` carries `mcp`: each server and its state. Only `failed` means offline; `pending` is still starting.
- `toolStarted` when Claude has written a call (`id`, `server`, `tool`, `input`) and `toolFinished` when it comes back (`ok`, `result`, a one-line `summary` such as `quanty · search · 5 results`, and `durationMs`). Only MCP tools make events; Claude Code's own ToolSearch stays in the raw log. A call still running when the reply ends gets no `toolFinished`.
- The saved entry keeps its finished calls in `tools`. Entries without calls look as they did before.
- While a call runs, Claude may stay silent three times as long as usual, so a reply times out after 6 minutes of silence then.
- The text of separate calls to the model is joined with a blank line.

The recording `crates/agent/tests/fixtures/quanty-search-reply.jsonl` is a real reply to "what is vega?". These tests of the agent crate cover the feature: `turn::stream::tests::parses_the_recorded_quanty_search`, `turn::tools::tests::calls_are_paired_summed_up_and_set_apart_from_text`, `turn::claude::args::tests::chat_and_review_args_are_exact_without_safe_mode_which_drops_mcp_servers`, `chat::tests::event_json_matches_the_ui_contract`, the two persona tests `the_prompt_teaches_the_libraries` and `the_fingerprint_of_the_defaults_is_pinned`, and the contract test `a_recorded_quanty_search_reaches_the_page_and_the_thread`, which runs the recording through `fake-claude`, `Conversation` and the saved thread.

## Adding a clip

Write a `buildX(rig, params)` in `ui/jet/clips/`, next to `hello.js`. It makes two calls to `ui/jet/clip.js`. The first is `readDials(rig, params)`. It returns the dials as the numbers that a clip's formulas read, the circle pose, the rest colour, and the helpers `pose`, `eyes` and `hiddenEyes`, which already apply the shape and eyes dials. The second is `createClip(tempo)`, which the clip calls when it has worked out its tempo. It returns the empty clip, one writer for each track (`body`, `eye`, `colour`, `scale`, `ring`, `speed`, `prop`) and `t()`, the time that the body has reached. Write `t()` with its brackets: the six writers that take a time throw when they are given a bare `t`, but `total` and the end of a phase are written by hand and nothing checks them. The new file then holds only its own choreography: its easing table, its tempo, its phases, its `info` and its readout rows (`onOff` gives the value of a row that is on or off). Set `total`, `phases`, `info` and `readout` on the clip and return it. `zoom.js` shows a clip that uses the ring (spin grooves) and the speed track (scenery), and `working.js` shows one that opens a loop over the pip. A clip that shows a prop sets `clip.props` to the kind of each slot, and must hide both by its end unless it is a hold. The player and the view need no changes, unless the clip needs a new kind of prop: that needs a shape in `ui/jet/view.js` and a name in `PROP_KINDS` in `ui/jet/state.js`.

Then list the clip in `ui/jet/clips/catalogue.js`. Every clip is listed there, with its label, its builder and whether it is a hold. The lab and the director both read that list. Give the clip a button in `ui/lab.html` and a step list in `BUTTONS` in `ui/lab/main.js` so it can be tried.

The director (`ui/jet/director.js`) decides which catalogue clip plays for each chat event, and which one plays for each mood word. To play the new clip for a mood, add it to the director's mood table. A new mood word must be added on both sides: `agent::Mood` in `crates/agent/src/chat/mod.rs` and `MOODS` in `director.js`. The Rust test `every_mood_word_is_handled_by_the_director` fails until both agree.
