import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWarning } from './warning.js';

test('a voice problem is said once until Google answers again or the button is switched on, and marks the button while it lasts', () => {
  const shown = [];
  const said = [];
  const warning = createWarning({ show: (message) => shown.push(message), say: (message) => said.push(message) });

  // Every clip that fails the same way marks the button again but adds nothing to the thread.
  warning.report('quota');
  warning.report('quota');
  warning.report('key');
  warning.report('quota');
  assert.deepEqual(said, ['quota', 'key'], 'one notice for each message');
  assert.deepEqual(shown, ['quota', 'quota', 'key', 'quota']);

  // Google answering clears the mark and says nothing; the same trouble coming back is news again.
  warning.report(null);
  assert.deepEqual([shown.at(-1), said.length], [null, 2]);
  warning.report('quota');
  assert.deepEqual(said, ['quota', 'key', 'quota']);

  // Switching the button on starts afresh, even with the problem still showing.
  warning.switchedOn();
  warning.report('quota');
  assert.deepEqual(said, ['quota', 'key', 'quota', 'quota']);
});
