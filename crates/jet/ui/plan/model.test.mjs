import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { closedWords, clockWords, costWords, daysLeftWords, firstOpen, groupObjectives, heldReason, keysOf, dueWords, newCount, nextCheck, noteTone, outcomeOf, readPane, relativeWords, runTitle, sharedWithWords, stepDueWords, stepProgress, isEmpty, rangeWords, tokensWords } from './model.js';

const pane = readPane(JSON.parse(readFileSync(new URL('../../tests/fixtures/pane.json', import.meta.url), 'utf8')));

test('each way a check can end has its plain words, and a run that has not ended is running', () => {
  assert.deepEqual(['spoke', 'silent', 'held', 'preempted', 'interrupted', 'failed', 'stale', null].map((o) => outcomeOf(o).words), [
    'Wrote to you', 'Stayed quiet', 'Could not read a source', 'Stopped because you wrote', 'Cut off by a restart', 'Failed', 'Skipped, out of date', 'Running',
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
  assert.equal(relativeWords(1.6 * 86400), 'in 2 days');
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
  assert.equal(`${tokensWords(0)}${costWords(0)}`, '', 'a free check says nothing about cost');
  assert.equal(isEmpty(pane), false);
  assert.equal(isEmpty(readPane({ objectives: 'nonsense' })), true);
});

test("the count is of what Jet and colleagues did since the user last looked, not of the user's own taps", () => {
  const keys = new Set(keysOf(pane));
  assert.equal(newCount(pane, keys), 0);
  assert.equal(newCount({ ...pane, runs: [...pane.runs, { id: 99 }] }, keys), 1, 'a check that ran');
  assert.equal(newCount({ ...pane, tasks: pane.tasks.map((t) => ({ ...t, version: t.version + 1 })) }, keys), 1, 'a check that moved');
  assert.equal(newCount({ ...pane, objectives: pane.objectives.map((o) => ({ ...o, version: o.version + 1 })) }, keys), 0, 'a step the user ticked');
});

test('a check names its objective, or says it is a follow-up and why', () => {
  assert.equal(runTitle(pane.runs[0]), 'Ship the kite');
  assert.equal(runTitle({ objectiveId: null, title: 'Follow-up', why: 'ask about the venue' }), 'Follow-up: ask about the venue');
});

test('a passed step is late, today is amber, and a done objective shows the day it closed', () => {
  const step = { due: '2026-01-05', doneAt: null };
  assert.deepEqual(stepDueWords(step, '2026-01-06', 2026), { words: '5 Jan, late', tone: 'bad' });
  assert.deepEqual(stepDueWords(step, '2026-01-05', 2026), { words: 'Today', tone: 'warn' });
  assert.deepEqual(stepDueWords({ ...step, doneAt: 1 }, '2026-01-06', 2026), { words: '5 Jan', tone: 'quiet' });
  assert.equal(closedWords(pane.objectives[1], pane.timeZone, 2026), 'Closed 1 Jan');
});

test('the overdue objective, else the one changed last, is drawn open; each shows its next check', () => {
  assert.equal(firstOpen([{ id: 1, daysLeft: 3, updatedAt: 9 }, { id: 2, daysLeft: 5, updatedAt: 1 }]), 1);
  assert.equal(firstOpen([{ id: 1, daysLeft: 3, updatedAt: 9 }, { id: 2, daysLeft: -1, updatedAt: 1 }]), 2);
  assert.equal(nextCheck(pane.objectives[0]).id, 1);
  assert.equal(nextCheck(pane.objectives[1]), null);
});
