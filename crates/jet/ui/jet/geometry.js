// Plane geometry for the kite: curves through points, rounded corners, and the
// polyline tools the string and the hand are built from. A point is [x, y].
// These are ports of the two motion scripts, so the numbers match theirs.

/**
 * A number for an SVG path: two decimals, trailing zeros trimmed.
 * @param {number} value
 */
export function fmt(value) {
  const text = value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return text === '-0' ? '0' : text;
}

/**
 * A point for an SVG path: "x y".
 * @param {number[]} point
 */
export const fmtPoint = (point) => fmt(point[0]) + ' ' + fmt(point[1]);

/**
 * Points on a superellipse quadrant from vertex `a` to vertex `b` around `centre`.
 * `a` and `b` need not be at right angles: the result is the stretched image of
 * the quadrant, still smooth. Samples are cosine-spaced, so they bunch up near
 * the two vertices where the curve bends most.
 * @param {number[]} centre
 * @param {number[]} a
 * @param {number[]} b
 * @param {number} exponent   2 is a circle; closer to 1 is a straighter, pointier side
 * @param {number} [count]
 * @returns {number[][]}
 */
export function quadrantAffine(centre, a, b, exponent, count = 14) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const angle = (Math.PI / 2) * (0.5 - 0.5 * Math.cos((Math.PI * k) / (count - 1)));
    const along = Math.cos(angle) ** (2 / exponent);
    const across = Math.sin(angle) ** (2 / exponent);
    out.push([
      centre[0] + along * (a[0] - centre[0]) + across * (b[0] - centre[0]),
      centre[1] + along * (a[1] - centre[1]) + across * (b[1] - centre[1]),
    ]);
  }
  return out;
}

function catmullSegment(before, from, to, after) {
  const c1 = [from[0] + (to[0] - before[0]) / 6, from[1] + (to[1] - before[1]) / 6];
  const c2 = [to[0] - (after[0] - from[0]) / 6, to[1] - (after[1] - from[1]) / 6];
  return 'C' + fmtPoint(c1) + ' ' + fmtPoint(c2) + ' ' + fmtPoint(to);
}

/**
 * A smooth closed path through every point (Catmull-Rom as cubic Beziers).
 * @param {number[][]} points
 */
export function closedCatmullRom(points) {
  const at = (k) => points[(k + points.length) % points.length];
  const parts = ['M' + fmtPoint(points[0])];
  for (let i = 0; i < points.length; i++) parts.push(catmullSegment(at(i - 1), at(i), at(i + 1), at(i + 2)));
  return parts.join(' ') + ' Z';
}

/**
 * A smooth open path through every point; the two ends repeat their neighbour.
 * @param {number[][]} points
 */
export function openCatmullRom(points) {
  const at = (k) => points[Math.min(Math.max(k, 0), points.length - 1)];
  const parts = ['M' + fmtPoint(points[0])];
  for (let i = 0; i < points.length - 1; i++) parts.push(catmullSegment(at(i - 1), at(i), at(i + 1), at(i + 2)));
  return parts.join(' ');
}

/**
 * A closed polygon whose corners are rounded: each corner point becomes the
 * control point of a small curve that starts and ends `radius` along its two edges.
 * @param {number[][]} corners
 * @param {number} [radius]
 */
export function roundedPolygon(corners, radius = 1) {
  const n = corners.length;
  const unitToward = (from, to) => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.hypot(dx, dy);
    return [dx / length, dy / length];
  };
  const parts = corners.map((corner, i) => {
    const before = unitToward(corner, corners[(i - 1 + n) % n]);
    const after = unitToward(corner, corners[(i + 1) % n]);
    const start = [corner[0] + radius * before[0], corner[1] + radius * before[1]];
    const end = [corner[0] + radius * after[0], corner[1] + radius * after[1]];
    return (i === 0 ? 'M' : 'L') + fmtPoint(start) + ' Q' + fmtPoint(corner) + ' ' + fmtPoint(end);
  });
  return parts.join(' ') + ' Z';
}

/**
 * `point` turned by `degrees` about `centre`, clockwise on screen.
 * @param {number[]} point
 * @param {number[]} centre
 * @param {number} degrees
 */
export function rotate(point, centre, degrees) {
  const angle = (degrees * Math.PI) / 180;
  const x = point[0] - centre[0];
  const y = point[1] - centre[1];
  return [centre[0] + x * Math.cos(angle) - y * Math.sin(angle), centre[1] + x * Math.sin(angle) + y * Math.cos(angle)];
}

/**
 * Walks a closed outline from sample `start` in direction `step` (+1 or -1)
 * for `distance` units. Gives the point reached and the last whole sample passed.
 * @param {number[][]} outline
 * @param {number} start
 * @param {number} step
 * @param {number} distance
 * @returns {{ point: number[], index: number }}
 */
export function walk(outline, start, step, distance) {
  const n = outline.length;
  let index = start;
  let walked = 0;
  for (;;) {
    const next = (index + step + n) % n;
    const from = outline[index];
    const to = outline[next];
    const segment = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (walked + segment >= distance) {
      const u = segment > 0 ? (distance - walked) / segment : 0;
      return { point: [from[0] + u * (to[0] - from[0]), from[1] + u * (to[1] - from[1])], index };
    }
    walked += segment;
    index = next;
  }
}

/**
 * Points along a cubic Bezier curve, evenly spaced in the curve's own parameter.
 * @param {number[]} p0
 * @param {number[]} p1
 * @param {number[]} p2
 * @param {number[]} p3
 * @param {number} [count]
 * @returns {number[][]}
 */
export function bezier(p0, p1, p2, p3, count = 800) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const t = k / (count - 1);
    const u = 1 - t;
    out.push([0, 1].map((axis) => u ** 3 * p0[axis] + 3 * u * u * t * p1[axis] + 3 * u * t * t * p2[axis] + t ** 3 * p3[axis]));
  }
  return out;
}

/**
 * @param {number[][]} points
 */
export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}

/**
 * `count` points evenly spaced along the first `fraction` (0..1) of a polyline's
 * length. A fraction of 0 gives `count` copies of the start. Past 1 it carries on
 * along the last segment.
 * @param {number[][]} polyline
 * @param {number} count
 * @param {number} [fraction]
 * @returns {number[][]}
 */
export function resample(polyline, count, fraction = 1) {
  const segments = polyline.length - 1;
  const cumulative = [0];
  for (let i = 0; i < segments; i++) {
    const [a, b] = [polyline[i], polyline[i + 1]];
    cumulative.push(cumulative[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const reach = Math.max(fraction, 1e-9) * cumulative[segments];
  const out = [];
  let i = 0;
  for (let k = 0; k < count; k++) {
    const target = (reach * k) / (count - 1);
    while (i + 1 < segments && cumulative[i + 1] <= target) i++;
    const length = cumulative[i + 1] - cumulative[i];
    const u = length > 0 ? (target - cumulative[i]) / length : 0;
    const [a, b] = [polyline[i], polyline[i + 1]];
    out.push([a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])]);
  }
  return out;
}

/**
 * Points on an elliptical arc about (cx, cy), from angle `from` to angle `to`
 * in degrees (screen angles: 0 is right, 90 is down).
 * @param {number} cx
 * @param {number} cy
 * @param {number} rx
 * @param {number} ry
 * @param {number} from
 * @param {number} to
 * @param {number} [count]
 * @returns {number[][]}
 */
export function arc(cx, cy, rx, ry, from, to, count = 40) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const angle = ((from + ((to - from) * k) / (count - 1)) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
  }
  return out;
}

/**
 * Evenly spaced points on the straight line from `a` to `b`, both included.
 * @param {number[]} a
 * @param {number[]} b
 * @param {number} [count]
 * @returns {number[][]}
 */
export function line(a, b, count = 6) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const u = k / (count - 1);
    out.push([a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])]);
  }
  return out;
}

/**
 * Dense points on a Catmull-Rom curve through the control points, about `count`
 * in all. The curve ends on the last control point.
 * @param {number[][]} controls
 * @param {number} [count]
 * @returns {number[][]}
 */
export function smooth(controls, count = 60) {
  const last = controls.length - 1;
  const perSpan = Math.max(2, Math.floor(count / last));
  const out = [];
  for (let i = 0; i < last; i++) {
    const p0 = controls[Math.max(i - 1, 0)];
    const p1 = controls[i];
    const p2 = controls[i + 1];
    const p3 = controls[Math.min(i + 2, last)];
    for (let k = 0; k < perSpan; k++) {
      const u = k / perSpan;
      out.push(
        [0, 1].map(
          (axis) =>
            0.5 *
            (2 * p1[axis] +
              (-p0[axis] + p2[axis]) * u +
              (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * u * u +
              (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * u ** 3),
        ),
      );
    }
  }
  out.push(controls[last]);
  return out;
}

/**
 * A piece drawn travelling along +x, moved to `origin` and turned to travel at `degrees`.
 * @param {number[][]} points
 * @param {number[]} origin
 * @param {number} degrees
 * @returns {number[][]}
 */
export function place(points, origin, degrees) {
  const angle = (degrees * Math.PI) / 180;
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  return points.map(([x, y]) => [origin[0] + x * cos - y * sin, origin[1] + x * sin + y * cos]);
}
