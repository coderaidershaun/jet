// Cubic-bezier easing with the same four numbers CSS uses, so timing can be
// tuned in a browser and copied here unchanged.

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
