import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countCodePoints, hexToRgb, moveMaster, rgbToHex, takeOverChannel } from './form.js';
import { defaultSettings } from '../../bridge/settings.js';

test('hex and rgb convert both ways and a bad hex is refused', () => {
  assert.deepEqual(hexToRgb('#ff6a3d'), [255, 106, 61]);
  assert.deepEqual(hexToRgb('FF6A3D'), [255, 106, 61], 'the hash is optional and case does not matter');
  assert.equal(rgbToHex([255, 106, 61]), '#ff6a3d');
  assert.equal(rgbToHex([0, 5, 255]), '#0005ff');
  assert.deepEqual(hexToRgb(rgbToHex([12, 200, 99])), [12, 200, 99]);
  for (const bad of ['', '#ff6a3', '#ff6a3dd', '#ff6a3g', 'coral', '#f63']) assert.equal(hexToRgb(bad), null, JSON.stringify(bad));
});

test('counters count code points and the master moves only the channels that follow it', () => {
  assert.equal(countCodePoints('abc'), 3);
  assert.equal(countCodePoints('a😀b'), 3, 'an emoji is one, as the Rust limit counts it');
  assert.equal(countCodePoints(''), 0);

  const start = defaultSettings().expressiveness;
  const moved = moveMaster(start, 9.04);
  assert.equal(moved.master, 9);
  assert.deepEqual(moved.channels, { shape: 9, eyes: 4, colour: 9, motion: 9 }, 'eyes does not follow, so it stays');
  assert.deepEqual(start.channels, { shape: 6, eyes: 4, colour: 6, motion: 6 }, 'the old value is untouched');
  assert.equal(moveMaster(start, 12).master, 10);
  assert.equal(moveMaster(start, -3).master, 0);

  const taken = takeOverChannel(moved, 'shape', 2);
  assert.equal(taken.channels.shape, 2);
  assert.equal(taken.follow.shape, false, 'moving a channel takes it off the master');
  assert.equal(moveMaster(taken, 5).channels.shape, 2);
});
