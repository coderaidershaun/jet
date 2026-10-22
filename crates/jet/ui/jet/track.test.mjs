import { test } from 'node:test';
import assert from 'node:assert/strict';
import { easeIn } from './easing.js';
import { hold, sample } from './track.js';

test('sample holds the ends and applies the easing on the key it arrives at', () => {
  const track = [{ t: 100, v: 1 }, { t: 200, v: 3, e: easeIn }, { t: 300, v: 4 }];
  assert.equal(sample(track, 0), 1, 'the first value holds before the track');
  assert.equal(sample(track, 150), 1 + 2 * easeIn(0.5), 'the easing of the key being arrived at shapes the move');
  assert.equal(sample(track, 250), 3.5, 'a key with no easing is linear');
  assert.equal(sample(track, 999), 4, 'the last value holds after the track');

  const pair = [{ t: 0, v: [0, 4] }, { t: 100, v: [2, 0] }];
  assert.deepEqual(sample(pair, 50), [1, 2], 'arrays blend item by item');
});

test('hold gives the latest key at or before t', () => {
  const track = [{ t: 0, v: 'round' }, { t: 60, v: 'lid' }, { t: 500, v: 'B' }];
  assert.equal(hold(track, -5), 'round', 'before the first key the first value holds');
  assert.equal(hold(track, 59), 'round');
  assert.equal(hold(track, 60), 'lid', 'a key takes hold at its own time');
  assert.equal(hold(track, 400), 'lid', 'nothing blends between two kinds');
  assert.equal(hold(track, 9999), 'B');
});
