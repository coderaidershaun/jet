// Builds the "annoyed" clip: Jet stands up, narrows its eyes and flushes red for a beat,
// then bows and melts back. How far it goes depends on how candid the wheel is. A
// centred or deferential Jet only bows: no glare, no red and no narrowed eyes. Jet
// is never annoyed with panic, so there is no shake.

import { cubicBezier } from '../easing.js';
import { onOff } from '../clip.js';
import { lerp } from '../maths.js';
import { EYE_NARROW, EYE_OPEN, startClip } from './beats.js';

/** @typedef {import('../clip.js').Clip & { info: AnnoyedInfo }} AnnoyedClip */

/**
 * @typedef {object} AnnoyedInfo
 * @property {number} annoyance   0..1, how much of the glare shows
 * @property {boolean} narrowed
 * @property {number} tint        how far the body flushes toward the alert colour
 * @property {number} bow
 * @property {number} tempo
 * @property {number} shapeAmplitude
 */

const ease = {
  linear: cubicBezier(0, 0, 1, 1),
  settle: cubicBezier(0.2, 0.8, 0.4, 1),
  inOut: cubicBezier(0.4, 0, 0.6, 1),
  drop: cubicBezier(0.4, 0, 1, 1),
  glare: cubicBezier(0.3, 0, 0.5, 1),
};

const GLARE_MS = 160;
const GLARE_HOLD_MS = 160;
const BOW_MS = 200;
const RETURN_MS = 120;
const TINT_AT_GLARE = 0.4;
// Below this much annoyance the glare is too slight to narrow the eyes or to move them where the glare puts them.
const GLARE_SHOWS_ABOVE = 0.2;
const PLAIN_BOW = 0.7;

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @returns {AnnoyedClip}
 */
export function buildAnnoyed(rig, p) {
  const c = startClip(rig, p);
  const { ks, ke, kc, x, circle, eyes, hiddenEyes, pose, body, eye, colour, t, tempo, standUp, melt, bow, tint, phase, clip } = c;
  const annoyance = Math.max(0, x);
  const narrowed = c.eyeSize > 0 && ke > 0.35 && annoyance > GLARE_SHOWS_ABOVE;
  const flush = TINT_AT_GLARE * kc * annoyance;
  const bowAmount = PLAIN_BOW + 0.3 * Math.max(0, -x);
  const eyeRow = annoyance > GLARE_SHOWS_ABOVE ? 'glare' : 'land';
  const glareEyes = narrowed ? eyes('glare', EYE_NARROW[0], EYE_NARROW[1]) : eyes(eyeRow, EYE_OPEN, EYE_OPEN);

  standUp();
  phase('stand up');

  body(GLARE_MS, lerp(circle, lerp(rig.poses.land, rig.poses.glare, annoyance), ks), ease.glare);
  eye(t(), glareEyes, ease.glare);
  colour(t(), tint('alert', flush), ease.inOut);
  body(GLARE_HOLD_MS, lerp(circle, lerp(rig.poses.land, rig.poses.glare, annoyance), ks), ease.linear);
  eye(t(), glareEyes, ease.linear);
  colour(t(), tint('alert', flush), ease.linear);
  phase('glare');

  body(BOW_MS, bow(bowAmount), ease.inOut);
  eye(t(), eyes('bow', EYE_OPEN, EYE_OPEN), ease.inOut);
  colour(t(), c.rest, ease.inOut);
  body(RETURN_MS, pose('soft'), ease.settle);
  eye(t(), hiddenEyes('soft'), ease.drop);
  phase('bow');

  melt();
  phase('melt');
  clip.total = t();

  clip.info = { annoyance, narrowed, tint: flush, bow: bowAmount, tempo, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Annoyance', value: Math.round(annoyance * 100) + '%', on: annoyance > GLARE_SHOWS_ABOVE },
    { label: 'Narrowed eyes', ...onOff(narrowed) },
    { label: 'Flushes red', value: Math.round(flush * 100) + '%', on: flush > 0.02 },
    { label: 'Bow', value: Math.round(bowAmount * 100) + '%' },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}
