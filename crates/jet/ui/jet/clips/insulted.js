import { createClip } from '../clip.js';
import { easeInOut, easeOut, pulse, ramp } from '../easing.js';
import { HOVER_Y } from '../parts/forms.js';
import { fistRoute, HAND_SCALE } from '../parts/routes.js';
import { jPose, lyingPose, REST_LENGTH, SEGMENTS } from '../parts/string.js';

const TOTAL_MS = 4800;
const SAMPLE_MS = 10;
const WIND_HZ = [2 / 4.8, 3 / 4.8];
const J = jPose();
const ROUTE = fistRoute();
const PHASES = { idle: 420, simmer: 800, raise: 1860, fist: 2400, clench: 2490, finger: 2720, hold: 3400, unwind: 3740, drop: 4400, relax: 4680, rest: TOTAL_MS };

function body(t) {
  const x = t - 0.46;
  const shiver = t >= 0.46 && t < 0.9 ? 1.6 * Math.sin(2 * Math.PI * 15 * x) * Math.exp(-x / 0.11) : 0;
  return {
    roll: 6 * ramp(t, 0.55, 1.10) * (1 - ramp(t, 4.15, 4.60)) + shiver,
    dy: 1.6 * Math.sin(2 * Math.PI * t / 4.8)
      + 1.6 * pulse(t, 2.32, 2.43, 2.50, easeInOut, easeOut)
      - 3 * pulse(t, 2.45, 2.56, 2.90),
  };
}

function writtenAt(t) {
  const palm = ramp(t, 1.86, 2.40, (u) => 1 - (1 - u) ** 1.8) * ROUTE.palmLength
    - 4 * pulse(t, 2.38, 2.47, 2.52, easeInOut, easeOut);
  const finger = ramp(t, 2.49, 2.72, easeOut) * (ROUTE.totalLength - ROUTE.palmLength);
  const scale = 1 - 0.05 * pulse(t, 2.40, 2.49, 2.55, easeInOut, easeOut)
    + 0.04 * pulse(t, 2.52, 2.62, 2.82);
  return {
    route: ROUTE,
    length: Math.max(0, palm + finger) * (1 - ramp(t, 3.40, 3.92)),
    scale: HAND_SCALE * scale,
    tremor: 0.3 * Math.sin(2 * Math.PI * 9 * t) * pulse(t, 2.80, 2.95, 3.38),
  };
}

/** @param {import('../clip.js').Start} start */
export function buildInsulted(start) {
  const { clip, y, roll, lids, eyeKind, anger, squint, payout, stringPose, written, returnToRest, phase, finish } = createClip();
  returnToRest(start, ['y', 'roll', 'anger', 'squint', 'lids', 'payout', 'stringPose', 'written']);
  written(0, null);
  const grounded = start.reducedMotion;
  const blinks = start.eyeKind !== 'lid' && !start.reducedMotion;
  if (blinks) {
    lids(60, [1, 1], easeInOut);
    eyeKind(60, 'lid');
    lids(100, [1, 1]);
    lids(200, [-0.07, -0.07], easeOut);
    lids(340, [0, 0], easeInOut);
  } else lids(200, [0, 0], easeOut);
  anger(420, 0);
  anger(560, 1, easeOut);
  anger(4400, 1);
  anger(4680, 0, easeInOut);

  // Ten millisecond samples keep the shiver and written stroke deterministic on any host clock.
  for (let ms = SAMPLE_MS; ms <= TOTAL_MS; ms += SAMPLE_MS) {
    const t = ms / 1000;
    const pose = body(t);
    const lift = start.standing ? ramp(t, 0, 0.42) : 1;
    y(ms, grounded ? 0 : (HOVER_Y - pose.dy) * lift);
    roll(ms, pose.roll);
    squint(ms, pulse(t, 2.44, 2.54, 2.95));
    if (ms >= 1860 && ms <= 3920) written(ms, writtenAt(t));
  }
  written(3920, null);
  if (!grounded) {
    if (start.standing) stringPose(0, { ...lyingPose(), raise: { to: 0, lagMs: 0, durationMs: 420, overshoot: 0, order: 'base' } });
    stringPose(800, { ...J, raise: { to: 1, lagMs: 40, durationMs: 480, overshoot: 1.4, order: 'base' } });
    payout(800, 1);
    payout(1280, J.length / REST_LENGTH, easeOut);
    payout(3740, J.length / REST_LENGTH);
    payout(4610, 1, easeInOut);
    stringPose(3740, { ...J, raise: { to: 0, lagMs: 28, durationMs: 450, overshoot: 0.9, order: 'base' } });
    stringPose(4610, null);
  } else {
    stringPose(200, { ...lyingPose(), blend: Array(SEGMENTS).fill(1) });
    payout(200, 1);
  }
  clip.windHz = WIND_HZ;
  for (const [name, end] of Object.entries(PHASES)) phase(name, end);
  return finish({ revealFrom: 'hold' });
}
