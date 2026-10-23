# Character policy: Jet the kite

Read this before changing `ui/jet/` or adding an emotion. [CONTEXT.md](CONTEXT.md) defines the vocabulary; [README.md](README.md) covers the host, commands and checks.

## What Jet is

Jet is a small blue kite with round eyes at rest, a bow at its bottom tip and a pale string. Its body, eyes and string move together as one character. The string is also a limb: it can hang, lie on the floor or write an authored gesture.

Jet stands beside its last reply with the string lying left, away from the bubble. On a send it lifts off, flies to the new reply's lane and hovers while reacting, waiting or streaming. It settles after the reply ends. In the empty page's hero spot it hovers and waves. The drawer uses a static standing kite with round eyes and a lying string; the desktop icon uses the standing kite without the string.

An emotion exists only when it has an animation. Today those are **hello** and **insulted**, with **neutral** for no reaction. Colour stays fixed. The default speaking tone lives in `../agent/src/conversation/persona.md`; motion does not choose the wording.

## The reference frame and parts

All geometry uses SVG `viewBox="0 0 200 240"`. Ground is y 238. `y` is height above the standing place, not a screen coordinate: 0 standing, 58.8 hovering. The untransformed reference kite hovers at centre (100, 88), tip (100, 173). Standing moves it down 58.8 units: centre (100, 146.8), tip (100, 231.8); the bow reaches the ground.

| Part | Current facts |
| --- | --- |
| Body | Half width 73, height above centre 71 and below 85. Superellipse exponents 1.30 above and 1.20 below. Four quadrants of 14 cosine-spaced samples, last sample omitted in each: 52 clockwise points, top 0, right corner 13, tip 26, left corner 39. Closed Catmull–Rom path, fill only. |
| Lifted corner | Swings around a pivot 22 units from the centre toward its side. At 33° lift, upper exponent is 1.06 and lower 1.38. Stretch adds up to 2.5 units of reach at 250°/s. |
| Folded hand | Walks 26 units along each edge from the lifted corner, then resamples that outline to 16 points. Fold and crease share their ends; crease bows 3 units inward. Strength is smoothstep((lift − 3)/10): absent below 3°, full above 13°. Crease opacity is 0.55 × strength. |
| Speed lines | Two arcs at corner reach + 6 and + 12; they trail the direction of motion. Strength rises above 35°/s and saturates 90°/s later. |
| Bow | The flip script's `BOW_D`, attached to the tip. |
| String | Deterministic kinematic chain: 16 segments, each 3.75 units at rest, total 60. Angles blend from 90° + wind + drag into a pose angle + 0.3 × wind, with authored lag and overshoot. Pose chord proportions preserve uneven lengths. `payout` scales lengths. Open Catmull–Rom path. |
| String floor | Lying pose curves down then left from the standing tip. Every string point, including a written route, is clamped to y ≤ 237.5. Landing blends from the free end first (28 ms per segment, 450 ms duration, out-back 0.9); launch releases from the base first (40 ms per segment). |
| J and written route | The authored J measures about **95.54 units**, payout about **1.592**, not 106 units. Its free end traces a dense local fist/finger polyline, resampled by written length, scaled and tilted 25% toward the last segment. Tremor is authored separately. |
| Drag | Host carry gives sideways speed, smoothed over 80 ms. Angle offset is 0.08 × speed × distance along the chain, capped ±60°. Carry adds no position; the host moves the node. |
| Eyes | Origins (100 ± 15.5, **89.9**) in the reference pose, on the lower lid line. Round radius 7.5. `lid` at anger 0 is eye A; anger and squint morph its polygon. B and C are reserved for scripts that use them. |
| Closure | Open shape scales about the lid line with scaleY at least 0.04, fading above closure 0.9. The shallow arch `M-8.5 0 Q0 -3.2 8.5 0`, stroke 3.2, fades in above 0.6. Both lids must be ≥0.9 before a new eye kind appears. |
| Spinner | Same 52 points, blended point by point to a C band: radius 52, thickness 22, 79° gap at twelve o'clock. Points 6–46 form the outer arc; the remaining points close the caps and inner arc. The top folds into the hole. |
| Palette | Body `#5396F8`; string, bow and speed lines `#8FBBFA`; fold `#6DA7FA`; crease `#3F79CC`; eyes `#000`. |
| Drawing | SVG presentation attributes, no `style` attribute. Every stroke is widened to at least 0.8 screen px using measured `unitPx`. |

The lane uses scale .24 (about 35 px body width), the hero .6 (about 88 px). The host's full box is 200 × 240 with transform origin at its bottom centre; drawer crop is `0 70 200 170`. Check the narrow-screen sizes as well as the defaults.

## Architecture and state

The character is JavaScript geometry. `parts/` owns forms, eyes, hand, string and route data; `geometry.js` owns geometric primitives. `draw/paint.js` is pure frame → SVG tree; `draw/view.js` mounts that fixed tree once and updates attributes. The host owns DOM placement and screen travel.

`state.js` names twelve tracks: `y`, `roll`, `lift`, `squash`, `form`, `lids`, `eyeKind`, `anger`, `squint`, `payout`, `stringPose`, `written`. `eyeKind`, `stringPose` and `written` are step tracks. A resolved string pose has angles, optional chord proportions and per-segment blend; a clip key may instead request a timed raise. A written value holds route points/length, written length, scale and tremor.

`clip.js` supplies track writers, `t()`, `phase()`, `returnToRest()` and `finish()`. Keys are `{ t, v, e }`, in milliseconds, with easing on the key being arrived at. `player.play()` copies the clip and prepends live state at t 0; it never changes catalogue keys. Unmentioned tracks hold. Builders use `returnToRest(start, ownedTracks)` to reset the tracks they do not own, including string payout/pose and scowl, so interruption cannot leave a previous gesture behind. Every hold needs keys at both ends.

The player composes a frame from authored state plus derived roll, lift speed/stretch, pivot, eyes and string points. Idle layers never become part of the next clip's start state. `clips/catalogue.js` lists six builders; `emotions.js` maps emotions to them; `director.js` orders them from events without timers or DOM.

## Rules that apply to every clip

- Roll answers lift at −10% of (right − left), **100 ms late**; the 250 ms history survives clip changes.
- Lift speed is sampled across a 40 ms window; stretch and speed lines use that same speed. A wink gives the other eye an 18% sympathy squint.
- Hover bob is 1.6 units over 3 s. Hover sway uses mean wind delayed 150 ms at 0.12° per wind unit. Standing sway is ±0.6° over 6.1 s with a −2° lean toward the lying string. Their weights blend with clamp(y/8, 0, 1).
- The pivot blends from tip when standing to centre when hovering, so a grounded contact does not slide under roll and squash. Height never goes below zero.
- Idle blinks are scheduled 4–9 s apart and skipped during clips: shut 60 ms, hold 40 ms, reopen to −0.07 overshoot by 200 ms, settle by 340 ms. The first idle blink at least 3 s after a clip returns eyes to round and anger to zero. A clip's eye-kind change waits for both lids to shut.
- Eyes fade as form goes from .1 to .4. The string reels in with payout × (1 − form); written routes are hidden during the morph. The bow stays attached.
- Reduced motion combines the saved setting with the system preference: Jet stays grounded with round open eyes, no idle oscillation, blink, flight or spinner rotation. The form still morphs; the host fades between places. Do not require a blink to restore round eyes under this setting.
- Draw idle at 30 fps or more, and active clips every animation frame. The host passes measured scale for strokes and node movement for carry. Flight lifetime follows `moveAt`/`moveMs`, not status: settle also reports `flying`.

## Motion grammar and authored references

Shaun's motion scripts are the authority for new gestures. The current references are `jet-wave-motion.py`, `jet-wave.svg`/`.html`, `jet-flip-motion.py`, `jet-flip.svg`/`.html`, `character-kite.svg` and `jet-eyes-A/B/C.svg`, supplied in `/Users/shaun/Downloads/`. They are source references, not files shipped with the app. `dev/golden.mjs` extracts compact wave/flip fixtures into `ui/jet/fixtures/`.

The wave anticipates with a dip, lifts past the target, settles, wags three times, drops past rest, recovers and holds. Its folded hand leads the body; delayed roll, stretch and trailing lines answer the lift. The wink shuts faster than it opens. The string lags while wind and hover bob continue.

The flip prepares a scowl, shivers with irritation and leans. The string raises base-first into a J, pays out, then **writes the fist and raised middle finger as one continuous cursive stroke**. It clenches, hops, trembles at 9 Hz, unwinds along the same stroke and drops before the eyes soften. Preserve the order and authored pauses; a substituted hand icon loses the gesture.

Anticipation, arcs, overshoot, follow-through and slower returns give movement weight. Squash and stretch usually preserve volume, with deliberate exceptions such as the spinner's swell. A peak needs a readable hold. Idle motion stays small. New motion must remain welcome on the fiftieth viewing, and readable at lane size.

| Clip | Timing and endpoint |
| --- | --- |
| `hello` | 2550 ms; `dip`, `lift`, `wag`, `drop`, `rest`. Reveal at start of wag, **650 ms**. Brief ends at 1650 ms with one wag and no wink; the same reveal point. Uses lid eyes, swapping under an opening blink only if needed. |
| `insulted` | **4800 ms**; prepare 0–420, scowl 420–560, J raise from 800, palm 1860–2400, finger 2490–2720, hold to 3400, unwind/drop, anger softens 4400–4680. Reveal at start of `hold`, **2720 ms**. Ends hovering, lid eyes/anger 0. A standing start lifts during the initial 420 ms; reduced motion stays grounded. |
| `fly` | Anticipate to 180 ms, launch to **500 ms**, cruise for host `cruiseMs` (at least 220), brake 400 ms. Launch overshoots height to 64 then returns to 58.8. Host cruise is 520–1400 ms based on distance, bows right by 15% of distance (cap 40 px), overshoots 5 px, then lands. |
| `settle` | **1080 ms**: rise 160, contact 680, round eyes under shut lids at contact, squash/rebound and open, string laid left. Ends standing. |
| `working` | Shut 80 ms, hold 40, morph 360; spin starts 240 ms into morph (**360 ms from start**). First turn takes 1.5 × 1.1 s; then 1.1 s turns until the eight-second region, one slowing turn, then 1.8 s. Continuations keep angle and elapsed working time. The sole hold. |
| `workingEnd` | Finish the current turn in **200–700 ms**, then unmorph over 360 and reopen over 300. Whole-turn keys are 360 then 0 at the same time; never rewind or cut the turn. Reduced motion holds roll. |

Wave goldens compare roll within 0.05° and hand opacity/wink scale within 0.02. Flip goldens compare roll, dy and eye corners every fifth frame within 0.05. The **string golden applies only to fully blended J frames, about 2.0–3.74 s**, using wind frequencies `[2/4.8, 3/4.8]`; the authored reference keeps unequal J chords even before blending, while the runtime's hanging chain starts with equal lengths. Do not claim a full-duration string match.

## Status, emotion and reply timing

| Director status | Meaning and drawing |
| --- | --- |
| `idle` | No clip playing; standing in a lane or hovering in the hero, with normal-motion idle layers. Also possible while streaming after a reaction. |
| `flying` | `fly` or `settle`; host movement occurs only in fly's cruise. |
| `reacting` | `hello` or `insulted`. |
| `working` | `working` or `workingEnd`: waiting spinner or its closure. |

| Word | Animation | Classifier question |
| --- | --- | --- |
| `neutral` | none | no question; fallback when no supported score qualifies |
| `hello` | wave | Is the user greeting you or saying goodbye in this message? |
| `insulted` | flip | Is this message insulting you or expressing contempt for you? |

`MOODS`, `EMOTIONS`, `agent::Mood::ALL`, persona mood descriptions and JEV questions share this vocabulary. Unknown saved mood words read as neutral. The reply's mood is distinct from the feeling classified from the user's message.

On send the bubble and slot appear, flight starts and classification starts concurrently. The model request waits for the feeling or neutral fallback; it does **not** wait for the flight or reaction. The director queues the feeling reaction after the flight's brake, or starts it immediately if nothing is playing. A spinner starts only after classification and any reaction, if no text/mood has arrived; quick replies skip it.

`feel()` and `mood()` return `revealAt`, an **absolute monotonic deadline** on the host clock. `holdUntil(at)` extends the hold for both streamed Markdown and final successful HTML/announcement, including an early `finished` event. `revealFrom` refers to the start of a named phase, not its end. A different supported reply mood queues another reaction after spinner closure and extends the deadline. Neutral or the same word already felt adds no reaction. Without a feeling, a no-clip mood uses the 300 ms hold.

Successful completion preserves queued reactions and settles afterward. Failure and Stop discard waiting reactions, close the spinner if needed and settle; they cancel the text hold. A stopped classification cannot dispatch the model. Turn identity guards discard late classifier answers and old provider events. Reduced-motion fades also reject stale callbacks after stop/retry.

JEV's credentials, request, selection and fallback rules are documented in [Feelings and reply timing](README.md#feelings-and-reply-timing). Never use a live classifier call as part of default validation.

## Adding an emotion

Each supplied animation is one future feature; do not invent extra mood words first.

1. Read the supplied script and its SVG/HTML; record timing, frame, eye kinds, route data and reveal beat. Resolve differences against the actual script before implementing.
2. Add a `buildX(start, options)` clip using `createClip()`. Use named phases, duration constants, keys on both sides of holds, exact script curves, and `returnToRest` with owned tracks excluded. Handle standing, hovering, interruption and reduced motion.
3. Add the builder/hold flag in `clips/catalogue.js`, and the emotion → clip mapping in `emotions.js`. Add the word to the single-line `MOODS` export in `director.js`.
4. Add the Rust `Mood` variant, `ALL` entry, `word()` mapping, persona mood description and JEV question in `../agent/src/feeling/mod.rs`. Keep neutral as the no-animation fallback. Update the pinned persona fingerprint when prompt content changes.
5. Add the clip's compact golden fixture and public-behavior coverage; extend catalogue interruption and director timing coverage where needed. Keep Rust's vocabulary agreement test. Add its coverage row to the README test table and update this policy's emotion table.
6. Preview through the real player and painter, inspect contact sheets beside the authored reference at key times, and complete the visual checks below. Update fake classification only when useful to exercise the new feature in a browser.

A new clip should not require player or drawing changes unless it introduces a new part or state capability. Question that extra complexity before expanding the model.

## Before you show it

Run the local build/tests/lints in [README.md](README.md#local-checks). No tests or renders replace looking at the result.

From `crates/jet`, with `/opt/homebrew/bin/rsvg-convert` installed:

```sh
node dev/frames.mjs still --standing /tmp/jet-standing
node dev/frames.mjs still --hovering --lift 0,0 --lift 0,10 --lift 0,20 --lift 0,30 /tmp/jet-lifts
node dev/frames.mjs still --hovering --form 0.25 --form 0.5 --form 0.75 --form 1 /tmp/jet-forms
node dev/frames.mjs still --hovering --pose j /tmp/jet-j
node dev/frames.mjs hello /tmp/jet-motion
node dev/frames.mjs insulted /tmp/jet-motion
node dev/frames.mjs insulted --layers off /tmp/jet-reference
node dev/frames.mjs working --reduced-motion /tmp/jet-reduced
```

The preview writes SVGs, 2× PNGs and lane-size PNGs (96 × 115 device pixels at 2×; 48 × 57.6 CSS px, rounded for PNG output) plus contact sheets. Clip clocks sample every 40 ms (25 fps) and disable random blinks; idle layers are on unless `--layers off`. Keep output outside the repository. Golden comparison disables idle layers; inspect the production-layer variant too.

- [ ] Compare wave at 0, .18, .50, 1.15 and 2.30 s; flip at 0, .75, 1.45, 2.40 and 3.0 s. Contact sheets choose the last 40 ms frame at or before each requested time.
- [ ] Inspect standing/hovering, lifts, J/written route, spinner and morph midpoints at 2× and actual lane size. Check contact, floor, bow attachment, hand creases, line direction and eye legibility.
- [ ] In browser mode, send “hi”, “you useless thing” and a neutral message: flight, reaction, held text, spinner only if needed, streaming, settle. Try a quick reply, Stop during classification/reaction, early completion, held next message and rapid retry.
- [ ] Check hero, relaunch wave, narrow screens, scroll-follow and reduced motion; round eyes stay open and grounded, spinner does not rotate, stale fades do not move a new turn.
- [ ] In the browser, inspect drawer at 96 and 44 px, lane character and system reduced motion.
- [ ] Only with explicit paid/network opt-in, check live JEV classifications and measured latency. Local fixtures do not prove service quality or latency.

Full browser animation sequences and live JEV quality/latency are still outstanding manual QA. Offline renders and local tests establish only their own geometry and timing checks; do not report unobserved runtime behavior as verified.
