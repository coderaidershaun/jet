// Jet comes down to stand: it rises a little, drops onto its tip, shuts its eyes
// at the touch and squashes, then opens them. After a reply the landing is quick
// and the string starts lying down as soon as its end would reach the floor.
// When the wind had Jet the landing is gentle and starts from wherever Jet is.

import { createClip } from '../clip.js';
import { cubicBezier, easeInOut, easeOut } from '../easing.js';
import { HOVER_Y, kite, TIP } from '../parts/forms.js';
import { FLOOR, lyingPose, REST_LENGTH } from '../parts/string.js';
import { sample } from '../track.js';

// The two landings differ in the approach and in how hard they touch down; the timing after the touch is the same.
const QUICK = {
  riseMs: 160,
  riseBy: 3,
  contactMs: 680,
  descent: cubicBezier(0.45, 0, 0.8, 0.7),
  layMs: null,
  landSquash: [1.087, 0.92],
  reboundSquash: [0.971, 1.03],
};
const GENTLE = {
  riseMs: 220,
  riseBy: 4,
  contactMs: 1400,
  descent: cubicBezier(0.5, 0, 0.45, 1),
  layMs: 700,
  landSquash: [1.05, 0.955],
  reboundSquash: [0.982, 1.018],
};

// Measured from the touch.
const SHUT_BEFORE_MS = 60;
// Held shut long enough that every frame of a slow screen sees the lids closed while the eye kind changes.
const SHUT_UNTIL_MS = 40;
const OPEN_BY_MS = 160;
const OVERSHOOT = -0.07;
const LIDS_OPEN_MS = 300;
const LAND_SQUASH_MS = 80;
const REBOUND_MS = 220;
const LAND_MS = 400;

// The string lies down tip-first: its free end lands first.
const LAY = { to: 1, lagMs: 28, durationMs: 450, overshoot: 0.9, order: 'tip' };

const TIP_PAGE_Y = kite()[TIP][1];

// The first moment the end of the hanging string would touch the floor, found on the clip's own y track.
function stringTouchMs(yTrack, riseMs, contactMs) {
  const touchingY = HOVER_Y - (FLOOR - REST_LENGTH - TIP_PAGE_Y);
  let ms = riseMs;
  while (ms < contactMs && sample(yTrack, ms) > touchingY) ms++;
  return ms;
}

/**
 * @param {import('../clip.js').Start} start
 * @param {{ gentle?: boolean, fromY?: number }} [options]  a gentle landing rises from `fromY`, where Jet is now
 */
export function buildSettle(start, { gentle = false, fromY = HOVER_Y } = {}) {
  const tempo = gentle ? GENTLE : QUICK;
  const { riseMs, contactMs } = tempo;
  const { clip, y, squash, lids, eyeKind, anger, stringPose, drift, phase, finish, returnToRest } = createClip();
  returnToRest(start, ['y', 'anger', 'stringPose', 'drift']);

  y(riseMs, (gentle ? fromY : HOVER_Y) + tempo.riseBy, easeOut);
  phase('rise', riseMs);
  y(contactMs, 0, tempo.descent);
  drift(contactMs, 0, easeInOut);
  phase('descend', contactMs);

  lids(contactMs - SHUT_BEFORE_MS, [0, 0]);
  lids(contactMs, [1, 1], easeInOut);
  eyeKind(contactMs, 'round');
  anger(contactMs, 0);
  lids(contactMs + SHUT_UNTIL_MS, [1, 1]);
  lids(contactMs + OPEN_BY_MS, [OVERSHOOT, OVERSHOOT], easeOut);
  lids(contactMs + LIDS_OPEN_MS, [0, 0], easeInOut);

  squash(contactMs, [1, 1]);
  squash(contactMs + LAND_SQUASH_MS, tempo.landSquash, easeOut);
  squash(contactMs + REBOUND_MS, tempo.reboundSquash, easeInOut);
  squash(contactMs + LAND_MS, [1, 1], easeInOut);

  // A gentle landing cannot search the y track: the fading wander can hold the drawn kite far above it.
  const layAt = tempo.layMs ?? stringTouchMs(clip.y, riseMs, contactMs);
  stringPose(layAt, { ...lyingPose(), raise: LAY });
  phase('land', contactMs + LAND_MS);
  return finish();
}
