// The wind takes Jet while the chat is quiet: a small stir on the lane floor, then a slow
// lift to the hover height. The clip ends away from rest on purpose. From then on the
// player adds the wandering and the gusts, scaled by the drift track this clip fades in.

import { createClip } from '../clip.js';
import { cubicBezier, easeInOut, easeOut } from '../easing.js';
import { HOVER_Y } from '../parts/forms.js';
import { lyingPose, SEGMENTS } from '../parts/string.js';

const STIR_END_MS = 900;
const PUSH_AT_MS = 300;
const PUSH_DEGREES = 1.6;
const SWING_BACK_AT_MS = 650;
const SWING_BACK_DEGREES = -0.8;
const BRACE_AT_MS = 760;
const BRACE_SQUASH = [1.045, 0.96];

const LIFT_END_MS = 2900;
const LIFT_PEAK_MS = 2500;
const LIFT_PEAK_Y = 63;
const LIFT_EASE = cubicBezier(0.3, 0, 0.2, 1);
const STRETCH_AT_MS = 1500;
const STRETCH_SQUASH = [0.975, 1.03];
const STRETCH_END_MS = 2300;
const LEAN_AT_MS = 1700;
const LEAN_DEGREES = -2.5;

const BLOW_END_MS = 5400;

// The string lets go base-first, and quickly next to this slow lift, so the part still
// lying does not rise with the kite as a stiff rod.
const RELEASE = { to: 0, lagMs: 45, durationMs: 500, overshoot: 1.2, order: 'base' };

/** @param {import('../clip.js').Start} start  a drift only begins from standing */
export function buildDrift(start) {
  const { y, roll, squash, stringPose, drift, phase, finish, returnToRest } = createClip();
  returnToRest(start, ['y', 'roll', 'squash', 'stringPose', 'drift']);

  roll(PUSH_AT_MS, PUSH_DEGREES, easeOut);
  roll(SWING_BACK_AT_MS, SWING_BACK_DEGREES, easeInOut);
  roll(STIR_END_MS, 0, easeInOut);
  squash(BRACE_AT_MS, BRACE_SQUASH, easeInOut);
  squash(STIR_END_MS, BRACE_SQUASH);
  y(STIR_END_MS, 0);
  phase('stir', STIR_END_MS);

  y(LIFT_PEAK_MS, LIFT_PEAK_Y, LIFT_EASE);
  y(LIFT_END_MS, HOVER_Y, easeInOut);
  squash(STRETCH_AT_MS, STRETCH_SQUASH, easeOut);
  squash(STRETCH_END_MS, [1, 1], easeInOut);
  roll(LEAN_AT_MS, LEAN_DEGREES, easeInOut);
  roll(LIFT_END_MS, 0, easeInOut);
  const lastSegmentFreeMs = STIR_END_MS + (SEGMENTS - 1) * RELEASE.lagMs + RELEASE.durationMs;
  stringPose(STIR_END_MS, { ...lyingPose(), raise: RELEASE });
  stringPose(lastSegmentFreeMs, null);
  drift(LIFT_END_MS, 0);
  phase('lift', LIFT_END_MS);

  drift(BLOW_END_MS, 1, easeInOut);
  y(BLOW_END_MS, HOVER_Y);
  phase('blow', BLOW_END_MS);
  return finish();
}
