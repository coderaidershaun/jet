// Jet comes down to stand at the end of a reply: it rises a little, drops onto
// its tip, shuts its eyes at the touch and squashes, then opens them. The
// string starts lying down as soon as its end would reach the floor.

import { createClip } from '../clip.js';
import { cubicBezier, easeInOut, easeOut } from '../easing.js';
import { HOVER_Y, kite, TIP } from '../parts/forms.js';
import { FLOOR, lyingPose, REST_LENGTH } from '../parts/string.js';
import { sample } from '../track.js';

const RISE_MS = 160;
const RISE_Y = HOVER_Y + 3;
const CONTACT_MS = 680;
const DESCENT_EASE = cubicBezier(0.45, 0, 0.8, 0.7);

const SHUT_FROM_MS = 620;
// Held shut long enough that every frame of a slow screen sees the lids closed while the eye kind changes.
const SHUT_UNTIL_MS = 720;
const OPEN_BY_MS = 840;
const OVERSHOOT = -0.07;
const LIDS_OPEN_MS = 980;

const LAND_SQUASH = [1.087, 0.92];
const LAND_SQUASH_MS = 760;
const REBOUND_SQUASH = [0.971, 1.03];
const REBOUND_MS = 900;
const TOTAL_MS = 1080;

// The string lies down tip-first: its free end lands first.
const LAY = { to: 1, lagMs: 28, durationMs: 450, overshoot: 0.9, order: 'tip' };

const TIP_PAGE_Y = kite()[TIP][1];

// The first moment the end of the hanging string would touch the floor, found on the clip's own y track.
function stringTouchMs(yTrack) {
  const touchingY = HOVER_Y - (FLOOR - REST_LENGTH - TIP_PAGE_Y);
  let ms = RISE_MS;
  while (ms < CONTACT_MS && sample(yTrack, ms) > touchingY) ms++;
  return ms;
}

/** @param {import('../clip.js').Start} start */
export function buildSettle(start) {
  const { clip, y, squash, lids, eyeKind, anger, stringPose, phase, finish, returnToRest } = createClip();
  returnToRest(start, ['y']);

  y(RISE_MS, RISE_Y, easeOut);
  phase('rise', RISE_MS);
  y(CONTACT_MS, 0, DESCENT_EASE);
  phase('descend', CONTACT_MS);

  lids(SHUT_FROM_MS, [0, 0]);
  lids(CONTACT_MS, [1, 1], easeInOut);
  eyeKind(CONTACT_MS, 'round');
  anger(CONTACT_MS, 0);
  lids(SHUT_UNTIL_MS, [1, 1]);
  lids(OPEN_BY_MS, [OVERSHOOT, OVERSHOOT], easeOut);
  lids(LIDS_OPEN_MS, [0, 0], easeInOut);

  squash(CONTACT_MS, [1, 1]);
  squash(LAND_SQUASH_MS, LAND_SQUASH, easeOut);
  squash(REBOUND_MS, REBOUND_SQUASH, easeInOut);
  squash(TOTAL_MS, [1, 1], easeInOut);

  stringPose(stringTouchMs(clip.y), { ...lyingPose(), raise: LAY });
  phase('land', TOTAL_MS);
  return finish();
}
