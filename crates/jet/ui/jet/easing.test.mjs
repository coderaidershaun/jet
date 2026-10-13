import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cubicBezier } from './easing.js';

test('cubicBezier pins both ends', () => {
  const ease = cubicBezier(0.2, 0.8, 0.3, 1);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(Math.abs(cubicBezier(0, 0, 1, 1)(0.37) - 0.37) < 1e-6);
});
