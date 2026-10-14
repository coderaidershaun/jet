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

  for (const profile of ['teleport', 'zoom', 'toString']) {
    assert.throws(
      () => createFlight({ from: { x: 200, y: 700 }, to: { x: 600, y: 300 }, fromScale: 0.6, toScale: 0.6, startAt: 0, durationMs: 800, profile }),
      (error) => error instanceof RangeError && error.message.includes(profile),
      'a profile the flight cannot fly fails loudly instead of rolling: ' + profile,
    );
  }
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

test('every profile closes the gap without turning back and lands on the slot', () => {
  for (const profile of ['roll', 'drop', 'abseil']) {
    const flight = createFlight({ from: { x: 500, y: 100 }, to: { x: 380, y: 700 }, fromScale: 1, toScale: 0.6, startAt: 0, durationMs: 1000, profile });
    const samples = Array.from({ length: 101 }, (_, i) => flight.sample(i * 10));
    const gaps = samples.map(({ x, y }) => Math.hypot(x, y));
    near(gaps[0], Math.hypot(120, -600));
    assert.equal(gaps.at(-1), 0, profile + ' lands on the slot');
    for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] <= gaps[i - 1] + 1e-9, profile + ' turns back at ' + i * 10 + ' ms');
    if (profile === 'roll') continue;
    assert.ok(samples.every((s) => s.rotate === 0 && s.mirror === false), profile + ' never turns or mirrors');
  }
});

test('the drop speeds up then slows, and the abseil hangs at three heights', () => {
  const from = { x: 400, y: 100 };
  const to = { x: 420, y: 700 };
  const fly = (profile, durationMs) => createFlight({ from, to, fromScale: 1, toScale: 0.6, startAt: 0, durationMs, profile });

  const drop = fly('drop', 1000);
  const gap = (now) => Math.hypot(drop.sample(now).x, drop.sample(now).y);
  const full = gap(0);
  const step = (end) => gap(end - 10) - gap(end);
  for (let end = 20; end <= 400; end += 10) assert.ok(step(end) > step(end - 10), 'the drop speeds up until 40%, but not at ' + end + ' ms');
  for (let end = 420; end <= 1000; end += 10) assert.ok(step(end) < step(end - 10), 'the drop slows after 40%, but not at ' + end + ' ms');
  assert.ok(gap(500) < full / 2, 'the drop is past halfway at half time');

  const abseil = fly('abseil', 900);
  const offsets = Array.from({ length: 90 }, (_, i) => abseil.sample(i * 10));
  const plateaus = [];
  for (let i = 1; i < offsets.length; i++) {
    const still = offsets[i].x === offsets[i - 1].x && offsets[i].y === offsets[i - 1].y;
    if (still && plateaus.at(-1)?.end === i - 1) plateaus.at(-1).end = i;
    else if (still) plateaus.push({ y: offsets[i].y, end: i });
  }
  const fullY = from.y - to.y;
  assert.equal(plateaus.length, 3, 'the abseil hangs at three heights');
  plateaus.forEach(({ y }, i) => near(y, (fullY * (3 - i)) / 3));
});
