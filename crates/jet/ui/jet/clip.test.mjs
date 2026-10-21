import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClip, readDials } from './clip.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../rig/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };

test('a writer refuses t without its brackets and says how to write it', () => {
  const { eye, t } = createClip(1);
  assert.throws(() => eye(t, [0, 0, 0, 0, 0, 0]), (error) => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, /eyes/);
    assert.match(error.message, /t\(\)/);
    return true;
  });
});

test('a face is sized by the eyes dial and hidden eyes have no size', () => {
  const { eyes, hiddenEyes, eyeSize } = readDials(rig, shipmate);
  const face = eyes('soft', 4, 4);
  assert.equal(face.length, 6);
  assert.deepEqual(face.slice(4), [4 * eyeSize, 4 * eyeSize], 'a face is sized by the eyes dial');
  const hidden = hiddenEyes('soft');
  assert.equal(hidden.length, 6);
  assert.deepEqual(hidden.slice(4), [0, 0], 'hidden eyes have no size');
  assert.deepEqual(hidden.slice(0, 4), face.slice(0, 4), 'both sit where the pose puts its eyes');
});
