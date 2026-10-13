import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClip } from './clip.js';

test('a writer refuses t without its brackets and says how to write it', () => {
  const { eye, t } = createClip(1);
  assert.throws(() => eye(t, [0, 0, 0, 0, 0, 0]), (error) => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, /eyes/);
    assert.match(error.message, /t\(\)/);
    return true;
  });
});
