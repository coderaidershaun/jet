// The beats that the mood clips share: how Jet stands up out of the circle, how it
// melts back into it, and the dials every mood clip reads the same way. A clip file
// that starts here holds only what is its own.

import { createClip, readDials } from '../clip.js';
import { cubicBezier } from '../easing.js';
import { clamp, lerp } from '../maths.js';
import { RING_HIDDEN } from '../state.js';

export const EYE_OPEN = 4;
export const EYE_POP = 4.6;
export const EYE_SQUINT = [5, 1.6];
export const EYE_NARROW = [5, 1.8];
export const EYE_BLINK = 0.4;

const ease = {
  drop: cubicBezier(0.4, 0, 1, 1),
  pop: cubicBezier(0.1, 0.8, 0.2, 1),
  fall: cubicBezier(0.5, 0, 1, 1),
  land: cubicBezier(0.2, 0.8, 0.3, 1),
  inOut: cubicBezier(0.4, 0, 0.6, 1),
  settle: cubicBezier(0.2, 0.8, 0.4, 1),
  melt: cubicBezier(0.5, 0, 0.9, 0.6),
};

const SQUASH_MS = 90;
const STRETCH_MS = 200;
const LAND_MS = 100;
const LAND_SLOWLY_MS = 300;
const RELAX_MS = 130;
const PUDDLE_MS = 180;
const REBOUND_MS = 150;
const CIRCLE_MS = 180;

/**
 * Puts the ring away early and stops the ground early, so that a clip that interrupts
 * a zoom does not leave grooves or moving scenery under its own motion.
 * @param {{ ring: Function, speed: Function }} writers
 */
function clearGround({ ring, speed }) {
  ring(150, RING_HIDDEN.slice(), ease.inOut);
  speed(300, 0, ease.settle);
}

/**
 * Reads the dials and makes the empty clip for a mood: the tempo, the size of the
 * squash and the beats that every mood shares. `standUp` takes Jet from wherever it
 * is to the landing pose, with no face and the colour at rest. `melt` takes it from a
 * pose with the eyes already gone back to the circle. `bow(amount)` is the soft pose
 * bowed by that amount, and `tint(name, amount)` is the rest colour moved toward a
 * palette colour. `phase(name)` closes a phase at the time the body has reached.
 * @param {import('../rig.js').Rig} rig
 * @param {import('../clip.js').Params} p
 */
export function startClip(rig, p) {
  const dials = readDials(rig, p);
  const { km, y, circle, rest, pose, hiddenEyes } = dials;
  const tempo = clamp(1 - 0.15 * y, 0.8, 1.25);
  const bounce = clamp(1 + 0.5 * y, 0.6, 1.3) * (0.45 + 0.55 * km);
  const writers = createClip(tempo);
  const { clip, body, eye, colour, scale, t } = writers;
  clearGround(writers);

  // SMELL: the hello clip still has its own copy of this stand-up and of the melt below. It
  // was left alone so that its timing could not change. The two copies drift apart when one
  // is edited, and no test notices. Hello should use these beats.
  function standUp() {
    const squash = km > 0.2;
    body(squash ? SQUASH_MS : LAND_SLOWLY_MS, squash ? pose('squash', bounce) : pose('land'), squash ? ease.drop : ease.land);
    eye(t(), hiddenEyes('circle'), ease.drop);
    colour(t(), rest, ease.inOut);
    scale(t(), 1);
    if (squash) {
      body(STRETCH_MS, pose('stretch', Math.min(bounce, 1.15)), ease.pop);
      body(LAND_MS, pose('land'), ease.fall);
    }
    eye(t(), hiddenEyes('land'), ease.fall);
    scale(t() + 60 * tempo, 1 + 0.04 * km * bounce, ease.pop);
    scale(t() + 180 * tempo, 1, ease.settle);
  }

  function melt() {
    body(RELAX_MS, pose('relax'), ease.melt);
    body(PUDDLE_MS, pose('puddle', Math.min(1, bounce)), ease.inOut);
    colour(t(), rest, ease.inOut);
    if (km >= 0.3) body(REBOUND_MS, pose('rebound', Math.min(1, bounce)), ease.pop);
    scale(t(), 1);
    scale(t() + 40 * tempo, 1 + 0.03 * km, ease.pop);
    body(CIRCLE_MS, circle, ease.inOut);
    scale(t(), 1, ease.settle);
  }

  const bow = (amount) => lerp(pose('soft'), pose('bow'), amount);
  const tint = (name, amount) => lerp(rest, rig.palette[name], amount);
  const phase = (name) => clip.phases.push({ name, end: t() });

  return { ...dials, ...writers, tempo, bounce, standUp, melt, bow, tint, phase };
}
