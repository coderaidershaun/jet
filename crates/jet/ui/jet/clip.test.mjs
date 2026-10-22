import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClip } from './clip.js';

test('a writer refuses t without its brackets and says how to write it', () => {
  const { lids, y, t } = createClip();
  assert.throws(() => lids(t, [0, 0]), (error) => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, /lids/);
    assert.match(error.message, /t\(\)/);
    return true;
  });
  assert.throws(() => y(NaN, 0), TypeError);

  const chained = createClip();
  chained.y(300, 10);
  chained.y(chained.t() + 320, 64);
  chained.roll(100, 1);
  assert.deepEqual(chained.clip.y.map((key) => key.t), [300, 620], 't() follows the latest key time on any track and never moves back');
  assert.equal(chained.t(), 620);
});

test('finish checks that revealFrom names a phase', () => {
  const { clip, y, phase, finish } = createClip();
  y(180, 4);
  phase('dip');
  y(500, 0);
  phase('lift');
  assert.throws(() => finish({ revealFrom: 'wag' }), /revealFrom "wag".*dip, lift/);
  assert.equal(finish({ revealFrom: 'lift' }), clip);
  assert.equal(clip.total, 500);
  assert.equal(clip.revealFrom, 'lift');
  assert.equal(createClip().finish().revealFrom, null);
});
