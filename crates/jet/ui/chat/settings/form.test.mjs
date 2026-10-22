import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countCodePoints } from './form.js';

test('counters count code points', () => {
  assert.equal(countCodePoints('abc'), 3);
  assert.equal(countCodePoints('a😀b'), 3, 'an emoji is one, as the Rust limit counts it');
  assert.equal(countCodePoints(''), 0);
});
