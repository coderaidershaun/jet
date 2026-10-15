// This is the one place that says what a clip is and how the dials reach one.
// Every clip builder starts here, so every clip maps the dials the same way
// and a clip file holds only its own choreography.

import { lerp } from './maths.js';

/**
 * @typedef {object} Clip
 * @property {import('./track.js').Key[]} body
 * @property {import('./track.js').Key[]} eyes
 * @property {import('./track.js').Key[]} colour
 * @property {import('./track.js').Key[]} scale
 * @property {import('./track.js').Key[]} [ring]
 * @property {import('./track.js').Key[]} [speed]
 * @property {import('./track.js').Key[]} [prop]    ten numbers per key, see PROP
 * @property {[string | null, string | null]} [props]   what each prop slot draws, from PROP_KINDS; a clip that shows no prop leaves it out
 * @property {number} total                          clip length in ms
 * @property {{ name: string, end: number }[]} phases  in order, ends in ms
 * @property {{ label: string, value: string, on?: boolean }[]} readout
 * @property {object} info                           what the dials turned into; each clip file says which fields
 */

/**
 * @typedef {object} Params
 * @property {number} candid    -1 (deferential) .. 1 (candid)
 * @property {number} playful   -1 (serious) .. 1 (playful)
 * @property {number} shape     0..10
 * @property {number} eyes      0..10
 * @property {number} colour    0..10
 * @property {number} motion    0..10
 * @property {boolean} reducedMotion
 */

/**
 * How much the eyes dial scales the eyes: 0 when the dial is below 1.5, too
 * low for any eyes, then from 0.66 up to 1 at the top of the dial.
 * @param {number} eyesDial   0..10
 * @returns {number}
 */
export function eyeSizeFor(eyesDial) {
  const ke = eyesDial / 10;
  return ke < 0.15 ? 0 : 0.6 + 0.4 * ke;
}

/** The radius of the faint eyes at rest, before the eyes dial scales it. */
export const FAINT_EYE_SIZE = 2.2;

/**
 * Returns the dials as the numbers that a clip's formulas read, and the
 * helpers that apply the shape and eyes dials to the rig.
 *
 * `ks`, `ke`, `kc` and `km` are shape, eyes, colour and motion, each from 0
 * to 1. `x` is candid and `y` is playful, each from -1 to 1. `reduced` is true
 * when the user asked for reduced motion. `eyeSize` scales the eyes, and it is
 * 0 when the eyes dial is too low for a face. `circle` and `rest` are the
 * rig's own circle pose and rest colour, not copies: never change them.
 *
 * `pose(name, k)` is a rig pose blended from the circle by the shape dial, so
 * shape 0 never leaves the circle. `k` scales the blend, so a `k` above 1
 * takes the pose further than the shape dial alone does. `eyes(name, rx, ry)`
 * places the eyes for a pose and gives them the size `rx` by `ry`, scaled by
 * `eyeSize`, in the ground colour (tint 0). `hiddenEyes(name)` places them
 * with no size and fully faint (tint 1). So a face opens out of faint eyes
 * into the ground colour, and closes back to faint. `faintEyes(name, k)` places
 * the resting faint eyes on a pose blended by `k`, at the size the player gives
 * them at rest, so a clip can carry them without a jump.
 *
 * @param {import('./rig.js').Rig} rig
 * @param {Params} p
 * @returns {{
 *   ks: number, ke: number, kc: number, km: number, x: number, y: number, reduced: boolean, eyeSize: number,
 *   circle: number[], rest: number[],
 *   pose: (name: string, k?: number) => number[],
 *   eyes: (name: string, rx: number, ry: number) => number[],
 *   hiddenEyes: (name: string) => number[],
 *   faintEyes: (name: string, k?: number) => number[],
 * }}
 */
export function readDials(rig, p) {
  const ks = p.shape / 10;
  const ke = p.eyes / 10;
  const kc = p.colour / 10;
  const km = p.motion / 10;
  const x = p.candid;
  const y = p.playful;
  const reduced = p.reducedMotion;
  const circle = rig.poses.circle;
  const rest = rig.palette.rest;
  const eyeSize = eyeSizeFor(p.eyes);

  const pose = (name, k = 1) => lerp(circle, rig.poses[name], k * ks);
  const eyeAt = (name) => lerp(rig.eyes.circle, rig.eyes[name], ks);
  const eyes = (name, rx, ry) => [...eyeAt(name), rx * eyeSize, ry * eyeSize, 0];
  const hiddenEyes = (name) => [...eyeAt(name), 0, 0, 1];
  const faintEyes = (name, k = 1) => {
    const size = FAINT_EYE_SIZE * eyeSize;
    return [...lerp(rig.eyes.circle, rig.eyes[name], k * ks), size, size, 1];
  };

  return { ks, ke, kc, km, x, y, reduced, eyeSize, circle, rest, pose, eyes, hiddenEyes, faintEyes };
}

function checkTime(track, at) {
  if (Number.isFinite(at)) return;
  const got = typeof at === 'function' ? 'a function: write t() with its brackets' : String(at);
  throw new TypeError('a key on the ' + track + ' track needs a finite number as its time, got ' + got);
}

/**
 * Makes an empty clip and the writers that put keys on its tracks. Times are
 * in milliseconds from the start of the clip.
 *
 * `body(dt, v, e)` moves the time on by `dt` milliseconds, scaled by the
 * tempo, and writes a body key there. Each of the other six writers puts one
 * key at the time `at` that it is given. `e` is the easing used while arriving
 * at the key. `t()` is the time the body has reached, and it is 0 before the
 * first body key.
 * Write `t()` with its brackets: a bare `t` is the function, not the time. The
 * six writers refuse a time that is not a finite number, so a writer that is
 * given a bare `t` throws. Nothing checks `total` or the end of a phase, which
 * the clip file writes by hand: a bare `t` goes into them with no error.
 *
 * The clip file sets `total`, `phases`, `info` and `readout` itself and
 * returns `clip`.
 *
 * @param {number} tempo   scales every body duration; each clip file works it out from the dials
 * @returns {{
 *   clip: Clip,
 *   body: (dt: number, v: number[], e?: import('./track.js').Key['e']) => void,
 *   eye: (at: number, v: number[], e?: import('./track.js').Key['e']) => void,
 *   colour: (at: number, v: number[], e?: import('./track.js').Key['e']) => void,
 *   scale: (at: number, v: number, e?: import('./track.js').Key['e']) => void,
 *   ring: (at: number, v: number[], e?: import('./track.js').Key['e']) => void,
 *   speed: (at: number, v: number, e?: import('./track.js').Key['e']) => void,
 *   prop: (at: number, v: number[], e?: import('./track.js').Key['e']) => void,
 *   t: () => number,
 * }}
 */
export function createClip(tempo) {
  /** @type {Clip} */
  const clip = { body: [], eyes: [], colour: [], scale: [], ring: [], speed: [], prop: [], total: 0, phases: [], readout: [], info: {} };
  let t = 0;
  const body = (dt, v, e) => { t += dt * tempo; clip.body.push({ t, v, e }); };
  const eye = (at, v, e) => { checkTime('eyes', at); clip.eyes.push({ t: at, v, e }); };
  const colour = (at, v, e) => { checkTime('colour', at); clip.colour.push({ t: at, v, e }); };
  const scale = (at, v, e) => { checkTime('scale', at); clip.scale.push({ t: at, v, e }); };
  const ring = (at, v, e) => { checkTime('ring', at); clip.ring.push({ t: at, v, e }); };
  const speed = (at, v, e) => { checkTime('speed', at); clip.speed.push({ t: at, v, e }); };
  const prop = (at, v, e) => { checkTime('prop', at); clip.prop.push({ t: at, v, e }); };
  return { clip, body, eye, colour, scale, ring, speed, prop, t: () => t };
}

/**
 * Returns the `value` and `on` fields of a readout row that is either on or
 * off. The clip file adds the label.
 */
export const onOff = (v) => ({ value: v ? 'on' : 'off', on: v });
