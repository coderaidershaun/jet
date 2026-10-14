// Builds the "thinking" clip: Jet stands up, tilts its head up and to one side as if
// working something out, blinks once slowly, and melts back. It is a mood, so the
// tempo follows the wheel, but it adds no colour.

import { cubicBezier } from '../easing.js';
import { onOff } from '../clip.js';
import { EYE_BLINK, EYE_OPEN, startClip } from './beats.js';

/** @typedef {import('../clip.js').Clip & { info: ThinkingInfo }} ThinkingClip */

/**
 * @typedef {object} ThinkingInfo
 * @property {number} holdMs   how long the pondering pose is held, before the tempo scales it
 * @property {boolean} sway
 * @property {boolean} blink
 * @property {number} tempo
 * @property {number} eyeSize
 * @property {number} shapeAmplitude
 */

const ease = {
  linear: cubicBezier(0, 0, 1, 1),
  settle: cubicBezier(0.2, 0.8, 0.4, 1),
  inOut: cubicBezier(0.4, 0, 0.6, 1),
  drop: cubicBezier(0.4, 0, 1, 1),
};

const PONDER_MS = 150;
const HOLD_MS = 900;
// A serious Jet thinks for less time: the hold falls by this much at the serious end of the wheel.
const SERIOUS_SHORTENS_HOLD_MS = 300;
const SWAY = 0.03;
const BLINK_MS = 240;
const SOFT_MS = 110;

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @returns {ThinkingClip}
 */
export function buildThinking(rig, p) {
  const c = startClip(rig, p);
  const { ks, km, y, reduced, eyeSize, pose, eyes, hiddenEyes, body, eye, t, tempo, standUp, melt, phase, clip } = c;
  const holdMs = HOLD_MS + SERIOUS_SHORTENS_HOLD_MS * Math.min(0, y);
  const sway = km >= 0.3 && !reduced;
  const blink = eyeSize > 0 && !reduced;

  standUp();
  phase('stand up');

  body(PONDER_MS, pose('ponder'), ease.settle);
  eye(t(), eyes('ponder', EYE_OPEN, EYE_OPEN), ease.settle);
  const holdStart = t();
  if (sway) {
    body(holdMs / 2, pose('ponder', 1 + SWAY), ease.inOut);
    body(holdMs / 2, pose('ponder'), ease.inOut);
  } else {
    body(holdMs, pose('ponder'), ease.linear);
  }
  if (blink) {
    const middle = (holdStart + t()) / 2;
    eye(middle - (BLINK_MS / 2) * tempo, eyes('ponder', EYE_OPEN, EYE_OPEN), ease.linear);
    eye(middle, eyes('ponder', EYE_OPEN, EYE_BLINK), ease.linear);
    eye(middle + (BLINK_MS / 2) * tempo, eyes('ponder', EYE_OPEN, EYE_OPEN), ease.linear);
  }
  eye(t(), eyes('ponder', EYE_OPEN, EYE_OPEN), ease.linear);

  body(SOFT_MS, pose('soft'), ease.settle);
  eye(t(), hiddenEyes('soft'), ease.drop);
  phase('ponder');

  melt();
  phase('melt');
  clip.total = t();

  clip.info = { holdMs, sway, blink, tempo, eyeSize, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Hold', value: Math.round(holdMs * tempo) + ' ms' },
    { label: 'Sway', ...onOff(sway) },
    { label: 'Slow blink', ...onOff(blink) },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Eye size', value: eyeSize ? Math.round(eyeSize * 100) + '%' : 'none' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}
