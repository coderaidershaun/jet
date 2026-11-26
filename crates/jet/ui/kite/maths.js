// Small number helpers that several parts of the character share: keeping a
// value inside a range and blending two values.

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Linear blend of two numbers or two equal-length arrays. `t` may run past
 * 0..1; that is how a pose gets exaggerated beyond the way it was drawn.
 * @template {number | number[]} T
 * @param {T} a
 * @param {T} b
 * @param {number} t
 * @returns {T}
 */
export function lerp(a, b, t) {
  if (typeof a === 'number') return /** @type {T} */ (a + (/** @type {number} */ (b) - a) * t);
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (/** @type {number[]} */ (b)[i] - a[i]) * t;
  return /** @type {T} */ (out);
}
