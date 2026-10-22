// The wave: the kite lifts its right corner, wags it three times and drops it
// past rest, while the body rolls a little the other way. Only the corner and
// one wink are written here; the roll, the stretch and the squint of the
// other eye are the player's answer to them.

import { createClip } from '../clip.js';
import { easeInOut, easeOut } from '../easing.js';

// [ms, degrees the right corner is lifted]. There is no key at 0: the wave starts from wherever
// the corner is, so one that was already lifted eases into the dip instead of snapping to 0.
const KEYS = [[180, -6], [500, 30], [650, 26], [900, 33], [1150, 19], [1400, 33], [1650, 19], [1900, 31], [2300, -3], [2550, 0]];
const BRIEF_KEYS = [...KEYS.slice(0, 5), [1450, -3], [1650, 0]];
const LIFT_PEAK_MS = 500;

// The lid shuts fast, holds, then opens slower with a small overshoot. Each row is [ms, closure, easing].
const WINK = [[920, 0], [1000, 1, easeInOut], [1300, 1], [1460, -0.07, easeOut], [1600, 0, easeInOut]];
const BLINK = [[60, 1, easeInOut], [100, 1], [200, -0.07, easeOut], [340, 0, easeInOut]];
const EYE_SWAP_MS = 60;

const PHASES = { dip: 180, lift: 650, wag: 1900, drop: 2300, rest: 2550 };
const BRIEF_PHASES = { dip: 180, lift: 650, wag: 1150, drop: 1450, rest: 1650 };

/**
 * @param {import('../clip.js').Start} start
 * @param {{ brief?: boolean }} [options]  a brief wave is one wag with no wink
 */
export function buildHello(start, { brief = false } = {}) {
  const { lift, lids, eyeKind, anger, phase, finish, returnToRest } = createClip();
  // The eyes swap to the lid shape under a blink, unless they already are lid eyes.
  const blinks = start.eyeKind !== 'lid';
  returnToRest(start, blinks ? ['lift', 'lids', 'anger'] : ['lift']);

  for (const [ms, degrees] of brief ? BRIEF_KEYS : KEYS) lift(ms, [0, degrees], ms === LIFT_PEAK_MS ? easeOut : easeInOut);
  if (blinks) {
    for (const [ms, closure, ease] of BLINK) lids(ms, [closure, closure], ease);
    eyeKind(EYE_SWAP_MS, 'lid');
    anger(EYE_SWAP_MS, 0);
  }
  if (!brief) for (const [ms, closure, ease] of WINK) lids(ms, [0, closure], ease);

  for (const [name, end] of Object.entries(brief ? BRIEF_PHASES : PHASES)) phase(name, end);
  return finish({ revealFrom: 'wag' });
}
