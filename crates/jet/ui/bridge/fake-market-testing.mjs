// What the tests of the pretend market and of the pretend feed share: a fixed start time, a
// source of chance that can be repeated, a market on a clock the test moves by hand, and two
// checks of shape.

import assert from 'node:assert/strict';
import { createFakeMarket } from './fake-market.js';
import { defaultSettings } from './settings.js';

export const START = Date.UTC(2026, 9, 14, 12, 34, 56, 789);
export const FRAME_MS = 16;

/** A small seeded random number generator, so a run can be repeated. */
export function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A market on a clock the test moves by hand. */
export function newMarket(seed = 7) {
  const clock = { t: START };
  const market = createFakeMarket({ now: () => clock.t, random: seeded(seed), workstation: defaultSettings().workstation });
  return { market, clock };
}

const keysOf = (object) => Object.keys(object).sort();
export const assertKeys = (object, expected, what) => assert.deepEqual(keysOf(object), [...expected].sort(), what);
/** A bucket always has all its prices; `gap` only says that the line breaks before it. */
export const assertSolidBucket = (bucket) => {
  for (const key of ['o', 'h', 'l', 'c']) assert.ok(Number.isInteger(bucket[key]), 'a bucket has an integer ' + key + ', not ' + bucket[key]);
  assert.equal(typeof bucket.cl, 'string', 'and a close text');
  assert.equal(typeof bucket.gap, 'boolean');
};
