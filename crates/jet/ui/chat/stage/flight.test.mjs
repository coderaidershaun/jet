import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlight, cruiseMsFor } from './flight.js';

const near = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, actual + ' is not ' + expected);

test('the flight holds before its start, lands on the slot, turns toward travel and mirrors when going left', () => {
  const left = createFlight({ from: { x: 600, y: 300 }, to: { x: 200, y: 700 }, fromScale: 1, toScale: 0.6, startAt: 1000, durationMs: 800 });

  const before = left.sample(900);
  assert.deepEqual([before.x, before.y, before.rotate, before.scale], [400, -400, 0, 1], 'it holds at the start, offset from the slot');
  assert.equal(before.mirror, true);

  const landed = left.sample(1800);
  assert.deepEqual([landed.x, landed.y, landed.rotate, landed.scale], [0, 0, 0, 0.6]);
  assert.deepEqual(left.sample(5000), landed, 'it stays landed');
  assert.equal(left.endsAt, 1800, 'the host ends the flight by this time, not by a clip name');

  const middle = left.sample(1400);
  near(middle.rotate, 25);
  near(middle.x, 200);
  near(middle.y, -200);
  const early = left.sample(1000 + 800 * 0.09);
  assert.ok(early.rotate > 0 && early.rotate < 25, 'the turn eases in over the first part');

  const right = createFlight({ from: { x: 200, y: 700 }, to: { x: 600, y: 300 }, fromScale: 0.6, toScale: 0.6, startAt: 0, durationMs: 800, profile: 'roll' });
  assert.equal(right.sample(400).mirror, false);
  near(right.sample(400).rotate, -25, 1e-6);

  assert.throws(
    () => createFlight({ from: { x: 200, y: 700 }, to: { x: 600, y: 300 }, fromScale: 0.6, toScale: 0.6, startAt: 0, durationMs: 800, profile: 'teleport' }),
    (error) => error instanceof RangeError && /teleport/.test(error.message),
    'a profile the flight cannot fly fails loudly instead of rolling',
  );
});

test('flight tilt is capped', () => {
  const straightDown = createFlight({ from: { x: 400, y: 100 }, to: { x: 400, y: 700 }, fromScale: 1, toScale: 0.6, startAt: 0, durationMs: 1000 });
  const rotations = Array.from({ length: 41 }, (_, i) => straightDown.sample(i * 25).rotate);
  assert.ok(rotations.every((rotate) => Math.abs(rotate) <= 25 + 1e-6), 'a flight straight down never turns past 25 degrees');
  near(Math.max(...rotations), 25);
});

test('the cruise grows with distance within 520 to 1400 ms and the scale never passes 1', () => {
  assert.equal(cruiseMsFor(0), 520);
  assert.equal(cruiseMsFor(100), 520);
  assert.equal(cruiseMsFor(500), 660);
  assert.equal(cruiseMsFor(10000), 1400);
  assert.ok(cruiseMsFor(800) > cruiseMsFor(500));

  const flight = createFlight({ from: { x: 0, y: 0 }, to: { x: 300, y: 0 }, fromScale: 1.4, toScale: 1.2, startAt: 0, durationMs: 500 });
  for (let now = -100; now <= 700; now += 25) assert.ok(flight.sample(now).scale <= 1, 'scale at ' + now);
});
