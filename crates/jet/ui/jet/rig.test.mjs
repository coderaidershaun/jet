import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathFrom, ANCHORS } from './rig.js';

test('pathFrom writes one closed path with a curve per anchor', () => {
  const pose = Array.from({ length: ANCHORS * 6 }, (_, i) => i);
  const d = pathFrom(pose);
  assert.ok(d.startsWith('M0.0 1.0 C2.0 3.0'));
  assert.equal((d.match(/ C/g) || []).length, ANCHORS);
  assert.ok(d.endsWith(' Z'));
});
