import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CENTRE, LEFT_HAND, POINTS, RIGHT_HAND, TIP, kite, morph, spinner } from './forms.js';

// The path of character-kite.svg, whose kite is centred at (86, 80).
const REFERENCE_PATH =
  'M86 9 C86.07 9 85.92 8.95 86.22 9.03 C86.52 9.1 86.83 9.09 87.79 9.44 C88.75 9.79 90.02 10.16 91.96 11.11 C93.9 12.06 96.42 13.27 99.43 15.13 C102.44 16.99 106.17 19.38 110.02 22.26 C113.86 25.14 118.34 28.72 122.48 32.43 C126.63 36.14 131.09 40.48 134.91 44.52 C138.72 48.55 142.4 52.91 145.37 56.64 C148.33 60.38 150.79 64.01 152.7 66.94 C154.61 69.86 155.85 72.32 156.83 74.2 C157.8 76.09 158.19 77.33 158.55 78.26 C158.9 79.19 158.9 79.5 158.97 79.79 C159.05 80.08 159 79.94 159 80 C159 80.06 159.05 79.9 158.97 80.16 C158.89 80.41 158.9 80.62 158.51 81.53 C158.12 82.44 157.7 83.62 156.65 85.63 C155.6 87.64 154.25 90.27 152.2 93.58 C150.15 96.89 147.5 101.07 144.35 105.49 C141.2 109.91 137.29 115.16 133.3 120.1 C129.32 125.03 124.67 130.44 120.44 135.08 C116.2 139.72 111.69 144.28 107.89 147.94 C104.1 151.61 100.51 154.69 97.67 157.08 C94.82 159.47 92.56 161.04 90.84 162.26 C89.11 163.49 88.1 163.98 87.32 164.43 C86.53 164.88 86.35 164.87 86.13 164.96 C85.91 165.06 86.04 165 86 165 C85.96 165 86.09 165.06 85.87 164.96 C85.65 164.87 85.47 164.88 84.68 164.43 C83.9 163.98 82.89 163.49 81.16 162.26 C79.44 161.04 77.18 159.47 74.33 157.08 C71.49 154.69 67.9 151.61 64.11 147.94 C60.31 144.28 55.8 139.72 51.56 135.08 C47.33 130.44 42.68 125.03 38.7 120.1 C34.71 115.16 30.8 109.91 27.65 105.49 C24.5 101.07 21.85 96.89 19.8 93.58 C17.75 90.27 16.4 87.64 15.35 85.63 C14.3 83.62 13.88 82.44 13.49 81.53 C13.1 80.62 13.11 80.41 13.03 80.16 C12.95 79.9 13 80.06 13 80 C13 79.94 12.95 80.08 13.03 79.79 C13.1 79.5 13.1 79.19 13.45 78.26 C13.81 77.33 14.2 76.09 15.17 74.2 C16.15 72.32 17.39 69.86 19.3 66.94 C21.21 64.01 23.67 60.38 26.63 56.64 C29.6 52.91 33.28 48.55 37.09 44.52 C40.91 40.48 45.37 36.14 49.52 32.43 C53.66 28.72 58.14 25.14 61.98 22.26 C65.83 19.38 69.56 16.99 72.57 15.13 C75.58 13.27 78.1 12.06 80.04 11.11 C81.98 10.16 83.25 9.79 84.21 9.44 C85.17 9.09 85.48 9.1 85.78 9.03 C86.08 8.95 85.93 9 86 9 Z';

const close = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);

test('the resting kite is the reference kite', () => {
  const pairs = REFERENCE_PATH.replace(' Z', '').split(/[MC]/).slice(1).map((part) => part.trim().split(/\s+/).map(Number));
  const start = pairs[0];
  const ends = pairs.slice(1).map((numbers) => numbers.slice(-2));
  assert.equal(ends.length, POINTS);

  const points = kite();
  const shift = (point) => [point[0] - 14, point[1] - 8];
  close(shift(points[0])[0], start[0], 0.05, 'x of the start');
  close(shift(points[0])[1], start[1], 0.05, 'y of the start');
  ends.forEach((end, i) => {
    const mine = shift(points[(i + 1) % POINTS]);
    close(mine[0], end[0], 0.05, `x of segment ${i}`);
    close(mine[1], end[1], 0.05, `y of segment ${i}`);
  });
});

test('the outline is 52 points, symmetric at rest, with the tip on the centre line', () => {
  const points = kite();
  assert.equal(points.length, 52);
  for (let i = 1; i < POINTS; i++) {
    close(points[POINTS - i][0], 200 - points[i][0], 1e-9, `mirror of point ${i}`);
    close(points[POINTS - i][1], points[i][1], 1e-9, `mirror of point ${i}`);
  }
  close(points[TIP][0], CENTRE[0], 1e-9, 'tip x');
  close(points[TIP][1], 173, 1e-9, 'tip y');
  close(points[RIGHT_HAND][0], 173, 1e-9, 'right corner x');
  close(points[LEFT_HAND][0], 27, 1e-9, 'left corner x');
});

test('a lifted corner rises along the pivot arc and stretch adds reach', () => {
  const pivot = [122, 88];
  let before = kite()[RIGHT_HAND];
  for (const lift of [10, 20, 30]) {
    const corner = kite({ liftRight: lift })[RIGHT_HAND];
    assert.ok(corner[1] < before[1], `y falls at ${lift} degrees`);
    assert.ok(corner[0] < before[0], `x shrinks at ${lift} degrees`);
    close(Math.hypot(corner[0] - pivot[0], corner[1] - pivot[1]), 51, 1e-9, 'reach about the pivot');
    before = corner;
  }
  const stretched = kite({ liftRight: 20, stretch: 2.5 })[RIGHT_HAND];
  close(Math.hypot(stretched[0] - pivot[0], stretched[1] - pivot[1]), 53.5, 1e-9, 'stretched reach');
  assert.ok(kite({ liftRight: -6 })[RIGHT_HAND][1] > 88, 'a negative lift swings below the horizontal');

  const left = kite({ liftLeft: 20, stretch: [2.5, 0] });
  const right = kite({ liftRight: 20, stretch: [0, 2.5] });
  for (let i = 1; i < POINTS; i++) {
    close(left[POINTS - i][0], 200 - right[i][0], 1e-9, `mirrored x of point ${i}`);
    close(left[POINTS - i][1], right[i][1], 1e-9, `mirrored y of point ${i}`);
  }
});

// The spinner's band: 41 to 63 from the centre outside the 79 degree opening at
// the top, plus a rounded end of radius 11 at each side of the opening.
function inBand([x, y]) {
  const distance = Math.hypot(x - CENTRE[0], y - CENTRE[1]);
  const degreesFromTop = Math.abs((Math.atan2(x - CENTRE[0], CENTRE[1] - y) * 180) / Math.PI);
  const onArc = distance >= 41 - 1e-9 && distance <= 63 + 1e-9 && degreesFromTop >= 79 / 2 - 1e-9;
  const endCentres = [-1, 1].map((side) => [
    CENTRE[0] + side * 52 * Math.sin((79 / 2) * (Math.PI / 180)),
    CENTRE[1] - 52 * Math.cos((79 / 2) * (Math.PI / 180)),
  ]);
  const onEnd = endCentres.some(([cx, cy]) => Math.hypot(x - cx, y - cy) <= 11 + 1e-9);
  return onArc || onEnd;
}

const properlyCross = (a, b, c, d) => {
  const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
};

function crossesItself(points) {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (properlyCross(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return true;
    }
  }
  return false;
}

test('the spinner lies in its band and the morph never crosses itself', () => {
  const ring = spinner();
  assert.equal(ring.length, 52);
  for (const [i, point] of ring.entries()) assert.ok(inBand(point), `point ${i} at ${point} is outside the band`);
  for (let i = 6; i <= 46; i++) close(Math.hypot(ring[i][0] - CENTRE[0], ring[i][1] - CENTRE[1]), 63, 1e-9, `outer point ${i}`);

  const resting = kite();
  for (let step = 0; step <= 20; step++) {
    assert.ok(!crossesItself(morph(resting, ring, step / 20)), `the morph crosses itself at k = ${step / 20}`);
  }
});
