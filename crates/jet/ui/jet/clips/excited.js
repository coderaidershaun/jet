// Builds the "excited" clip: Jet squashes, hops, lands and throws one arm up with a
// squint and a warm flush, then melts back. It is the one clip that uses shape,
// eyes and colour together, so a serious Jet drops the arm and a still one drops the hop.

import { cubicBezier } from '../easing.js';
import { onOff } from '../clip.js';
import { clamp, lerp } from '../maths.js';
import { EYE_OPEN, EYE_POP, EYE_SQUINT, startClip } from './beats.js';

/** @typedef {import('../clip.js').Clip & { info: ExcitedInfo }} ExcitedClip */

/**
 * @typedef {object} ExcitedInfo
 * @property {number} hops
 * @property {number} hopStrength
 * @property {boolean} arm
 * @property {boolean} squint
 * @property {number} warm
 * @property {number} tempo
 * @property {number} shapeAmplitude
 */

const ease = {
  linear: cubicBezier(0, 0, 1, 1),
  drop: cubicBezier(0.4, 0, 1, 1),
  pop: cubicBezier(0.1, 0.8, 0.2, 1),
  fall: cubicBezier(0.5, 0, 1, 1),
  up: cubicBezier(0.2, 0.7, 0.3, 1),
  top: cubicBezier(0.2, 0.8, 0.3, 1),
  down: cubicBezier(0.5, 0, 0.8, 0.6),
  settle: cubicBezier(0.2, 0.8, 0.4, 1),
  inOut: cubicBezier(0.4, 0, 0.6, 1),
  // On a second hop the eyes keep their size as Jet leaves the ground, then pop at the top.
  late: cubicBezier(0.7, 0, 1, 1),
};

const SQUASH_MS = 90;
const HOP_MS = 130;
const LAND_MS = 90;
const SWING_MS = 110;
const PEAK_MS = 130;
const PEAK_HOLD_MS = 150;
const SOFT_MS = 120;
const WARM_AT_PEAK = 0.6;
const SERIOUS_HOP = 0.6;
const EYES_CLOSE_MS = 110;

/**
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 * @returns {ExcitedClip}
 */
export function buildExcited(rig, p) {
  const c = startClip(rig, p);
  const { ks, ke, kc, km, x, y, reduced, eyeSize, circle, pose, eyes, hiddenEyes, body, eye, colour, scale, t, tempo, bounce, standUp, melt, tint, phase, clip } = c;
  const serious = y <= -0.2;
  const hops = reduced || km < 0.3 ? 0 : y > 0.5 ? 2 : 1;
  const hopStrength = serious ? SERIOUS_HOP : 1;
  const arm = !serious;
  const squint = eyeSize > 0 && ke > 0.35 && y > 0.1;
  const warm = WARM_AT_PEAK * kc;
  const reach = clamp(1 + 0.3 * x, 0.7, 1.3);

  const armPose = (name) => lerp(circle, lerp(rig.poses.soft, rig.poses[name], reach), ks);
  const peakEyes = (name) => (squint ? eyes(name, EYE_SQUINT[0], EYE_SQUINT[1]) : eyes(name, EYE_OPEN, EYE_OPEN));

  if (hops === 0) standUp();
  for (let i = 0; i < hops; i++) {
    const first = i === 0;
    body(SQUASH_MS, pose('squash', bounce), ease.drop);
    if (first) {
      eye(t(), hiddenEyes('circle'), ease.drop);
      colour(t(), c.rest, ease.inOut);
      scale(t(), 1);
    } else {
      eye(t(), eyes('land', EYE_OPEN, EYE_OPEN), ease.pop);
    }
    body(HOP_MS, pose('zoom_hop', hopStrength), ease.pop);
    // Eyes appear only once Jet stands, so the first hop lands with no face and the eyes grow in the
    // beat after it. A second hop starts from the ground with the face already there and keeps it.
    eye(t(), first ? hiddenEyes('zoom_hop') : eyes('zoom_hop', EYE_POP, EYE_POP), first ? ease.drop : ease.late);
    body(LAND_MS, pose('land'), ease.fall);
    eye(t(), first ? hiddenEyes('land') : eyes('land', EYE_OPEN, EYE_OPEN), ease.fall);
    scale(t(), 1);
    scale(t() + 50 * tempo, 1 + 0.04 * km * bounce, ease.pop);
    scale(t() + 150 * tempo, 1, ease.settle);
  }
  phase(hops ? 'hop' : 'stand up');

  if (arm) {
    body(SWING_MS, armPose('swing'), ease.up);
    eye(t(), eyes('swing', EYE_OPEN, EYE_OPEN), ease.up);
    body(PEAK_MS, armPose('peak'), ease.top);
    eye(t(), peakEyes('peak'), ease.top);
    colour(t(), tint('warm', warm), ease.inOut);
    body(PEAK_HOLD_MS, armPose('peak'), ease.linear);
    eye(t(), peakEyes('peak'), ease.linear);
    colour(t(), tint('warm', warm), ease.linear);
    body(SOFT_MS, pose('soft'), ease.down);
  } else {
    body(SOFT_MS, pose('soft'), ease.settle);
    eye(t(), eyes('soft', EYE_OPEN, EYE_OPEN), ease.settle);
    colour(t(), tint('warm', warm), ease.inOut);
    body(PEAK_HOLD_MS, pose('soft'), ease.linear);
    colour(t(), tint('warm', warm), ease.linear);
    eye(t() - EYES_CLOSE_MS * tempo, eyes('soft', EYE_OPEN, EYE_OPEN), ease.linear);
  }
  colour(t() + 60 * tempo, c.rest, ease.inOut);
  eye(t(), hiddenEyes('soft'), ease.drop);
  phase('peak');

  melt();
  phase('melt');
  clip.total = t();

  clip.info = { hops, hopStrength, arm, squint, warm, tempo, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Hops', value: String(hops), on: hops > 0 },
    { label: 'Hop height', value: Math.round(hopStrength * 100) + '%', on: hops > 0 },
    { label: 'Arm at the peak', ...onOff(arm) },
    { label: 'Squint at the peak', ...onOff(squint) },
    { label: 'Warms at the peak', value: Math.round(warm * 100) + '%', on: warm > 0.02 },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}
