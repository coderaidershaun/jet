import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cubicBezier } from './easing.js';
import { sample } from './track.js';

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
