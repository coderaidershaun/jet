// Builds the "needs you" clip: Jet stands up and leans toward the user with wide
// eyes, holds the lean while it waits to be noticed, then melts back. A candid Jet
// waits longer and a deferential one leans less far.

import { cubicBezier } from '../easing.js';
import { EYE_OPEN, EYE_POP, startClip } from './beats.js';

/** @typedef {import('../clip.js').Clip & { info: NeedsYouInfo }} NeedsYouClip */

/**
 * @typedef {object} NeedsYouInfo
 * @property {number} lean       how far past the drawn lean pose Jet goes
 * @property {number} holdMs
 * @property {number} tempo
 * @property {number} eyeSize
 * @property {number} shapeAmplitude
 */

const ease = {
  linear: cubicBezier(0, 0, 1, 1),
  pop: cubicBezier(0.1, 0.8, 0.2, 1),
  settle: cubicBezier(0.2, 0.8, 0.4, 1),
  drop: cubicBezier(0.4, 0, 1, 1),
};

const LEAN_IN_MS = 180;
const HOLD_MS = 200;
const CANDID_HOLDS_LONGER_MS = 200;
const SOFT_MS = 130;
const LEAN = 1.2;
const DEFERENTIAL_LEAN = 0.8;

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @returns {NeedsYouClip}
 */
export function buildNeedsYou(rig, p) {
  const c = startClip(rig, p);
  const { ks, x, eyeSize, pose, eyes, hiddenEyes, body, eye, t, tempo, standUp, melt, phase, clip } = c;
  const lean = x <= -0.2 ? DEFERENTIAL_LEAN : LEAN;
  const holdMs = HOLD_MS + (x >= 0.2 ? CANDID_HOLDS_LONGER_MS : 0);

  standUp();
  phase('stand up');

  body(LEAN_IN_MS, pose('lean', lean), ease.settle);
  eye(t(), eyes('lean', EYE_POP, EYE_POP), ease.pop);
  body(holdMs, pose('lean', lean), ease.linear);
  eye(t(), eyes('lean', EYE_OPEN, EYE_OPEN), ease.linear);
  body(SOFT_MS, pose('soft'), ease.settle);
  eye(t(), hiddenEyes('soft'), ease.drop);
  phase('lean');

  melt();
  phase('melt');
  clip.total = t();

  clip.info = { lean, holdMs, tempo, eyeSize, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Lean', value: Math.round(lean * 100) + '%' },
    { label: 'Hold', value: Math.round(holdMs * tempo) + ' ms' },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Eye size', value: eyeSize ? Math.round(eyeSize * 100) + '%' : 'none' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}
