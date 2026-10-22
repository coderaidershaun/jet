import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cubicBezier, easeIn, easeInOut, easeOut, easeOutBack, pulse, ramp, smoothstep } from './easing.js';

test('cubicBezier pins both ends', () => {
  const ease = cubicBezier(0.2, 0.8, 0.3, 1);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(Math.abs(cubicBezier(0, 0, 1, 1)(0.37) - 0.37) < 1e-6);
});

test("the scripts' curves give their exact values", () => {
  assert.equal(easeInOut(0.25), 0.0625);
  assert.equal(easeInOut(0.75), 0.9375);
  assert.equal(easeOut(0.5), 0.875);
  assert.equal(easeIn(0.5), 0.125);
  assert.ok(Math.abs(easeOutBack(1.4)(0.5) - 1.05) < 1e-12);
  assert.ok(Math.abs(easeOutBack(0.9)(0.5) - 0.9875) < 1e-12);
  assert.equal(easeOutBack()(0), 0);
  assert.equal(easeOutBack()(1), 1);
  assert.ok(Math.abs(smoothstep(0.25) - 0.103515625) < 1e-12);
  assert.equal(smoothstep(-3), 0);
  assert.equal(smoothstep(4), 1);
  assert.equal(ramp(1, 0, 2), 0.5);
  assert.equal(ramp(5, 0, 2), 1);
  assert.equal(pulse(1.5, 1, 2, 3), easeOut(0.5));
  assert.equal(pulse(3, 1, 2, 3), 0);
});
