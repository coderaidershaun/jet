// The short clips Jet plays as a message goes out, before it travels: a salute, a nod,
// a blink or a hop. Each is over within 350 ms, because the take-off waits for it.

import { createClip, onOff, readDials } from '../clip.js';
import { cubicBezier } from '../easing.js';
import { clamp, lerp } from '../maths.js';
import { RING_HIDDEN } from '../state.js';
import { EYE_BLINK, EYE_OPEN } from './beats.js';

const ease = {
  linear: cubicBezier(0, 0, 1, 1),
  drop: cubicBezier(0.4, 0, 1, 1),
  pop: cubicBezier(0.1, 0.8, 0.2, 1),
  fall: cubicBezier(0.5, 0, 1, 1),
  land: cubicBezier(0.2, 0.8, 0.3, 1),
  inOut: cubicBezier(0.4, 0, 0.6, 1),
  up: cubicBezier(0.2, 0.7, 0.3, 1),
  settle: cubicBezier(0.2, 0.8, 0.4, 1),
  melt: cubicBezier(0.5, 0, 0.9, 0.6),
};

// Earlier than in the mood clips, because the shortest send reaction is over in about 200 ms
// and the ground must be still by then.
const GROUND_CLEAR_MS = 150;
const FAINT_EYE_SIZE = 2.2;
// The faint eyes shrink away this long before the end, because a clip ends with no eye size
// and the player grows them back at rest.
const FAINT_EYES_OUT_MS = 50;

const SALUTE_DIP_MS = 30;
const SALUTE_SNAP_MS = 120;
const SALUTE_PEAK_MS = 90;
const SALUTE_BOW_MS = 50;
const SALUTE_PUDDLE_MS = 60;
const SALUTE_MELT_MS = 110;
const SALUTE_FACE_CLOSES_MS = 50;
// This much of the squash is about 10% lower than the circle at full shape.
const SALUTE_DIP = 0.4;

const NOD_DIP_MS = 100;
const NOD_REBOUND_MS = 70;
const NOD_SETTLE_MS = 140;
// This much of the squash is 0.92 of the circle's height and a little wider at full shape.
const NOD_DIP = 0.32;
const NOD_REBOUND = 0.15;

const BLINK_STAND_MS = 70;
const BLINK_MS = 170;
// Each blink key's time from the end of the stand. The eyes stay open for a moment between
// the two blinks, so that at sixty frames a second they read as two and not as one flicker.
const DOUBLE_BLINK = [
  { at: 40, shut: true },
  { at: 80, shut: false },
  { at: 100, shut: false },
  { at: 135, shut: true },
  { at: 170, shut: false },
];
const BLINK_PUDDLE_MS = 35;
const BLINK_MELT_MS = 60;
const BLINK_FACE_CLOSES_MS = 40;

const HOP_CROUCH_MS = 70;
const HOP_MS = 90;
const HOP_IMPACT_MS = 50;
const HOP_LAND_MS = 120;
const HOP_LIFT = 0.5;

/**
 * Reads the dials and makes the empty clip for a send reaction, with the ground already
 * cleared. `faintEyes(name, k)` places the circle's faint eyes on a pose blended by `k`, as
 * `pose(name, k)` blends the body. `phase(name)` closes a phase at the time the body has reached.
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 */
function startReaction(rig, p) {
  const dials = readDials(rig, p);
  const { km, y } = dials;
  // Playful quickens a send reaction, but serious does not slow it, because the take-off waits for it.
  const tempo = clamp(1 - 0.15 * y, 0.85, 1);
  // SMELL: the shared mood beats and the hello clip work out this squash size the same way, and the
  // copies can drift apart.
  const bounce = clamp(1 + 0.5 * y, 0.6, 1.3) * (0.45 + 0.55 * km);
  const writers = createClip(tempo);
  const { clip, ring, speed, t } = writers;
  ring(GROUND_CLEAR_MS, RING_HIDDEN.slice(), ease.inOut);
  speed(GROUND_CLEAR_MS, 0, ease.settle);
  const phase = (name) => clip.phases.push({ name, end: t() });
  // SMELL: this belongs beside eyes() and hiddenEyes() in the shared dials, and FAINT_EYE_SIZE copies the size the
  // player gives the faint eyes at rest; if the two differ, the faint eyes jump in size as a send reaction starts.
  const faintEyes = (name, k = 1) => {
    const size = FAINT_EYE_SIZE * dials.eyeSize;
    return [...lerp(rig.eyes.circle, rig.eyes[name], k * dials.ks), size, size, 1];
  };
  return { ...dials, ...writers, tempo, bounce, faintEyes, phase };
}

/**
 * The salute: Jet snaps a hand to its brow, holds it a beat and melts back. Candid
 * raises the hand higher, and deferential adds a small bow on the way down.
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 */
export function buildSalute(rig, p) {
  const { ks, km, x, reduced, rest, circle, pose, eyes, hiddenEyes, clip, body, eye, colour, scale, t, tempo, bounce, faintEyes, phase } = startReaction(rig, p);
  const reach = clamp(1 + 0.3 * x, 0.7, 1.3);
  const bow = x <= -0.2 ? 0.5 * -x : 0;
  const dip = km > 0.2 && !reduced;
  const puddle = km >= 0.3 && !reduced;
  // The reach is applied from the standing pose before the shape dial, so a candid Jet raises
  // the hand past the drawn salute while shape 0 still stays a circle.
  const arm = lerp(circle, lerp(rig.poses.soft, rig.poses.salute, reach), ks);

  if (dip) {
    body(SALUTE_DIP_MS, pose('squash', SALUTE_DIP), ease.drop);
    eye(t(), faintEyes('squash', SALUTE_DIP), ease.drop);
    colour(t(), rest, ease.inOut);
    scale(t(), 1);
    body(SALUTE_SNAP_MS - SALUTE_DIP_MS, arm, ease.up);
  } else {
    body(SALUTE_SNAP_MS, arm, ease.up);
    colour(t(), rest, ease.inOut);
    scale(t(), 1);
  }
  eye(t(), eyes('salute', EYE_OPEN, EYE_OPEN), ease.pop);
  phase('snap');

  body(SALUTE_PEAK_MS, arm, ease.linear);
  eye(t(), eyes('salute', EYE_OPEN, EYE_OPEN), ease.linear);
  phase('peak');

  // The face closes early in the melt, because a face in ink must never show on a body that is nearly round.
  eye(t() + SALUTE_FACE_CLOSES_MS * tempo, hiddenEyes('salute'), ease.settle);
  if (bow > 0) {
    body(SALUTE_BOW_MS, lerp(pose('soft'), pose('bow'), bow), ease.drop);
    body(SALUTE_MELT_MS - SALUTE_BOW_MS, circle, ease.settle);
  } else if (puddle) {
    body(SALUTE_PUDDLE_MS, pose('puddle', 0.5 * Math.min(1, bounce)), ease.melt);
    body(SALUTE_MELT_MS - SALUTE_PUDDLE_MS, circle, ease.settle);
  } else {
    body(SALUTE_MELT_MS, circle, ease.inOut);
  }
  eye(t(), hiddenEyes('circle'));
  phase('melt');
  clip.total = t();

  clip.info = { reach, bow, dip, tempo, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Arm reach', value: Math.round(reach * 100) + '%' },
    { label: 'Anticipation dip', ...onOff(dip) },
    { label: 'Bow on the way down', value: bow > 0 ? Math.round(bow * 100) + '%' : 'off', on: bow > 0 },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}

/**
 * The nod: a quick dip of the whole body, wider as it goes lower, and back. The faint eyes
 * ride it down and up; they never become a face.
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 */
export function buildNod(rig, p) {
  const { ks, km, reduced, rest, circle, pose, hiddenEyes, clip, body, eye, colour, scale, t, tempo, faintEyes, phase } = startReaction(rig, p);
  const rebound = km >= 0.3 && !reduced;

  body(NOD_DIP_MS, pose('squash', NOD_DIP), ease.drop);
  eye(t(), faintEyes('squash', NOD_DIP), ease.drop);
  colour(t(), rest, ease.inOut);
  scale(t(), 1);
  phase('dip');

  if (rebound) {
    body(NOD_REBOUND_MS, pose('rebound', NOD_REBOUND), ease.pop);
    body(NOD_SETTLE_MS - NOD_REBOUND_MS, circle, ease.settle);
  } else {
    body(NOD_SETTLE_MS, circle, ease.settle);
  }
  eye(t() - FAINT_EYES_OUT_MS * tempo, faintEyes('circle'), ease.settle);
  eye(t(), hiddenEyes('circle'), ease.drop);
  phase('settle');
  clip.total = t();

  clip.info = { dip: NOD_DIP, rebound, tempo, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Dip', value: Math.round(NOD_DIP * 100) + '%' },
    { label: 'Rebound', ...onOff(rebound) },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}

/**
 * The blink: Jet stands for a moment with its face open, blinks twice ("got it") and melts back.
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 */
export function buildBlink(rig, p) {
  const { ks, km, reduced, eyeSize, rest, circle, pose, eyes, hiddenEyes, clip, body, eye, colour, scale, t, tempo, bounce, phase } = startReaction(rig, p);
  // A double blink is an oscillation, so reduced motion holds the eyes open instead.
  const blinks = reduced ? 0 : 2;
  const puddle = km >= 0.3 && !reduced;
  const open = eyes('soft', EYE_OPEN, EYE_OPEN);

  body(BLINK_STAND_MS, pose('soft'), ease.pop);
  eye(t(), open, ease.pop);
  colour(t(), rest, ease.inOut);
  scale(t(), 1);
  phase('stand');

  const standEnd = t();
  body(BLINK_MS, pose('soft'), ease.linear);
  if (blinks) {
    for (const { at, shut } of DOUBLE_BLINK) eye(standEnd + at * tempo, shut ? eyes('soft', EYE_OPEN, EYE_BLINK) : open, ease.linear);
  } else {
    eye(t(), open, ease.linear);
  }
  phase('blink');

  eye(t() + BLINK_FACE_CLOSES_MS * tempo, hiddenEyes('soft'), ease.settle);
  if (puddle) {
    body(BLINK_PUDDLE_MS, pose('puddle', 0.5 * Math.min(1, bounce)), ease.melt);
    body(BLINK_MELT_MS - BLINK_PUDDLE_MS, circle, ease.settle);
  } else {
    body(BLINK_MELT_MS, circle, ease.inOut);
  }
  eye(t(), hiddenEyes('circle'));
  phase('melt');
  clip.total = t();

  clip.info = { blinks, eyeSize, tempo, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Blinks', value: String(blinks), on: blinks > 0 },
    { label: 'Eye size', value: eyeSize ? Math.round(eyeSize * 100) + '%' : 'none' },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}

/**
 * The hop: a crouch, a small bounce off the ground and a landing. The faint eyes ride the
 * body; they never become a face.
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 */
export function buildHop(rig, p) {
  const { ks, km, reduced, rest, circle, pose, hiddenEyes, clip, body, eye, colour, scale, t, tempo, bounce, faintEyes, phase } = startReaction(rig, p);
  const impact = km >= 0.3 && !reduced;

  body(HOP_CROUCH_MS, pose('squash', 0.5 * bounce), ease.drop);
  eye(t(), faintEyes('squash', 0.5 * bounce), ease.drop);
  colour(t(), rest, ease.inOut);
  scale(t(), 1);
  phase('crouch');

  body(HOP_MS, pose('zoom_hop', HOP_LIFT), ease.pop);
  eye(t(), faintEyes('zoom_hop', HOP_LIFT), ease.pop);
  scale(t(), 1 + 0.04 * km * bounce, ease.pop);
  phase('hop');

  if (impact) {
    body(HOP_IMPACT_MS, pose('squash', 0.35 * bounce), ease.fall);
    eye(t(), faintEyes('squash', 0.35 * bounce), ease.fall);
    scale(t(), 1, ease.settle);
    body(HOP_LAND_MS - HOP_IMPACT_MS, circle, ease.settle);
  } else {
    body(HOP_LAND_MS, circle, ease.land);
    scale(t(), 1, ease.settle);
  }
  eye(t() - FAINT_EYES_OUT_MS * tempo, faintEyes('circle'), ease.settle);
  eye(t(), hiddenEyes('circle'), ease.drop);
  phase('land');
  clip.total = t();

  clip.info = { lift: HOP_LIFT, impact, bounce, tempo, shapeAmplitude: ks };
  clip.readout = [
    { label: 'Lift', value: Math.round(HOP_LIFT * 100) + '%' },
    { label: 'Landing squash', ...onOff(impact) },
    { label: 'Squash & stretch', value: Math.round(bounce * 100) + '%' },
    { label: 'Tempo', value: (1 / tempo).toFixed(2) + '×' },
    { label: 'Shape amplitude', value: Math.round(ks * 100) + '%' },
  ];
  return clip;
}
