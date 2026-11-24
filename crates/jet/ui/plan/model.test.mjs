import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { clockWords, costWords, daysLeftWords, groupObjectives, heldReason, keysOf, dueWords, newCount, noteTone, outcomeOf, readPane, relativeWords, sharedWithWords, stepProgress, isEmpty, rangeWords } from './model.js';

const pane = readPane(JSON.parse(readFileSync(new URL('../../tests/fixtures/pane.json', import.meta.url), 'utf8')));

test('each way a check can end has its plain words, and a run that has not ended is running', () => {
  assert.deepEqual(['spoke', 'silent', 'held', 'preempted', 'interrupted', 'failed', 'stale', null].map((o) => outcomeOf(o).words), [
    'Wrote to you', 'Stayed quiet', 'Could not read a source', 'Stopped because you wrote', 'Stopped because you wrote', 'Failed', 'Skipped, out of date', 'Running',
  ]);
  assert.equal(heldReason('held: no evidence'), 'No evidence');
  assert.deepEqual(['on track', 'at risk', 'blocked', 'hmm'].map(noteTone), ['good', 'warn', 'bad', 'quiet']);
});

test('days left read as words, overdue and close ones in a loud tone', () => {
  assert.deepEqual(daysLeftWords(31), { words: '31 days left', tone: 'quiet' });
  assert.deepEqual(daysLeftWords(1), { words: '1 day left', tone: 'warn' });
  assert.deepEqual(daysLeftWords(0), { words: 'Due today', tone: 'warn' });
  assert.deepEqual(daysLeftWords(-2), { words: '2 days overdue', tone: 'bad' });
});

test('dates, local times and distances read as words', () => {
  const [kite] = pane.objectives;
  assert.equal(rangeWords(kite, 2026), '1 Jan to 1 Feb · 31 days');
  assert.equal(rangeWords(kite, 2027), '1 Jan 2026 to 1 Feb 2026 · 31 days');
  assert.equal(dueWords(pane.tasks[0].dueAt, pane.timeZone, 2026), 'Mon 5 Jan, 09:00');
  assert.equal(relativeWords(2 * 86400 + 60), 'in 2 days');
  assert.equal(relativeWords(-300), '5 min ago');
  assert.equal(clockWords(1767603600, 'Europe/London'), '5 Jan, 09:00');
});

test('the fixture pane reads: groups, steps, sharing, cost and the empty pane', () => {
  assert.equal(groupObjectives(pane.objectives).active.length, 1);
  assert.deepEqual(stepProgress(pane.objectives[0].steps), { done: 0, total: 1 });
  assert.equal(sharedWithWords(pane.objectives[0]), 'bob@example.com');
  assert.equal(sharedWithWords({ sharedWith: { people: [], teams: [] } }), 'Only you');
  assert.equal(costWords(0.0123), '$0.01');
  assert.equal(costWords(undefined), '');
  assert.equal(isEmpty(pane), false);
  assert.equal(isEmpty(readPane({ objectives: 'nonsense' })), true);
});

test('a thing counts as new until the user has opened the pane with it there', () => {
  const keys = keysOf(pane);
  assert.equal(newCount(pane, new Set()), keys.length);
  assert.equal(newCount(pane, new Set(keys)), 0);
  const moved = { ...pane, runs: [...pane.runs, { id: 99 }] };
  assert.equal(newCount(moved, new Set(keys)), 1);
});
