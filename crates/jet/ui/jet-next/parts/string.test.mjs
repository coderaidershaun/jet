import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polylineLength } from '../geometry.js';
import { fistRoute, HAND_SCALE } from './routes.js';
import { FLOOR, SEGMENTS, createChain, jPose, lyingPose, raiseBlend, wind } from './string.js';

const HANGING_TIP = [100, 173];
const STANDING_TIP = [100, 231.8];
const J_TIMING = { start: 0.8, lag: 0.04, duration: 0.48, overshoot: 1.4 };

const chords = (points) => points.slice(1).map((p, i) => [p[0] - points[i][0], p[1] - points[i][1]]);
const degrees = ([dx, dy]) => (Math.atan2(dy, dx) * 180) / Math.PI;
const everySegment = (value) => Array(SEGMENTS).fill(value);
const fullPose = (pose) => ({ angles: pose.angles, proportions: pose.proportions, blend: everySegment(1) });

test('the chain is 16 segments of 3.75 from the tip and hangs with the wind', () => {
  const chain = createChain();
  for (const t of [0, 0.7, 2.9]) {
    const points = chain.points({ tip: HANGING_TIP, t });
    assert.equal(points.length, 17);
    assert.deepEqual(points[0], HANGING_TIP);
    chords(points).forEach((chord, i) => {
      assert.ok(Math.abs(Math.hypot(...chord) - 3.75) < 1e-9, `segment ${i} is 3.75 long`);
      assert.ok(Math.abs(degrees(chord) - (90 + wind(i, t))) < 1e-9, `segment ${i} points ${90 + wind(i, t)} degrees at ${t} s`);
    });
  }

  const flipWind = [2 / 4.8, 3 / 4.8];
  const blown = createChain({ windHz: flipWind }).points({ tip: HANGING_TIP, t: 1.3 });
  chords(blown).forEach((chord, i) => {
    assert.ok(Math.abs(degrees(chord) - (90 + wind(i, 1.3, flipWind))) < 1e-9, `segment ${i} follows the wind it was given`);
  });
  assert.notDeepEqual(blown, chain.points({ tip: HANGING_TIP, t: 1.3 }), 'another wind gives another string');
});

test('a pose blends in base-first with lag and overshoot', () => {
  const pose = jPose();
  assert.ok(Math.abs(pose.length - 95.54) < 0.01);

  assert.ok(raiseBlend(0, 1.0, J_TIMING) > raiseBlend(SEGMENTS - 1, 1.0, J_TIMING), 'the base is ahead of the end at mid-raise');
  assert.ok(raiseBlend(SEGMENTS - 1, 1.0, { ...J_TIMING, order: 'tip' }) > raiseBlend(0, 1.0, { ...J_TIMING, order: 'tip' }), 'the tip order reverses it');
  assert.equal(raiseBlend(3, 0.5, J_TIMING), 0);
  assert.equal(raiseBlend(3, 3, J_TIMING), 1);

  const times = Array.from({ length: 200 }, (_, k) => 0.8 + k * 0.01);
  const overshootAt = times.find((t) => raiseBlend(0, t, J_TIMING) > 1.05);
  assert.ok(overshootAt, 'the blend runs past 1');

  const t = overshootAt;
  const blend = Array.from({ length: SEGMENTS }, (_, i) => raiseBlend(i, t, J_TIMING));
  const points = createChain().points({ tip: HANGING_TIP, t, pose: { angles: pose.angles, blend } });
  const target = pose.angles[0] + 0.3 * wind(0, t);
  const hanging = 90 + wind(0, t);
  const actual = degrees(chords(points)[0]);
  assert.ok(Math.sign(actual - target) === Math.sign(target - hanging) && Math.abs(actual - target) > 0.1, 'the first segment swings past its pose angle');
});

test('payout scales the length', () => {
  const chain = createChain();
  for (const payout of [0.5, 1, 1.59]) {
    const length = polylineLength(chain.points({ tip: HANGING_TIP, t: 1, payout, floor: Infinity }));
    assert.ok(Math.abs(length - 60 * payout) < 1e-9, `payout ${payout} gives ${length}`);
  }
  const pose = jPose();
  const points = chain.points({ tip: HANGING_TIP, t: 1, pose: fullPose(pose), payout: pose.length / 60, floor: Infinity });
  const wanted = pose.proportions.map((p) => (p * pose.length) / SEGMENTS);
  chords(points).forEach((chord, i) => assert.ok(Math.abs(Math.hypot(...chord) - wanted[i]) < 1e-9, `segment ${i} keeps its chord`));
});

test('a written route grows with its length and tucks in', () => {
  const route = fistRoute();
  const chain = createChain();
  const written = (length) => chain.points({ tip: HANGING_TIP, t: 1, written: { route, length, scale: HAND_SCALE, tremor: 0 } });

  const writtenLength = (length) => polylineLength(written(length).slice(SEGMENTS));
  assert.equal(written(0).length, SEGMENTS + 130);
  assert.ok(writtenLength(0) < 1e-6, 'nothing is written at length 0');
  assert.ok(writtenLength(20) < writtenLength(60), 'more is written at 60 than at 20');
  assert.ok(writtenLength(60) < writtenLength(route.totalLength), 'more still at the full length');

  const [x, y] = route.points.at(-1);
  assert.ok(Math.abs(x) < 20 && y > 0 && y < 22, 'the stroke ends inside the palm');
  const full = written(route.totalLength);
  const wrist = full[SEGMENTS];
  assert.ok(Math.abs(Math.hypot(full.at(-1)[0] - wrist[0], full.at(-1)[1] - wrist[1]) - HAND_SCALE * Math.hypot(x, y)) < 1e-9, 'the string ends where the route ends');
});

test('a lying string never goes below the floor', () => {
  const pose = lyingPose();
  const chain = createChain();
  for (let t = 0; t < 6; t += 0.37) {
    const points = chain.points({ tip: STANDING_TIP, t, pose: fullPose(pose) });
    assert.ok(points.every(([, y]) => y <= FLOOR), `a point is below the floor at ${t} s`);
    assert.ok(points.at(-1)[0] < STANDING_TIP[0] - 45, 'the string lies to the left');
  }
  const raised = chain.points({ tip: STANDING_TIP, t: 1, pose: fullPose(pose), floor: 233 });
  assert.ok(raised.every(([, y]) => y <= 233), 'the floor can be set');
});

test('drag leans the chain away from the motion', () => {
  const chain = createChain();
  const end = (drag) => chain.points({ tip: HANGING_TIP, t: 1, drag }).at(-1)[0];
  assert.ok(end(300) < end(0), 'moving right leans the string left');
  assert.ok(end(-300) > end(0), 'moving left leans the string right');
  assert.ok(Number.isFinite(end(1e9)), 'a huge speed is capped');
});

test('the chain is a pure function of time', () => {
  const afterStepping = (step) => {
    const chain = createChain();
    for (let t = 0; t < 0.5 - 1e-9; t += step) chain.points({ tip: HANGING_TIP, t, drag: 50 });
    return chain.points({ tip: HANGING_TIP, t: 0.5, drag: 50 });
  };
  assert.deepEqual(afterStepping(1 / 30), afterStepping(1 / 60));
  assert.deepEqual(afterStepping(1 / 60), afterStepping(1 / 144));
});
