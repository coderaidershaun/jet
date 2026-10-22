import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kite, RIGHT_HAND } from './forms.js';
import { fold, speedLines } from './hand.js';

const numbers = (text) => text.match(/-?\d+(?:\.\d+)?/g).map(Number);

function distanceToOutline(point, outline) {
  let nearest = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const [a, b] = [outline[i], outline[(i + 1) % outline.length]];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const u = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    nearest = Math.min(nearest, Math.hypot(point[0] - (a[0] + u * dx), point[1] - (a[1] + u * dy)));
  }
  return nearest;
}

test('the hand fades in between 3 and 13 degrees and sits on the outline', () => {
  const strengthAt = (lift) => fold(kite({ liftRight: lift }), 1, lift).strength;
  assert.equal(strengthAt(0), 0);
  assert.equal(strengthAt(3), 0);
  assert.equal(strengthAt(8), 0.5);
  assert.equal(strengthAt(13), 1);
  assert.equal(strengthAt(30), 1);

  for (const [side, outline, lift] of [
    [1, kite({ liftRight: 25 }), 25],
    [-1, kite({ liftLeft: 25 }), 25],
    [1, kite(), 0],
  ]) {
    const { fill, crease } = fold(outline, side, lift);
    const edge = numbers(fill);
    const [upper, lower] = [edge.slice(0, 2), edge.slice(30, 32)];
    const [creaseStart, creaseControl, creaseEnd] = [0, 2, 4].map((k) => numbers(crease).slice(k, k + 2));
    assert.deepEqual(creaseStart, lower, 'the crease starts where the fill ends');
    assert.deepEqual(creaseEnd, upper, 'the crease ends where the fill starts');
    assert.deepEqual(numbers(fill).slice(-4, -2), creaseControl, 'both bend towards the same point');
    for (const end of [upper, lower]) assert.ok(distanceToOutline(end, outline) < 0.01, 'the ends lie on the outline');
    const mid = [(upper[0] + lower[0]) / 2, (upper[1] + lower[1]) / 2];
    assert.ok(Math.abs(Math.hypot(creaseControl[0] - mid[0], creaseControl[1] - mid[1]) - 3) < 0.02, 'the crease bows 3 units');
  }
});

test('speed lines appear above 35 degrees per second and trail the motion', () => {
  for (const speed of [0, 20, 35]) {
    assert.deepEqual(speedLines(1, 20, speed).map((line) => line.opacity), [0, 0], `no lines at ${speed} degrees per second`);
  }
  assert.deepEqual(speedLines(1, 20, 125).map((line) => line.opacity), [0.85, 0.85 * 0.65]);
  assert.equal(speedLines(1, 20, -400).length, 2);

  const corner = kite({ liftRight: 20 })[RIGHT_HAND];
  for (const [speed, below] of [[200, true], [-200, false]]) {
    for (const { d } of speedLines(1, 20, speed)) {
      const [x0, y0, , , , , , x1, y1] = numbers(d);
      for (const y of [y0, y1]) assert.equal(y > corner[1], below, `a line at ${speed} degrees per second trails ${below ? 'below' : 'above'} the corner`);
      assert.ok(x0 > 150 && x1 > 150, 'the lines sit beside the right corner');
    }
  }
  const [mirrored] = speedLines(-1, 20, 200);
  const [original] = speedLines(1, 20, 200);
  assert.ok(Math.abs(numbers(mirrored.d)[0] - (200 - numbers(original.d)[0])) < 0.011, 'the left lines mirror the right');
});
