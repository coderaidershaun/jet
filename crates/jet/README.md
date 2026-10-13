# jet

Jet is the first-mate character: a circle that stands up, waves, spins while it works and melts back. This crate is Jet's desktop home, a Tauri 2 window around a small animation player.

## Run it

```sh
cargo install tauri-cli --version "^2" --locked   # once
cd crates/jet
cargo tauri dev
```

Tests:

```sh
cargo test -p jet                 # rig checks, settings file round-trips
node --test                       # from crates/jet/ui: clip builder, sampler, player
```

The frontend is plain ES modules with no bundler, so there is nothing to install for `ui/`. Tauri serves the folder as-is (`build.frontendDist` in `tauri.conf.json`). A development server and a bundler can be added later without moving any file.

Before adding a pose, a clip or a state, read `character-policy.md`. It says how Jet is meant to move and why the rig is built the way it is.

## Where things live

```
crates/jet
├── character-policy.md   how to animate Jet; read first
├── rig
│   ├── poses.py       generates rig/jet.json; poses are constructed, not drawn
│   └── jet.json       the rig: 15 poses × 10 anchors, eye positions, palette
├── src
│   ├── main.rs        desktop entry point
│   ├── lib.rs         opens the window, registers the commands
│   ├── rig.rs         the character definition, embedded and checked at start-up
│   └── settings.rs    remembers the dials between launches (app config folder)
├── ui
│   ├── index.html     the lab page
│   ├── styles.css
│   ├── jet/           the engine
│   │   ├── rig.js     the rig as the page sees it; turns a pose into an SVG path
│   │   ├── state.js   Jet at one moment: the six tracks, the ring's numbers, colour
│   │   ├── track.js   keyframe tracks and how to sample one
│   │   ├── easing.js  cubic-bezier, same numbers as CSS
│   │   ├── maths.js   lerp and clamp
│   │   ├── clip.js    what a clip is
│   │   ├── clips/     one file per clip: hello.js, zoom.js
│   │   ├── player.js  owns Jet's state, plays clips from wherever Jet is
│   │   ├── view.js    draws a state into an SVG: body, ring, eyes
│   │   └── scene.js   scenery that scrolls by the speed track; not part of Jet
│   └── lab/           the controls around Jet
│       ├── main.js    boot, frame loop, replay-on-change, save-on-change
│       ├── wheel.js   behaviour wheel, presets, axis sliders
│       ├── dial.js    expressiveness dial and the four channels
│       ├── readout.js what the dials turned into, progress bar
│       ├── settings.js the Settings shape and its defaults
│       └── bridge.js  the way to the Rust side (rig, load/save settings), with browser fallbacks
├── capabilities/      what the window may ask of the Rust side
├── icons/             generated from the rig's standing pose
└── tauri.conf.json
```

Three ideas carry the design:

1. **The rig is data, the clips are code.** `rig/jet.json` holds poses as 60 numbers each (ten anchors, each a point with two handles). Every pose shares the same anchors, so any two poses blend. `ui/jet/clips/hello.js` writes keyframes from those poses using the dial values; nothing is a stored animation.
2. **The player blends from wherever Jet is.** `play()` puts the current state at the front of every track, so a new clip never cuts.
3. **Rust owns what must be true on every platform.** The rig ships inside the binary and is checked at start-up (every pose has 60 numbers, the foot never moves). Settings are read and written by Rust so the file format has one definition, with `serde(default)` so older files still load.

## Commands the window can call

| Command | Returns | Notes |
| --- | --- | --- |
| `rig` | the rig JSON as a string | the frontend parses it; one copy of the character |
| `load_settings` | `Settings` | defaults when no file exists yet |
| `save_settings` | nothing | takes `{ settings }` |

## Adding a clip

Write a `buildX(rig, params)` in `ui/jet/clips/`, next to `hello.js`. It makes two calls to `ui/jet/clip.js`. The first is `readDials(rig, params)`. It returns the dials as the numbers that a clip's formulas read, the circle pose, the rest colour, and the helpers `pose`, `eyes` and `hiddenEyes`, which already apply the shape and eyes dials. The second is `createClip(tempo)`, which the clip calls when it has worked out its tempo. It returns the empty clip, one writer for each track (`body`, `eye`, `colour`, `scale`, `ring`, `speed`) and `t()`, the time that the body has reached. Write `t()` with its brackets: a writer throws when it is given a bare `t`, but `total` and the end of a phase are written by hand and nothing checks them. The new file then holds only its own choreography: its easing table, its tempo, its phases, its `info` and its readout rows (`onOff` gives the value of a row that is on or off). Set `total`, `phases`, `info` and `readout` on the clip and return it. `zoom.js` shows a clip that uses the ring (spin grooves) and the speed track (scenery). The player and the view need no changes. The spinning loop for "working" is the next one: the same ring element in the body colour, with the disc opening into a loop.
