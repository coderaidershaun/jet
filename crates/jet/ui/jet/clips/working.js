// Builds the clips for the working loop: Jet shrinks to a dot while a disc forms
// over it and opens into a spinning loop, and later the loop finishes its turn,
// closes and fills back into the circle. The loop is a status, not a mood, so
// these clips ignore the tempo the wheel would set and run at exactly the times
// written here.

import { createClip, onOff, readDials } from '../clip.js';
import { cubicBezier } from '../easing.js';
import { lerp } from '../maths.js';
import { RING, RING_HIDDEN } from '../state.js';

/** @typedef {import('../clip.js').Clip & { info: WorkingInfo }} WorkingClip */
/** @typedef {import('../clip.js').Clip & { info: WorkingEndInfo }} WorkingEndClip */

/**
 * @typedef {object} WorkingInfo
 * @property {number} spinMs
 * @property {boolean} continued     true when this clip carries on a loop that is already turning
 * @property {boolean} held          true when the loop opens and then stays still
 * @property {number} shapeAmplitude
 */

/**
 * @typedef {object} WorkingEndInfo
 * @property {number} turnLeft       degrees the loop still had to turn
 * @property {number} finishMs
 * @property {number} shapeAmplitude
 */

const ease = {
  shrink: cubicBezier(0.4, 0, 0.2, 1),
  grow: cubicBezier(0.2, 0.8, 0.4, 1),
  open: cubicBezier(0.2, 0.8, 0.3, 1),
  close: cubicBezier(0.4, 0, 0.6, 1),
  fill: cubicBezier(0.3, 0, 0.7, 1),
  regrow: cubicBezier(0.2, 0.8, 0.4, 1),
  inOut: cubicBezier(0.4, 0, 0.6, 1),
  drop: cubicBezier(0.4, 0, 1, 1),
  settle: cubicBezier(0.2, 0.8, 0.4, 1),
};

const GATHER_MS = 200;
const OPEN_MS = 360;
const FINISH_LONGEST_MS = 320;
const FINISH_SHORTEST_MS = 60;
const CLOSE_MS = 140;
const FILL_MS = 180;
const REGROW_MS = 220;
// A face or a moving ground left by the clip before is gone this early, before the disc has formed.
const CLEAR_MS = 120;
// The ring takes the body colour a moment after the clip starts, so that the disc never flashes the ground colour.
const RING_COLOUR_AT_MS = 40;

const FAST_TURN_MS = 1100;
const SLOW_TURN_MS = 1800;
const FAST_UNTIL_MS = 8000;
// One turn that slows from the fast speed to the slow one, with the speed changing evenly.
const SLOWING_TURN_MS = 2 / (1 / FAST_TURN_MS + 1 / SLOW_TURN_MS);
const SLOWING_START_SHARE = SLOWING_TURN_MS / FAST_TURN_MS;

// A disc is a stroked circle as wide as its radius, and its outline is the circle's outline.
// The loop rises so that its hole stays clear of the dot under it. Its gap is 22% of the way round.
const DISC = Object.freeze([50, 56, 19, 19, 0, 38, 119.4, 0, 0, 1, 1]);
const LOOP = Object.freeze([50, 48, 25, 25, 0, 14, 122.5, 34.6, 0, 1, 1]);

/** How far through a turn the ring is after `share` of the turn's time. */
const turns = {
  fast: { ms: FAST_TURN_MS, progress: (share) => share, slows: false },
  slowing: {
    ms: SLOWING_TURN_MS,
    progress: (share) => SLOWING_START_SHARE * share + (1 - SLOWING_START_SHARE) * share * share,
    slows: true,
  },
  slow: { ms: SLOW_TURN_MS, progress: (share) => share, slows: false },
};

// Round line ends fill a gap narrower than the stroke and bulge past the circle. So the gap shows only
// once the loop is whole, from 3 on the shape dial; below that the ring is a closed ring with a hole.
const LOOP_FULL_AT_SHAPE = 0.3;

/** The ring part way from the disc (`open` 0) to the loop the shape dial allows (`open` 1), turned to `rotate` degrees. */
function ringAt(ks, open, rotate) {
  const loopShare = Math.min(1, ks / LOOP_FULL_AT_SHAPE);
  const loop = lerp(DISC, LOOP, loopShare);
  if (loopShare < 1) {
    loop[RING.DASH_ON] = 2 * Math.PI * loop[RING.RX];
    loop[RING.DASH_OFF] = 0;
  }
  const v = lerp(DISC, loop, open);
  v[RING.ROTATE] = rotate;
  return v;
}

/**
 * Writes the keys for a loop that turns clockwise from `from` to `until`. Each whole turn
 * ends with two keys at one time, 360 and then 0, so that rotate stays below one turn.
 * `elapsed` is how long the loop had been running at `from`; the loop turns fast for the
 * first eight seconds, then makes one slowing turn, then turns slowly.
 */
function writeSpin(ring, { from, until, rotate, elapsed, ks }) {
  let at = from;
  let angle = rotate;
  let slowingDone = elapsed >= FAST_UNTIL_MS;
  while (until - at > 0.5) {
    let kind = 'slow';
    if (elapsed + (at - from) < FAST_UNTIL_MS) kind = 'fast';
    else if (!slowingDone) kind = 'slowing';
    if (kind === 'slowing') slowingDone = true;
    const turn = turns[kind];
    const turnMs = turn.ms * ((360 - angle) / 360);
    const share = Math.min(1, (until - at) / turnMs);
    const reached = angle + (360 - angle) * turn.progress(share);
    const shareEase = turn.slows ? (u) => turn.progress(u * share) / turn.progress(share) : undefined;
    at += turnMs * share;
    ring(at, ringAt(ks, 1, reached), shareEase);
    if (share === 1) {
      ring(at, ringAt(ks, 1, 0));
      angle = 0;
    } else {
      angle = reached;
    }
  }
}

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @param {{ spinMs?: number, continueFrom?: { rotate: number, elapsedMs: number } }} [options]
 *   `spinMs` is how long the loop spins; the host decides. `continueFrom` makes a clip that has
 *   only the spin, starting at the rotation and the running time the loop had when its last clip ended.
 * @returns {WorkingClip}
 */
export function buildWorking(rig, p, { spinMs = 30000, continueFrom } = {}) {
  const { ks, reduced, circle, rest, hiddenEyes } = readDials(rig, p);
  const { clip, body, eye, colour, scale, ring, speed, t } = createClip(1);

  if (continueFrom) {
    speed(CLEAR_MS, 0, ease.settle);
    const rotate = continueFrom.rotate % 360;
    if (reduced) ring(spinMs, ringAt(ks, 1, rotate));
    else writeSpin(ring, { from: 0, until: spinMs, rotate, elapsed: continueFrom.elapsedMs, ks });
    clip.phases.push({ name: 'spin', end: spinMs });
  } else {
    // The dot sits under the loop and out of its hole. A half-shrunk ball would show through the hole.
    body(GATHER_MS, ks > 0 ? rig.poses.pip : circle, ease.shrink);
    const forming = RING_HIDDEN.slice();
    forming[RING.MIX] = 1;
    ring(RING_COLOUR_AT_MS, forming, ease.inOut);
    ring(t(), ringAt(ks, 0, 0), ease.grow);
    eye(CLEAR_MS, hiddenEyes('circle'), ease.drop);
    speed(CLEAR_MS, 0, ease.settle);
    colour(t(), rest, ease.inOut);
    scale(t(), 1, ease.settle);
    clip.phases.push({ name: 'gather', end: t() });

    ring(t() + OPEN_MS, ringAt(ks, 1, 0), ease.open);
    clip.phases.push({ name: 'open', end: t() + OPEN_MS });

    const spinFrom = t() + OPEN_MS;
    if (reduced) ring(spinFrom + spinMs, ringAt(ks, 1, 0));
    else writeSpin(ring, { from: spinFrom, until: spinFrom + spinMs, rotate: 0, elapsed: spinFrom, ks });
    clip.phases.push({ name: 'spin', end: spinFrom + spinMs });
  }
  clip.total = clip.phases.at(-1).end;

  clip.info = { spinMs, continued: Boolean(continueFrom), held: reduced, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Turn time', value: (FAST_TURN_MS / 1000).toFixed(1) + ' s' },
    { label: 'Slows after', value: FAST_UNTIL_MS / 1000 + ' s' },
    { label: 'Slow turn time', value: (SLOW_TURN_MS / 1000).toFixed(1) + ' s' },
    { label: 'Spin length', value: (spinMs / 1000).toFixed(1) + ' s' },
    { label: 'Carries on a loop', ...onOff(Boolean(continueFrom)) },
    { label: 'Held still', ...onOff(reduced) },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @param {{ rotate?: number }} [options]   where the loop is turned to now, in degrees
 * @returns {WorkingEndClip}
 */
export function buildWorkingEnd(rig, p, { rotate = 0 } = {}) {
  const { ks, circle, rest, hiddenEyes } = readDials(rig, p);
  const { clip, body, eye, colour, scale, ring, speed, t } = createClip(1);

  const turned = rotate % 360;
  const turnLeft = turned > 0 ? 360 - turned : 0;
  const finishedAt = turned + turnLeft;
  const finishMs = Math.min(FINISH_LONGEST_MS, Math.max(FINISH_SHORTEST_MS, (turnLeft / 360) * FAST_TURN_MS));
  const pip = ks > 0 ? rig.poses.pip : circle;
  const loop = ringAt(ks, 1, finishedAt);
  const closed = ringAt(ks, 1, finishedAt);
  closed[RING.DASH_ON] = 2 * Math.PI * closed[RING.RX];
  closed[RING.DASH_OFF] = 0;
  const disc = ringAt(ks, 0, finishedAt);

  eye(CLEAR_MS, hiddenEyes('circle'), ease.drop);
  speed(CLEAR_MS, 0, ease.settle);

  // The loop always finishes the turn it is on, so a turn is never cut short.
  body(finishMs, pip);
  ring(t(), loop);
  clip.phases.push({ name: 'finish', end: t() });

  body(CLOSE_MS, pip);
  ring(t(), closed, ease.close);
  colour(t(), rest, ease.inOut);
  clip.phases.push({ name: 'close', end: t() });

  body(FILL_MS, pip);
  ring(t(), disc, ease.fill);
  clip.phases.push({ name: 'fill', end: t() });

  // The disc is the circle's outline, so the body can grow back under it and the ring can vanish unseen.
  body(REGROW_MS, circle, ease.regrow);
  ring(t(), disc);
  ring(t(), RING_HIDDEN.slice());
  scale(t(), 1);
  clip.phases.push({ name: 'regrow', end: t() });
  clip.total = t();

  clip.info = { turnLeft, finishMs, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Turn left', value: Math.round(turnLeft) + '°' },
    { label: 'Finishes the turn in', value: Math.round(finishMs) + ' ms' },
    { label: 'Closes in', value: CLOSE_MS + ' ms' },
    { label: 'Fills in', value: FILL_MS + ' ms' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}
