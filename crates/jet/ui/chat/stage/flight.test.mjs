import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlight, cruiseMsFor } from './flight.js';

const near = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, actual + ' is not ' + expected);

test('the flight holds, bows right, overshoots five pixels and lands on the slot', () => {
  const flight = createFlight({ from: { x: 500, y: 100 }, to: { x: 380, y: 700 }, fromScale: 1, toScale: 0.6, startAt: 100, durationMs: 1000 });
  assert.deepEqual(flight.sample(0), { x: 120, y: -600, scale: 1 });
  const middle = flight.sample(550);
  assert.ok(middle.x > 60, 'the path bows right of its straight line');
  const overshoot = flight.sample(1000);
  near(Math.hypot(overshoot.x, overshoot.y), 5);
  assert.ok(overshoot.y > 0, 'the path passes its destination before braking');
  assert.deepEqual(flight.sample(1100), { x: 0, y: 0, scale: 0.6 });
  assert.deepEqual(flight.sample(2000), flight.sample(1100));
  assert.equal(flight.endsAt, 1100);
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
