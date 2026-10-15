# Character policy: how to animate Jet

For anyone, human or agent, adding a pose, a clip or a status to Jet. Read this before touching `rig/jet.json`, `rig/poses.rs` or `ui/jet/`. It records how the existing work was reasoned about, so the next piece feels like the same character.

## 1. What Jet is

Jet is a circle that borrows other shapes when it has something to say.

- **The circle means nothing is happening.** Every departure from round is information. The further from a circle, the more is going on. Calm is always a return to the circle.
- **Jet is one body, not a set of icons.** Every state is a deformation of the same path. Morphs tween; nothing cuts or crossfades.
- **Three channels, one leading at a time.** Shape says what Jet is doing. Eyes say whether Jet is with you. Colour says how Jet feels. Fire all three together only for a celebration.
- **The user sets the ceiling.** The behaviour wheel decides how far Jet may go and in what flavour; the expressiveness dial decides how much of that shows. Nothing in a clip is allowed to ignore them.

## 2. The rig, in facts

- One closed path of **ten anchors**, each stored as point, outgoing handle, incoming handle: sixty numbers per pose, in a 100-unit box.
- Anchor order: head, right shoulder, right hand, right armpit, right hip, **foot**, left hip, left armpit, left hand, left shoulder.
- The four corners (head, two hands, foot) are the identity. The other six **sleep on the edges** in the circle and the diamond, and wake as a limb when needed. That is why a hand can be round: it is a smooth anchor with handles across the arm, never a corner.
- **The foot is at (50, 88) in every pose.** A test enforces it. Jet stands on that point; it does not slide.
- Stroke 12, round join, same colour as the fill. That is where the soft corners come from; do not round them in the geometry.
- Eyes are two ellipses, placed per pose, stored as seven numbers: the two centres, the two radii and the **tint**. Tint 0 is the ground colour a face is drawn in; tint 1 is the body colour lightened toward white. Sizes carry expression: open 4, pop-in 4.6, squint 5 × 1.6, narrowed 5 × 1.8, blink 0.4. A face opens out of faint eyes into the ground colour and closes back to faint. Hidden is size 0 at tint 1, never `display: none`, so they can tween.
- At rest the circle shows **faint eyes**: at the circle's eye positions, size 2.2 scaled like the eyes dial, tint 1. They blink every 4–9 s at random, and never under reduced motion. They come back only when a clip ends at the circle with no face, so a hold keeps its own eyes. A short send reaction such as the nod or the hop may keep them on the moving body. The pip has no eyes of its own.
- **The ring** is the one stroked element beside the body, stored as eleven numbers so it tweens (centre, radii, rotation, width, dash on/off, dash offset, opacity, colour mix). It is the working loop and, in the ground colour, the spin grooves when Jet rolls. The disc is radius 19 with stroke 38, so it covers the circle exactly. The loop is radius 25 with stroke 14, and its centre is raised to y 48 so that its hole stays clear of the pip. The gap is a dash: 22% of the way round, starting at 3 o'clock and running clockwise, so at rotate 0 the gap lies between 12 and 3 o'clock. A disc is just a stroked circle whose stroke is as wide as its radius.
- **The pip** is a dot on the foot. The body shrinks to it while the disc covers it, sits under the loop while Jet works, and shrinks to it when Jet is interrupted. It is a circle of radius 5 at y 83. It tucks under the lower edge of the loop, on purpose, so that the two read as one body. A smaller circle draws a ring inside its own stroke.
- **Props** are things Jet holds or uses: an umbrella, a bat, a ball, a rope. There are two slots, each stored as five numbers (x, y, rotate, scale, opacity) so they tween, and the clip names the kind for each slot. Hidden is opacity 0, and the element stays in the page. Props are drawn in the page's text colour at half strength behind the body: enough to read at lane size, never saturated, so Jet stays the only saturated thing. A prop never outlives its clip: a clip with no prop track fades both slots to hidden within 200 ms, and a clip that is not a hold ends with both hidden.
- **Speed** is a track like any other: units per second that scenery may scroll by. Jet itself stays where it is; the world moves.
- **Airborne poses** are named with the `zoom` prefix. They are rolling, flying, falling or dangling (`zoom_hop` is the lift of a hop; `zoom_fall` and `zoom_dangle` are the drop and the abseil), so the foot anchor is not on the ground, but their lowest point never sinks below it. Everything else keeps its foot planted. A test checks both.

## 3. Rules that do not bend

1. The foot never moves unless Jet is airborne, and airborne poses say so in their name.
2. **The circle never has a face in the ground colour.** Its faint eyes are its rest state. A face in the ground colour appears only once Jet is standing, and goes back to faint before the melt. Below eyes 1.5 even the faint eyes are gone.
3. Every edge bows at least 8% off its chord. Straight edges read as a crystal, not a body.
4. Hands are round. If a limb ends in a point, the rig is being used wrong.
5. Every clip starts from wherever Jet currently is. The player prepends the live state to every track; a clip never assumes it begins at the circle.
6. Expressions are short, under about 1.5 s of peak, then back to the circle.
7. A clip must degrade honestly: shape 0 never leaves the circle, eyes 0 never shows a face, motion 0 drops every extra beat, reduced motion holds instead of oscillating. Shape 0, motion below 3 and reduced motion never show a prop.
8. Jet may be annoyed with the user only to the degree the wheel allows, and never with panic: errors get a bow, not a shake.
9. Scenery is not the character. It reads the speed track and nothing else, draws in the ink colour at low opacity, scrolls in layers at different rates, and fades away at rest. Jet is the only saturated thing on the stage.
10. Colour shifts stay small. Coral blended far toward blue turns mauve; a mood is a tint, not a new colour.

## 4. The motion grammar

This is what separates alive from robotic. The first wave was robotic because it broke all of these at once.

- **Squash and stretch keep volume.** Wider as it gets lower, thinner as it gets taller. Standing up is squash, then stretch past the target, then land with an impact squash.
- **Anticipate.** Before a limb moves, the body goes 10–15% the other way (the shoulder dips before the arm swings).
- **Arcs.** Hands travel arcs, not lines. The hand leads on the way up and lags on the way down.
- **The body answers the limb.** When an arm goes up, the head tilts toward it, the far shoulder drops, the back lengthens. Shoulders moving in opposite directions is what reads as a twist in two dimensions.
- **Follow-through.** Come down past rest (the tuck), then settle. Blink when the beat is over.
- **Timing is never symmetric.** Out 180 ms, in 220 ms. Fast leaving a pose, slow arriving. No two anchors should share an easing at the same moment if you can help it.
- **Hold the peak one extra beat** before leaving it.
- **The return melts.** Relax, puddle wider than the circle, rebound taller, settle. Never rewind the stand-up.
- **Idle is never still.** Breathing of about 2% and a blink of the faint eyes every 4–9 s at random, never a loop you can count. Both are built.
- **Easings are CSS cubic-beziers**, named in the clip file, so a curve tuned in a browser can be copied over unchanged.
- **Travel is stretch along the direction of motion.** Rolling, Jet is an oval with its long axis along the way it is going, nose up a little, bobbing gently; it crouches back before it goes, launches past its cruising shape, piles forward when it brakes, and wobbles back to round. The camera follows Jet, so the ground moves and Jet does not.
- **A fall is the host's move.** In the drop and the abseil the host moves Jet down the page, falling faster until 40% of the way and then slowing, or in three steps; the clip supplies only the prop, the body's answer to it and the landing.
- **A hold needs a key.** The sampler eases between neighbouring keys, so a value that should stay put during a long phase needs a key at the start of the next phase too, or it will drift across the whole phase. This bit the zoom's speed and colour tracks on the first pass.

## 5. How the dials reach a clip

Every clip is built from the same parameters, so new clips must map them the same way:

| Control | What it does inside a clip |
| --- | --- |
| Shape (0–10) | `lerp(circle, pose, k)` on every pose. At 0 nothing leaves round, and no prop shows. |
| Eyes (0–10) | Eye size, and the size of the faint eyes at rest; below 1.5 no face and no faint eyes; squint allowed above 3.5. |
| Colour (0–10) | How far the body shifts toward a mood colour at the peak. |
| Motion (0–10) | Switches the extras: anticipation, lag, tuck, size of the landing pop, idle breathing, props (below 3 none). |
| Playful ↔ serious | Cycles, squash, tempo, whether eyes squint. Serious keeps the eyes round and steady. |
| Deferential ↔ candid | Reach and hold of a gesture; deferential shortens it and adds a bow. |
| Distance from centre | How much of the wheel's flavour applies. The centre is a tool with no opinions. |

Exaggeration is allowed to pass 1: `lerp(soft, pose, 1.3)` is how candid raises the arm higher than it was drawn.

## 6. Making a pose

**Construct it; do not hand-place anchors.** Hand-placed points on a free-form outline come out lumpy, because sleepers that are not on a smooth curve put kinks in it. The generator builds every pose from a few decisions. The geometry that turns them into numbers lives in `rig/shape.rs`. The table of decisions is in `rig/poses.rs`. Each decision is:

- a body: head, two hand corners, the fixed foot, and four edge bows;
- for an arm: the arm base (the right corner), an angle, a length, and the mitten width. The shoulder flows out of the top edge, the mitten is a semicircle, the armpit is a crease;
- for travel: a tilted ellipse (centre, radii, tilt), with its lowest point on or just above the ground line. Eyes on a tilted body are placed in the body's own frame, then rotated with it.

Then:

1. Add the pose to the `poses()` table in `rig/poses.rs`, using the primitives from `rig/shape.rs`, and run `cargo run -p jet --example poses > rig/jet.json` from `crates/jet`.
2. If the pose can show a face, add its eye positions to `eyes()`. Put them in the upper third of the body, following the head.
3. **Render it and look.** Draw the pose sheet to a PNG (any browser or Playwright will do) at 150 px and again at 20, 36 and 56 px. A Bézier you have only imagined is wrong more often than not; the first ten-anchor attempt was a potato with a thumb until it was looked at.
4. Check the tween: render the midpoints between the new pose and its neighbours in the clip. Linear blends can cut corners on long arcs; add an intermediate pose if the hand swings through the body.
5. `cargo test -p jet` confirms sixty numbers and the foot, and that `rig/jet.json` is what the generator prints.

## 7. Making a clip

A clip is a function `buildX(rig, params, options)` beside `ui/jet/clips/hello.js` that returns the same shape: `body`, `eyes`, `colour`, `scale`, `ring`, `speed` and `prop` tracks, `props` (the kind of each prop slot, when the clip shows a prop), `total`, `phases` (named, with end times), `readout` rows for the lab, and an `info` object saying what the dials turned into. `hello.js` and `zoom.js` are the two references. The mood clips share their stand-up and melt in `clips/beats.js`.

- Write times as durations, scaled by tempo; keep the numbers in constants at the top so they can be tuned without reading the logic.
- Put the easing on the key being arrived at. Do not put keys at time 0; the player supplies the live state there.
- A track the clip does not mention holds its current value. A track it does mention should also say where it ends, so an interrupted zoom does not leave the ground moving under a hello.
- Give every beat a name that is a verb (dip, swing, peak, tuck, melt, launch, cruise, brake). Names already used are the vocabulary; reuse them.
- Add the clip to `clips/catalogue.js`. `catalogue.test.mjs` holds every clip in it to the shared contract: time runs forward in every track, shape 0 never leaves the circle, eyes 0 never show a face, any clip that interrupts any clip comes to rest with no ground speed and no grooves (and with both props hidden, unless it is a hold), shape 0, motion below 3 and reduced motion never show a prop, and every prop a clip names is a known kind. So a clip's own test file covers only its own choices.
- A clip may take options. Hello takes `brief`, zoom, drop and abseil take `cruiseMs`, working takes `spinMs` and `continueFrom`, workingEnd takes `rotate`, done takes `long`, error takes `exclaim`, interrupted takes `rotate`, and batBall and doze take `loopMs` and `continued`.
- **A hold ends away from the circle on purpose.** `lean`, `peer`, `creep`, `working`, `batBall` and `doze` are holds. Jet stays in them until something else plays, so the director always gets Jet back to the circle through a clip that ends there (`leanBack`, `workingEnd`, `interrupted`, `batBallEnd`, `dozeEnd`, a travel or a mood), though a typing hold may first give way to an antic.
- **Rotate stays below one turn.** End every whole turn of the ring with two keys at the same time, 360 and then 0. They look the same, and any clip that hides the ring turns it back by less than a turn.
- The working loop turns clockwise, one turn in 1.1 s for its first 8 s, then one turn that slows to 1.8 s, then one turn in 1.8 s. `working` and `workingEnd` ignore the tempo: the loop is a status, not a mood.
- The director (`ui/jet/director.js`) decides which clip plays for each chat status and mood. It never builds a clip by hand: it reads `clips/catalogue.js`.
- The player and the view need no changes for a new clip. Only a new kind of element would, and the rig has had two of those in its whole life: the ring and the props. A new kind of prop needs a shape in the view and a name in `PROP_KINDS`.

## 8. The status vocabulary

Shapes already chosen for statuses, so new work stays consistent:

| Status | Shape | Eyes | Notes |
| --- | --- | --- | --- |
| Idle | circle, breathing | faint, blinking every 4–9 s | built |
| You start typing | leans toward the input, peers up on tiptoe, or creeps closer | none; faint and narrowed in the peer | built: `lean`, `peer` or `creep` at random, then `leanBack`; only when idle |
| Working | loop, spinning clockwise | none | built: `working`, `workingEnd`; the hole opens from the centre; the gap opens top-right; never cut a turn short |
| Progress known | loop whose gap closes in proportion | none | |
| Done | ✓ for a beat, or the small jump | smile | built: `done` (the quick squash, and the long small jump) |
| Needs you | ? glyph, or lean in | open | built: the lean in, `needsYou` |
| Error | ! glyph, then a bow | none | built: `error`; calm, a bow and never a shake |
| Heads-up | pennant (raised flag) | none | |
| Thinking | stands, holds the `ponder` pose with a slow blink, melts | high on the body | built: `thinking`; no colour |
| Excited | squash, hop, arm up, melt | squint at the peak | built: `excited`; the one clip that uses all three channels |
| Annoyed | stands, `glare`, a bow, melt | narrowed | built: `annoyed`; only as far as the wheel is candid, and a bow, never a shake |
| Hello | stand, wave, melt | open, squint at peak, blink at end | the reference clip |
| Jetting off | crouch back, launch, roll as a tilted oval with spin grooves, brake, settle; for a move mostly straight down, at random, the zoom or one of two falls: the drop (crouch, lift into a tall fall, an umbrella pops open 40% of the way down, Jet relaxes and bobs beneath it, lands with a squash as it folds) or the abseil (a rope fades in from above, Jet dangles and kicks off three times on the way down, lands, the rope whips away) | slits into the wind above eyes 6, else none; wide in the drop and open in the abseil above eyes 6 | built: `zoom`, `drop`, `abseil`; scenery scrolls by the speed track, only in the zoom; the cruise lasts as long as the job |
| Asleep | flat on a side | closed | long idle |
| Interrupted | shrinks to a dot | none | built: `interrupted` |
| Offline | hollow ring, muted colour | none | |
| You stall mid-message | bat and ball (the ball bounces on the bat, the body squashes with each landing), or a doze (slumped, a slow 3% sway) | faint; slits in the doze | built: `batBall` or `doze` at random 6 s after the last keystroke while the field has text; typing again plays `batBallEnd` or `dozeEnd`, then a typing hold, and emptying the field plays the end clip alone; a send or a hello cuts in and the props fade; never under reduced motion, and one already playing ends at its next loop once the dials no longer allow it; the bat and ball only from motion 3 and above shape 0 |
| You press Enter | a snappy gesture, then the travel: salute (hand to the brow), nod, blink (a quick double-blink) or hop, or nothing | a face for the salute and the blink; the nod and the hop keep faint eyes | built: chosen at random, all five equally likely; a serious Jet skips the blink; at most 350 ms, and the take-off waits for it; none under reduced motion |

The reply starts with a mood word, and the director maps each word to one clip:

| Mood word | Clip |
| --- | --- |
| neutral | none; the loop only closes |
| happy | `done` with `long: true` |
| excited | `excited` |
| thinking | `thinking` |
| curious | `needsYou` |
| sorry | `error` with `exclaim: false` |
| alert | `error` |
| annoyed | `annoyed` |
| hello | `hello` with `brief: true` |

An unknown word is neutral.

Jobs under about 900 ms skip the loop entirely (a squash and settle only), so quick work does not flicker. Past about 8 s the loop slows rather than speeds up.

## 9. Before you show it

- `node --test` from `ui/`, `cargo test -p jet`.
- Render frames offline and look at them. Do not describe motion you have not seen.
- Watch it at avatar size. Eyes vanish at 20 px on every shape, which is why the silhouette must carry the status on its own.
- Ask two questions of any new motion: does it read as the same being as the circle it came from, and would it still be welcome the fiftieth time today? If the answer to the second is no, shorten it or make it rarer.

## 10. Why it is built this way

- **Data, not clips.** Poses are numbers; clips are code that writes keyframes from the dials. There is no asset per setting, and any state can blend into any other, which baked animation formats cannot do.
- **One source of truth.** The rig ships inside the Rust binary and is checked at start-up. Every platform that draws Jet reads the same file.
- **Small enough to reason about.** Ten anchors, two eyes, one ring, two props, a palette of five, and a speed number for the world outside. If a new idea needs more than that, question the idea before growing the rig. The zoom needed scenery and got it, but the scenery lives outside the character and reads one number from it.
