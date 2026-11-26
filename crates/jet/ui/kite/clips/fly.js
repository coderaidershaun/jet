// Jet takes off to follow its reply: it crouches, springs up past its hover
// height, cruises while the page carries it along, then brakes. The lean into
// the cruise is the player's, not written here.

import { createClip } from '../clip.js';
import { cubicBezier, easeInOut, easeOut } from '../easing.js';
import { HOVER_Y } from '../parts/forms.js';
import { SEGMENTS } from '../parts/string.js';

const CROUCH_MS = 140;
const ANTICIPATE_MS = 180;
const CROUCH_SQUASH = [1.087, 0.92];
const HOVER_DIP = 4;

const LAUNCH_END_MS = 500;
const LAUNCH_Y = 64;
const LAUNCH_EASE = cubicBezier(0.2, 0.8, 0.3, 1);
const STRETCH_AT_MS = 280;
const STRETCH_SQUASH = [0.95, 1.053];

// The cruise opens with the ease down from the top of the launch to the hover height.
const EASE_DOWN_MS = 220;

const BRAKE_PEAK_MS = 160;
const BRAKE_MS = 400;
const BRAKE_SQUASH = [1.04, 0.962];

// The string lets go base-first, one segment after another.
const RELEASE = { to: 0, lagMs: 40, durationMs: 300, overshoot: 1.4, order: 'base' };

/**
 * @param {import('../clip.js').Start} start
 * @param {{ cruiseMs: number }} options  how long the host carries Jet; at least the ease down
 */
export function buildFly(start, { cruiseMs } = {}) {
  const { y, squash, stringPose, drift, phase, finish, returnToRest } = createClip();
  returnToRest(start, ['y', 'squash', 'stringPose', 'drift']);
  const cruiseEnd = LAUNCH_END_MS + Math.max(cruiseMs, EASE_DOWN_MS);

  // From standing the whole body crouches; from a hover it only dips.
  const crouchSquash = start.standing ? CROUCH_SQUASH : [1, 1];
  const crouchY = start.standing ? 0 : HOVER_Y - HOVER_DIP;
  y(CROUCH_MS, crouchY, easeInOut);
  y(ANTICIPATE_MS, crouchY);
  squash(CROUCH_MS, crouchSquash, easeInOut);
  squash(ANTICIPATE_MS, crouchSquash);
  phase('anticipate', ANTICIPATE_MS);

  y(LAUNCH_END_MS, LAUNCH_Y, LAUNCH_EASE);
  squash(STRETCH_AT_MS, STRETCH_SQUASH, easeOut);
  squash(LAUNCH_END_MS, [1, 1], easeInOut);
  // Jet that was blown about loses the wind through the launch instead of snapping out of it.
  drift(LAUNCH_END_MS, 0, easeInOut);
  phase('launch', LAUNCH_END_MS);

  y(LAUNCH_END_MS + EASE_DOWN_MS, HOVER_Y, easeInOut);
  y(cruiseEnd, HOVER_Y);
  squash(cruiseEnd, [1, 1]);
  phase('cruise', cruiseEnd);

  squash(cruiseEnd + BRAKE_PEAK_MS, BRAKE_SQUASH, easeOut);
  squash(cruiseEnd + BRAKE_MS, [1, 1], easeInOut);
  phase('brake', cruiseEnd + BRAKE_MS);

  // No angles: the string lets go of whatever pose it holds, so a send never snaps it into another shape.
  const lastSegmentFreeMs = ANTICIPATE_MS + (SEGMENTS - 1) * RELEASE.lagMs + RELEASE.durationMs;
  stringPose(ANTICIPATE_MS, { raise: RELEASE });
  stringPose(lastSegmentFreeMs, null);
  return finish();
}
