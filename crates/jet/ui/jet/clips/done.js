// Builds the "done" clip. The quick one, played after every reply, is only a squash and
// a settle with no face, so that it never gets in the way. The long one, played after a
// job that took a while, adds a small hop, a smile and a touch of warmth.

import { cubicBezier } from '../easing.js';
import { onOff } from '../clip.js';
import { EYE_OPEN, EYE_SQUINT, startClip } from './beats.js';

/** @typedef {import('../clip.js').Clip & { info: DoneInfo }} DoneClip */

/**
 * @typedef {object} DoneInfo
 * @property {boolean} long
 * @property {boolean} hop
 * @property {boolean} smile
 * @property {boolean} squint
 * @property {number} warm
 * @property {number} bow
 * @property {number} tempo
 * @property {number} shapeAmplitude
 */

const ease = {
  linear: cubicBezier(0, 0, 1, 1),
  drop: cubicBezier(0.4, 0, 1, 1),
  pop: cubicBezier(0.1, 0.8, 0.2, 1),
  fall: cubicBezier(0.5, 0, 1, 1),
  land: cubicBezier(0.2, 0.8, 0.3, 1),
  settle: cubicBezier(0.2, 0.8, 0.4, 1),
  inOut: cubicBezier(0.4, 0, 0.6, 1),
};

const QUICK_SQUASH_MS = 120;
const QUICK_REBOUND_MS = 110;
const QUICK_SETTLE_MS = 220;
const QUICK_SETTLE_PLAIN_MS = 300;
const SQUASH_MS = 100;
const HOP_MS = 130;
const LAND_MS = 90;
const SOFT_MS = 120;
const SMILE_HOLD_MS = 160;
const BOW_IN_MS = 180;
const BOW_OUT_MS = 140;
const WARM_AT_SMILE = 0.3;
const DEFERENTIAL_BOW = 0.4;
const EYES_CLOSE_MS = 110;

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @param {{ long?: boolean }} [options]   the long clip is for a job that took a while
 * @returns {DoneClip}
 */
export function buildDone(rig, p, { long = false } = {}) {
  const c = startClip(rig, p);
  const { ks, ke, kc, km, x, y, reduced, eyeSize, circle, rest, pose, eyes, hiddenEyes, body, eye, colour, scale, t, tempo, bounce, melt, bow, tint, phase, clip } = c;
  const hop = long && y > -0.2 && km >= 0.3 && !reduced;
  const squint = eyeSize > 0 && ke > 0.35 && y > 0.1;
  const warm = long ? WARM_AT_SMILE * kc : 0;
  const bowAmount = long && x <= -0.2 ? DEFERENTIAL_BOW : 0;
  const rebound = km >= 0.3 && !reduced;
  const smileEyes = (name) => (squint ? eyes(name, EYE_SQUINT[0], EYE_SQUINT[1]) : eyes(name, EYE_OPEN, EYE_OPEN));

  if (!long) {
    body(QUICK_SQUASH_MS, pose('squash', 0.8 * bounce), ease.drop);
    eye(t(), hiddenEyes('circle'), ease.drop);
    colour(t(), rest, ease.inOut);
    scale(t(), 1);
    if (rebound) body(QUICK_REBOUND_MS, pose('rebound', 0.5), ease.pop);
    body(rebound ? QUICK_SETTLE_MS : QUICK_SETTLE_PLAIN_MS, circle, ease.settle);
    phase('settle');
    clip.total = t();
  } else {
    body(SQUASH_MS, pose('squash', 0.9 * bounce), ease.drop);
    eye(t(), hiddenEyes('circle'), ease.drop);
    colour(t(), rest, ease.inOut);
    scale(t(), 1);
    if (hop) body(HOP_MS, pose('zoom_hop', 0.5), ease.pop);
    body(LAND_MS, pose('land'), ease.fall);
    eye(t(), hiddenEyes('land'), ease.fall);
    phase('hop');

    body(SOFT_MS, pose('soft'), ease.land);
    eye(t(), smileEyes('soft'), ease.pop);
    colour(t(), tint('warm', warm), ease.inOut);
    body(SMILE_HOLD_MS, pose('soft'), ease.linear);
    colour(t(), tint('warm', warm), ease.linear);
    if (bowAmount > 0) {
      body(BOW_IN_MS, bow(bowAmount), ease.inOut);
      eye(t(), eyes('bow', EYE_OPEN, EYE_OPEN), ease.inOut);
      body(BOW_OUT_MS, pose('soft'), ease.inOut);
    } else {
      eye(t() - EYES_CLOSE_MS * tempo, smileEyes('soft'), ease.linear);
    }
    eye(t(), hiddenEyes('soft'), ease.drop);
    phase('smile');

    melt();
    phase('melt');
    clip.total = t();
  }

  clip.info = { long, hop, smile: long && eyeSize > 0, squint: long && squint, warm, bow: bowAmount, tempo, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Long version', ...onOff(long) },
    { label: 'Hop', ...onOff(hop) },
    { label: 'Smile', ...onOff(long && eyeSize > 0) },
    { label: 'Warms', value: Math.round(warm * 100) + '%', on: warm > 0.02 },
    { label: 'Bow', value: bowAmount ? Math.round(bowAmount * 100) + '%' : 'off', on: bowAmount > 0 },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}
