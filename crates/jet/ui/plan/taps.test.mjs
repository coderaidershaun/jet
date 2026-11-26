// Tests plan taps: the two-tap cancel, failure notices, queued taps and failed jobs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { disarm, idleTaps, inOrder, pressCancel, tapEnded } from './taps.js';

test('Cancel sends nothing on the first tap and sends on the second tap of the same check', () => {
  const first = pressCancel(idleTaps, 7);
  assert.equal(first.send, false);
  assert.equal(first.taps.armed, 7);
  assert.equal(pressCancel(first.taps, 8).send, false, 'a tap on another check arms that one instead');
  assert.equal(pressCancel(disarm(first.taps), 7).send, false, 'after the wait runs out it starts over');
  const second = pressCancel(first.taps, 7);
  assert.equal(second.send, true);
  assert.equal(second.taps.armed, null);
});

test('a failed tap leaves a notice in plain words until a later tap works', () => {
  const failed = tapEnded('The step could not be changed', { kind: 'internal', message: 'the database is busy' });
  assert.equal(failed.notice, 'The step could not be changed. The database is busy. Try again.');
  assert.equal(tapEnded('The check could not be snoozed', { kind: 'network', message: 'Failed to fetch' }).notice, 'The check could not be snoozed. Jet could not be reached. Try again.');
  assert.equal(disarm(failed).notice, failed.notice, 'nothing but a tap clears it');
  assert.equal(tapEnded('The step could not be changed', null).notice, '');
});

test('a tap made while another call runs waits for it and is not dropped', async () => {
  const run = inOrder();
  const seen = [];
  let release;
  const first = run(() => new Promise((resolve) => { release = resolve; }).then(() => seen.push('first')));
  const second = run(async () => { seen.push('second'); });
  await new Promise(setImmediate);
  assert.deepEqual(seen, [], 'the second waits while the first runs');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(seen, ['first', 'second']);
});

test('a failed job does not stop the ones after it', async () => {
  const run = inOrder();
  const failing = run(async () => { throw new Error('no'); });
  await assert.rejects(failing);
  assert.equal(await run(async () => 'ok'), 'ok');
});
