# jet

Jet is the first-mate character: a circle that stands up, waves, spins while it works and melts back. This crate is Jet's desktop home, a Tauri 2 window around a small animation player. `CONTEXT.md` holds the words this crate uses, and `character-policy.md` holds the rules for how Jet looks and moves.

## Run it

```sh
cargo install tauri-cli --version "^2" --locked   # once
cd crates/jet
cargo tauri dev
```

Tests:

```sh
cargo test -p jet                 # rig is complete, foot planted, airborne poses above ground
                                  # settings file: defaults, round trip, old files, broken file
                                  # generator prints exactly rig/jet.json
node --test                       # from crates/jet/ui: hello and zoom clips, time writers,
                                  # player, track sampler, easing, maths, pathFrom
```

The frontend is plain ES modules with no bundler, so there is nothing to install for `ui/`. Tauri serves the folder as-is (`build.frontendDist` in `tauri.conf.json`). A development server and a bundler can be added later without moving any file.

Before adding a pose, a clip or a status, read `character-policy.md`. It says how Jet is meant to move and why the rig is built the way it is.

## Where things live

```
crates/jet
├── README.md             this file
├── CONTEXT.md            the words this crate uses, each with one meaning
├── character-policy.md   how to animate Jet; read first
├── AGENTS.md             how an agent prints the codebase map
├── Cargo.toml            the library, the binary and the poses example
├── build.rs              the Tauri build step
├── rig
│   ├── poses.rs       prints rig/jet.json; poses are constructed, not drawn
│   │                  run from crates/jet: cargo run -p jet --example poses > rig/jet.json
│   │                  cargo test fails when the generator and the file differ
│   └── jet.json       the rig: 20 poses × 10 anchors, eye positions, palette
├── src
│   ├── main.rs        desktop entry point
│   ├── lib.rs         checks the rig, opens the window, registers the commands
│   ├── rig.rs         the character definition, embedded and checked at start-up
│   └── settings.rs    remembers the dials between launches (app config folder)
├── ui
│   ├── index.html     the lab page
│   ├── styles.css     the lab's look, and the ground colour of Jet's eyes and ring
│   ├── package.json   the `node --test` script, nothing to install
│   ├── jet/           the engine
│   │   ├── rig.js              the rig as the page sees it; turns a pose into an SVG path
│   │   ├── rig.test.mjs        pathFrom writes one closed path
│   │   ├── state.js            Jet at one moment: the six tracks, the ring's numbers, colour
│   │   ├── track.js            keyframe tracks and how to sample one
│   │   ├── track.test.mjs      the sampler holds the ends and applies the easing
│   │   ├── easing.js           cubic-bezier, same numbers as CSS
│   │   ├── easing.test.mjs     cubicBezier pins both ends
│   │   ├── maths.js            lerp and clamp
│   │   ├── maths.test.mjs      lerp blends and may run past 1
│   │   ├── clip.js             what a clip is, and how the dials reach one (readDials, createClip, onOff)
│   │   ├── clip.test.mjs       a time writer refuses a bare t
│   │   ├── clips/              one file per clip
│   │   │   ├── hello.js        stand up, wave, melt
│   │   │   ├── hello.test.mjs  tracks run forward, ends at the circle, each dial does its job
│   │   │   ├── zoom.js         wind up, roll past the scenery, brake
│   │   │   └── zoom.test.mjs   the ground moves only mid-cruise; a hello after a zoom stops it
│   │   ├── player.js           owns Jet's state, plays clips from wherever Jet is; no DOM
│   │   ├── player.test.mjs     a clip starts from the live state and ends at rest
│   │   ├── view.js             draws a state into an SVG: body, ring, eyes; the only code that draws Jet
│   │   └── scene.js            scenery in its own SVG layers, scrolled by the speed track; not part of Jet
│   └── lab/           the controls around Jet
│       ├── main.js    boot, frame loop, replay-on-change, save-on-change
│       ├── wheel.js   behaviour wheel, presets, axis sliders
│       ├── dial.js    expressiveness dial and the four channels
│       ├── readout.js what the dials turned into, progress bar
│       ├── settings.js the Settings shape and its defaults
│       └── bridge.js  the way to the Rust side (rig, load/save settings), with browser fallbacks
├── capabilities
│   └── default.json   what the window may ask of the Rust side
├── icons/             generated from the rig's standing pose
└── tauri.conf.json    window, security policy, bundling
```

Three ideas carry the design:

1. **The rig is data, the clips are code.** `rig/jet.json` holds poses as 60 numbers each (ten anchors, each a point with two handles). Every pose shares the same anchors, so any two poses blend. `ui/jet/clips/hello.js` writes keyframes from those poses using the dial values; nothing is a stored animation.
2. **The player blends from wherever Jet is.** `play()` puts the current state at the front of every track, so a new clip never cuts.
3. **Rust owns what must be true on every platform.** The rig ships inside the binary and is checked at start-up (it has the `circle` and `soft` poses and a rest colour, every pose has 60 numbers, every eye position belongs to a pose). A test, not start-up, holds the foot in place. Settings are read and written by Rust so the file format has one definition, with `serde(default)` so older files still load.

## Commands the window can call

| Command | Returns | Notes |
| --- | --- | --- |
| `rig` | the rig JSON as a string | the frontend parses it; one copy of the character |
| `load_settings` | `Settings` | defaults when no file exists yet |
| `save_settings` | nothing | takes `{ settings }` |

## Adding a clip

Write a `buildX(rig, params)` in `ui/jet/clips/`, next to `hello.js`. It makes two calls to `ui/jet/clip.js`. The first is `readDials(rig, params)`. It returns the dials as the numbers that a clip's formulas read, the circle pose, the rest colour, and the helpers `pose`, `eyes` and `hiddenEyes`, which already apply the shape and eyes dials. The second is `createClip(tempo)`, which the clip calls when it has worked out its tempo. It returns the empty clip, one writer for each track (`body`, `eye`, `colour`, `scale`, `ring`, `speed`) and `t()`, the time that the body has reached. Write `t()` with its brackets: the five writers that take a time throw when they are given a bare `t`, but `total` and the end of a phase are written by hand and nothing checks them. The new file then holds only its own choreography: its easing table, its tempo, its phases, its `info` and its readout rows (`onOff` gives the value of a row that is on or off). Set `total`, `phases`, `info` and `readout` on the clip and return it. `zoom.js` shows a clip that uses the ring (spin grooves) and the speed track (scenery). The player and the view need no changes. The spinning loop for "working" is the next one: the same ring element in the body colour, with the disc opening into a loop.
