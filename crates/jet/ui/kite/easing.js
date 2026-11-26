// The timing curves the character's motion is written in: the cubic-bezier
// curve CSS uses, and the exact curves of the two motion scripts, so a
// timing copied from a script gives the same numbers here.

import { clamp } from './maths.js';

/**
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {(progress: number) => number}
 */
export function cubicBezier(x1, y1, x2, y2) {
  const a = (p, q) => 1 - 3 * q + 3 * p;
  const b = (p, q) => 3 * q - 6 * p;
  const c = (p) => 3 * p;
  const at = (t, p, q) => ((a(p, q) * t + b(p, q)) * t + c(p)) * t;
  const slope = (t, p, q) => 3 * a(p, q) * t * t + 2 * b(p, q) * t + c(p);
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const s = slope(t, x1, x2);
      if (Math.abs(s) < 1e-6) break;
      t -= (at(t, x1, x2) - x) / s;
    }
    return at(t, y1, y2);
  };
}

export const linear = cubicBezier(0, 0, 1, 1);

const clamp01 = (x) => clamp(x, 0, 1);

/** Slow at both ends. @param {number} u 0..1 */
export const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

/** Fast first, slow at the end. @param {number} u 0..1 */
export const easeOut = (u) => 1 - (1 - u) ** 3;

/**
 * Runs past 1 and settles back; a bigger `overshoot` goes further past.
 * @param {number} [overshoot]
 * @returns {(u: number) => number}
 */
export const easeOutBack = (overshoot = 1.4) => (u) => 1 + (overshoot + 1) * (u - 1) ** 3 + overshoot * (u - 1) ** 2;

/** The quintic smooth step: 0 below 0, 1 above 1, flat at both ends. @param {number} x */
export function smoothstep(x) {
  const u = clamp01(x);
  return u * u * u * (u * (u * 6 - 15) + 10);
}

/**
 * Progress from 0 to 1 between two times, shaped by `ease`.
 * @param {number} t
 * @param {number} t0
 * @param {number} t1
 * @param {(u: number) => number} [ease]
 */
export const ramp = (t, t0, t1, ease = easeInOut) => ease(clamp01((t - t0) / (t1 - t0)));

/**
 * Up between `t0` and `t1`, back down between `t1` and `t2`.
 * @param {number} t
 * @param {number} t0
 * @param {number} t1
 * @param {number} t2
 * @param {(u: number) => number} [easeUp]
 * @param {(u: number) => number} [easeDown]
 */
export const pulse = (t, t0, t1, t2, easeUp = easeOut, easeDown = easeInOut) =>
  ramp(t, t0, t1, easeUp) * (1 - ramp(t, t1, t2, easeDown));
