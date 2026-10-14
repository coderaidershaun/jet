// Builds the "interrupted" clip, played when the user stops a reply. The working loop
// collapses into the dot under it, Jet waits there, then grows back to the circle.
// There is no face: Jet was stopped, it is not upset.

import { cubicBezier } from '../easing.js';
import { createClip, onOff, readDials } from '../clip.js';
import { RING, RING_HIDDEN } from '../state.js';

/** @typedef {import('../clip.js').Clip & { info: InterruptedInfo }} InterruptedClip */

/**
 * @typedef {object} InterruptedInfo
 * @property {boolean} rebound
 * @property {number} shapeAmplitude
 */

const ease = {
  shrink: cubicBezier(0.4, 0, 0.2, 1),
  linear: cubicBezier(0, 0, 1, 1),
  drop: cubicBezier(0.4, 0, 1, 1),
  pop: cubicBezier(0.1, 0.8, 0.2, 1),
  settle: cubicBezier(0.2, 0.8, 0.4, 1),
  inOut: cubicBezier(0.4, 0, 0.6, 1),
};

const SHRINK_MS = 180;
const HOLD_MS = 380;
const RECOVER_SQUASH_MS = 150;
const RECOVER_REBOUND_MS = 180;
const RECOVER_SETTLE_MS = 190;
// Without the rebound, the same 520 ms are shared by two steps.
const RECOVER_SQUASH_PLAIN_MS = 200;
const RECOVER_SETTLE_PLAIN_MS = 320;

/** The middle of a pose's body, taken as halfway between its head and its foot. */
function centreOf(pose) {
  return [(pose[0] + pose[30]) / 2, (pose[1] + pose[31]) / 2];
}

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @param {{ rotate?: number }} [options]   where the loop is turned to now, so that it shrinks without whipping round
 * @returns {InterruptedClip}
 */
export function buildInterrupted(rig, p, { rotate = 0 } = {}) {
  const { ks, km, reduced, circle, rest, pose, hiddenEyes } = readDials(rig, p);
  const { clip, body, eye, colour, scale, ring, speed, t } = createClip(1);
  const rebound = km >= 0.3 && !reduced;
  const pip = ks > 0 ? rig.poses.pip : circle;
  const [pipX, pipY] = centreOf(rig.poses.pip);
  const collapsed = RING_HIDDEN.slice();
  collapsed[RING.CX] = pipX;
  collapsed[RING.CY] = pipY;
  collapsed[RING.ROTATE] = rotate % 360;
  collapsed[RING.MIX] = 1;

  body(SHRINK_MS, pip, ease.shrink);
  ring(t(), collapsed, ease.shrink);
  eye(t(), hiddenEyes('circle'), ease.drop);
  colour(t(), rest, ease.inOut);
  scale(t(), 1, ease.settle);
  speed(t(), 0, ease.settle);
  clip.phases.push({ name: 'shrink', end: t() });

  body(HOLD_MS, pip, ease.linear);
  clip.phases.push({ name: 'hold', end: t() });

  body(rebound ? RECOVER_SQUASH_MS : RECOVER_SQUASH_PLAIN_MS, pose('squash', 0.8), ease.pop);
  if (rebound) body(RECOVER_REBOUND_MS, pose('rebound', 0.8), ease.pop);
  body(rebound ? RECOVER_SETTLE_MS : RECOVER_SETTLE_PLAIN_MS, circle, ease.settle);
  ring(t(), RING_HIDDEN.slice());
  clip.phases.push({ name: 'recover', end: t() });
  clip.total = t();

  clip.info = { rebound, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Shrinks in', value: SHRINK_MS + ' ms' },
    { label: 'Waits', value: HOLD_MS + ' ms' },
    { label: 'Recovers in', value: Math.round(clip.total - SHRINK_MS - HOLD_MS) + ' ms' },
    { label: 'Rebound', ...onOff(rebound) },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}
