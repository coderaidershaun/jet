// Builds the "error" clip. Jet is calm about it: it stretches up for a beat (the "!") and
// takes on a little red, then bows and goes grey, then melts back. The apologetic version
// (`exclaim: false`) skips the stretch and only bows. A failure is a bow, never a shake.

import { cubicBezier } from '../easing.js';
import { onOff } from '../clip.js';
import { startClip } from './beats.js';

/** @typedef {import('../clip.js').Clip & { info: ErrorInfo }} ErrorClip */

/**
 * @typedef {object} ErrorInfo
 * @property {boolean} exclaim
 * @property {number} stretch    1 is the stretch pose as drawn; 0 when there is no exclamation
 * @property {number} tint       how far the body reddens and then goes grey; the apologetic version only goes grey
 * @property {number} tempo
 * @property {number} shapeAmplitude
 */

const ease = {
  linear: cubicBezier(0, 0, 1, 1),
  drop: cubicBezier(0.4, 0, 1, 1),
  pop: cubicBezier(0.1, 0.8, 0.2, 1),
  land: cubicBezier(0.2, 0.8, 0.3, 1),
  inOut: cubicBezier(0.4, 0, 0.6, 1),
};

const SQUASH_MS = 90;
const STRETCH_MS = 140;
const EXCLAIM_HOLD_MS = 220;
const SORRY_LAND_MS = 160;
const BOW_MS = 240;
const BOW_HOLD_MS = 280;
const TINT = 0.25;
const STRETCH = 1.15;
// A serious Jet does not overshoot the stretch pose.
const SERIOUS_STRETCH = 1;

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @param {{ exclaim?: boolean }} [options]   false makes the apologetic version, with no "!"
 * @returns {ErrorClip}
 */
export function buildError(rig, p, { exclaim = true } = {}) {
  const c = startClip(rig, p);
  const { ks, kc, km, y, reduced, rest, pose, hiddenEyes, body, eye, colour, scale, t, tempo, bounce, melt, tint, phase, clip } = c;
  const stretch = y <= -0.2 ? SERIOUS_STRETCH : STRETCH;
  const tintAmount = TINT * kc;

  if (exclaim) {
    if (km > 0.2 && !reduced) {
      body(SQUASH_MS, pose('squash', 0.5 * bounce), ease.drop);
      eye(t(), hiddenEyes('circle'), ease.drop);
      colour(t(), rest, ease.inOut);
      scale(t(), 1);
      body(STRETCH_MS, pose('stretch', stretch), ease.pop);
    } else {
      body(STRETCH_MS, pose('stretch', stretch), ease.pop);
      eye(t(), hiddenEyes('circle'), ease.drop);
      scale(t(), 1);
    }
    colour(t(), tint('alert', tintAmount), ease.inOut);
    body(EXCLAIM_HOLD_MS, pose('stretch', stretch), ease.linear);
    colour(t(), tint('alert', tintAmount), ease.linear);
    phase('exclaim');
  } else {
    body(SORRY_LAND_MS, pose('land'), ease.land);
    eye(t(), hiddenEyes('circle'), ease.drop);
    colour(t(), rest, ease.inOut);
    scale(t(), 1);
    phase('stand up');
  }

  body(BOW_MS, pose('bow'), ease.inOut);
  colour(t(), tint('muted', tintAmount), ease.inOut);
  body(BOW_HOLD_MS, pose('bow'), ease.linear);
  colour(t(), tint('muted', tintAmount), ease.linear);
  phase('bow');

  melt();
  phase('melt');
  clip.total = t();

  clip.info = { exclaim, stretch: exclaim ? stretch : 0, tint: tintAmount, tempo, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Exclaims', ...onOff(exclaim) },
    { label: 'Stretch', value: exclaim ? Math.round(stretch * 100) + '%' : 'off', on: exclaim },
    { label: 'Reddens', value: exclaim ? Math.round(tintAmount * 100) + '%' : 'off', on: exclaim && tintAmount > 0.02 },
    { label: 'Goes grey', value: Math.round(tintAmount * 100) + '%', on: tintAmount > 0.02 },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}
