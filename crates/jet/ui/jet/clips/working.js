// The spinner Jet becomes while a reply is on its way: the eyes shut, the kite
// melts into a ring and the ring turns. `working` ends away from rest on
// purpose, as `drift` does; `workingEnd` finishes the turn, melts back into
// the kite and opens the eyes.

import { createClip } from '../clip.js';
import { easeInOut, easeOut } from '../easing.js';
import { clamp } from '../maths.js';

const SHUT_MS = 80;
const HOLD_MS = 40;
const MORPH_MS = 360;
const SPIN_AFTER_MS = 240;
const FAST_TURN_MS = 1100;
const SLOW_TURN_MS = 1800;
const FAST_UNTIL_MS = 8000;
const FIRST_TURN_SCALE = 1.5;
const DEFAULT_SPIN_MS = 30000;
// The body swells a little as the ring forms.
const SWELL = [1.05, 1.05];
const SWELL_AT_MS = 300;

const FINISH_SHORTEST_MS = 200;
const FINISH_LONGEST_MS = 700;
// The last turn runs a little slower than the spin, so it is seen to settle.
const FINISH_SLOWDOWN = 1.5;
const OPEN_OVERSHOOT_AFTER_MS = 160;
const OPEN_SETTLED_AFTER_MS = 300;
const OPEN_OVERSHOOT = -0.07;

const SHUT_DONE_MS = SHUT_MS + HOLD_MS;
const MORPH_DONE_MS = SHUT_DONE_MS + MORPH_MS;
const SPIN_START_MS = SHUT_DONE_MS + SPIN_AFTER_MS;

// One turn that slows from the fast speed to the slow one, with the speed changing evenly.
const SLOWING_TURN_MS = 2 / (1 / FAST_TURN_MS + 1 / SLOW_TURN_MS);

/**
 * A turn of `ms` whose speed changes evenly. It starts at `startSpeed` times the speed of
 * an even turn of the same length, so 1 means no change.
 */
const turnOf = (ms, startSpeed) => ({
  ms,
  progress: (share) => startSpeed * share + (1 - startSpeed) * share * share,
  even: startSpeed === 1,
});

const TURNS = {
  // The first turn speeds up until it is as fast as the turns after it.
  first: turnOf(FIRST_TURN_SCALE * FAST_TURN_MS, 2 - FIRST_TURN_SCALE),
  fast: turnOf(FAST_TURN_MS, 1),
  slowing: turnOf(SLOWING_TURN_MS, SLOWING_TURN_MS / FAST_TURN_MS),
  slow: turnOf(SLOW_TURN_MS, 1),
};

/**
 * Writes the keys for a spinner that turns clockwise from `angle` at `from` until `until`.
 * Each whole turn ends with two keys at one time, 360 and then 0, so the roll stays within
 * one turn. `elapsed` is how long Jet had been working at `from`: the spin is fast for the
 * first eight seconds, then makes one slowing turn, then is slow. With `opening` the first
 * turn speeds up from a slow start. An `angle` of 360 is a turn already whole: its turn takes
 * no time, so it writes the 360 and 0 pair at `from` and the spin goes on from 0 at once.
 */
function writeSpin(roll, { from, until, angle, elapsed, opening }) {
  let at = from;
  let degrees = angle;
  let opened = !opening;
  let slowingDone = elapsed >= FAST_UNTIL_MS;
  while (until - at > 0.5) {
    let kind = 'slow';
    if (!opened) kind = 'first';
    else if (elapsed + (at - from) < FAST_UNTIL_MS) kind = 'fast';
    else if (!slowingDone) kind = 'slowing';
    opened = true;
    if (kind === 'slowing') slowingDone = true;
    const turn = TURNS[kind];
    const turnMs = turn.ms * ((360 - degrees) / 360);
    const share = Math.min(1, (until - at) / turnMs);
    const reached = degrees + (360 - degrees) * turn.progress(share);
    // A turn cut short keeps the same speed curve, stretched over the part that is played.
    const shareEase = turn.even ? undefined : (u) => turn.progress(u * share) / turn.progress(share);
    at += turnMs * share;
    roll(at, reached, shareEase);
    if (share === 1) {
      roll(at, 0);
      degrees = 0;
    } else {
      degrees = reached;
    }
  }
}

/**
 * @param {import('../clip.js').Start} start
 * @param {{ spinMs?: number, continueFrom?: { roll: number, elapsedMs: number } }} [options]
 *   `spinMs` is how long the spinner turns; the host decides. `continueFrom` makes a clip
 *   that has only the spin, starting at the angle and the working time the last clip ended with.
 */
export function buildWorking(start, { spinMs = DEFAULT_SPIN_MS, continueFrom } = {}) {
  const { roll, lids, lift, form, squash, phase, finish } = createClip();

  if (continueFrom) {
    if (!start.reducedMotion) writeSpin(roll, { from: 0, until: spinMs, angle: continueFrom.roll, elapsed: continueFrom.elapsedMs, opening: false });
    phase('spin', spinMs);
    return finish();
  }

  lids(SHUT_MS, [1, 1], easeInOut);
  lids(SHUT_DONE_MS, [1, 1]);
  lift(SHUT_DONE_MS, [0, 0], easeInOut);
  phase('shut');

  form(SHUT_DONE_MS, 0);
  form(MORPH_DONE_MS, 1, easeInOut);
  squash(SHUT_DONE_MS, [1, 1]);
  squash(SWELL_AT_MS, SWELL, easeOut);
  squash(MORPH_DONE_MS, [1, 1], easeInOut);
  phase('morph');

  if (!start.reducedMotion) {
    roll(SPIN_START_MS, 0);
    writeSpin(roll, { from: SPIN_START_MS, until: SPIN_START_MS + spinMs, angle: 0, elapsed: SPIN_START_MS, opening: true });
  }
  phase('spin', SPIN_START_MS + spinMs);
  return finish();
}

/**
 * @param {import('../clip.js').Start} start
 * @param {{ roll?: number, elapsedMs?: number }} [options]  the angle the spinner is at, and how long Jet has been working
 */
export function buildWorkingEnd(start, { roll: angle = 0, elapsedMs = 0 } = {}) {
  const { roll, form, lids, phase, finish, returnToRest } = createClip();
  returnToRest(start, ['roll', 'form', 'lids']);

  // The spinner always finishes the turn it is on, so a turn is never cut short and never undone.
  // A roll of exactly 360 is already a whole turn: the first key aims at 360 and the second sets 0.
  const turned = angle % 360;
  const left = turned > 0 ? 360 - turned : 0;
  const turnMs = elapsedMs < FAST_UNTIL_MS ? FAST_TURN_MS : SLOW_TURN_MS;
  const finishMs = clamp((FINISH_SLOWDOWN * left) / (360 / turnMs), FINISH_SHORTEST_MS, FINISH_LONGEST_MS);
  roll(finishMs, angle + left, easeOut);
  roll(finishMs, 0);
  form(finishMs, 1);
  phase('finish');

  const unmorphedMs = finishMs + MORPH_MS;
  form(unmorphedMs, 0, easeInOut);
  lids(unmorphedMs, [1, 1]);
  phase('unmorph');

  lids(finishMs + OPEN_OVERSHOOT_AFTER_MS + MORPH_MS, [OPEN_OVERSHOOT, OPEN_OVERSHOOT], easeOut);
  lids(finishMs + OPEN_SETTLED_AFTER_MS + MORPH_MS, [0, 0], easeInOut);
  phase('open');
  return finish();
}
