import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cubicBezier } from './easing.js';
import { lerp, pathFrom, sample, ANCHORS } from './rig.js';

test('lerp blends numbers and arrays, and keeps going past 1', () => {
  assert.equal(lerp(0, 10, 0.25), 2.5);
  assert.deepEqual(lerp([0, 0], [10, 20], 0.5), [5, 10]);
  assert.deepEqual(lerp([0, 0], [10, 20], 1.5), [15, 30]);
});

test('pathFrom writes one closed path with a curve per anchor', () => {
  const pose = Array.from({ length: ANCHORS * 6 }, (_, i) => i);
  const d = pathFrom(pose);
  assert.ok(d.startsWith('M0.0 1.0 C2.0 3.0'));
  assert.equal((d.match(/ C/g) || []).length, ANCHORS);
  assert.ok(d.endsWith(' Z'));
});

test('sample holds the first value before the track and the last after it', () => {
  const track = [{ t: 100, v: 1 }, { t: 200, v: 3 }];
  assert.equal(sample(track, 0), 1);
  assert.equal(sample(track, 150), 2);
  assert.equal(sample(track, 999), 3);
});

test('sample applies the easing stored on the key it is arriving at', () => {
  const easeIn = cubicBezier(0.9, 0, 1, 1);
  const track = [{ t: 0, v: 0 }, { t: 100, v: 100, e: easeIn }];
  assert.ok(sample(track, 50) < 25, 'ease-in should lag a linear ramp at the midpoint');
});

test('cubicBezier pins both ends', () => {
  const ease = cubicBezier(0.2, 0.8, 0.3, 1);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(Math.abs(cubicBezier(0, 0, 1, 1)(0.37) - 0.37) < 1e-6);
});
