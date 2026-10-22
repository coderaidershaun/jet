import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerp } from './maths.js';

test('lerp blends numbers and arrays, and keeps going past 1', () => {
  assert.equal(lerp(0, 10, 0.25), 2.5);
  assert.deepEqual(lerp([0, 0], [10, 20], 0.5), [5, 10]);
  assert.deepEqual(lerp([0, 0], [10, 20], 1.5), [15, 30]);
});
