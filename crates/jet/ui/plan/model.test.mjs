import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { closedWords, clockWords, costWords, daysLeftWords, groupObjectives, heldReason, keysOf, dueWords, newCount, nextCheck, noteTone, outcomeOf, readPane, relativeWords, runTitle, sharedWithWords, stepDueWords, stepsEndWords, stepProgress, isEmpty, dueDayWords, tokensWords, needsFirst, scopeOf, dayWords, timeWords, progressWords, latestRecord } from './model.js';

const pane = readPane(JSON.parse(readFileSync(new URL('../../tests/fixtures/pane.json', import.meta.url), 'utf8')));

test('each way a check can end has its plain words, and a run that has not ended is running', () => {
  assert.deepEqual(['spoke', 'silent', 'held', 'preempted', 'interrupted', 'failed', 'stale', null].map((o) => outcomeOf(o).words), [
    'Wrote to you', 'Stayed quiet', 'Could not read a source', 'Stopped because you wrote', 'Cut off by a restart', 'Failed', 'Skipped, out of date', 'Running',
  ]);
  assert.equal(heldReason('held: no evidence'), 'No evidence');
  assert.deepEqual(['on track', 'at risk', 'blocked', 'hmm'].map(noteTone), ['good', 'warn', 'bad', 'quiet']);
});

test('days left read as words, only overdue ones in a loud tone', () => {
  assert.deepEqual(daysLeftWords(31), { words: '31 days left', tone: 'quiet' });
  assert.deepEqual(daysLeftWords(1), { words: '1 day left', tone: 'quiet' });
  assert.deepEqual(daysLeftWords(0), { words: 'Due today', tone: 'quiet' });
  assert.deepEqual(daysLeftWords(-2), { words: '2 days overdue', tone: 'bad' });
});

test('dates, local times and distances read as words', () => {
  const [kite] = pane.objectives;
  assert.equal(dueDayWords(kite.due, 2026), 'Sun 1 Feb');
  assert.equal(dueDayWords(kite.due, 2027), 'Sun 1 Feb 2026');
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
  assert.deepEqual(stepDueWords(step, '2026-01-05', 2026), { words: 'Today', tone: 'quiet' });
  assert.deepEqual(stepDueWords({ ...step, doneAt: 1 }, '2026-01-06', 2026), { words: '5 Jan', tone: 'quiet' });
  assert.deepEqual(stepDueWords(step, '2026-01-02', 2026, '2026-01-04'), { words: '5 Jan, after the due date', tone: 'quiet' });
  // The due date moved to the 9th and the steps stayed: the pane says so until a step reaches it or a newer note comes.
  const moved = { due: '2026-01-09', steps: [step, { due: '2026-01-07', doneAt: 1 }], notes: [{ newDates: 'due Fri 9 Jan (was Mon 5 Jan)' }] };
  assert.equal(stepsEndWords(moved, 2026), 'Steps end 5 Jan, before the new due date.');
  assert.equal(stepsEndWords({ ...moved, steps: [{ due: '2026-01-09', doneAt: null }] }, 2026), '');
  assert.equal(stepsEndWords({ ...moved, notes: [...moved.notes, { newDates: '' }] }, 2026), '');
  assert.equal(closedWords(pane.objectives[1], pane.timeZone, 2026), 'Closed 1 Jan');
});

test('objectives that need the user come first, each group by due date, and a day and time read in words', () => {
  const calm = { id: 1, status: 'active', daysLeft: 9, due: '2026-02-01', notes: [{ status: 'on track' }], steps: [{ doneAt: 1 }, {}] };
  const late = { id: 2, status: 'active', daysLeft: -2, due: '2026-03-01', notes: [], steps: [] };
  const risky = { id: 3, status: 'active', daysLeft: 5, due: '2026-02-20', notes: [{ status: 'at risk' }], steps: [] };
  assert.deepEqual(needsFirst([calm, late, risky]).map((o) => o.id), [3, 2, 1]);
  assert.equal(progressWords(calm.steps), '1/2');
  assert.equal(progressWords([]), '');
  const at = pane.tasks[0].dueAt;
  assert.deepEqual([dayWords(at, pane.timeZone, at - 60, 2026), dayWords(at, pane.timeZone, at - 86400, 2026), dayWords(at, pane.timeZone, at - 3 * 86400, 2026), timeWords(at, pane.timeZone)], ['Today', 'Tomorrow', 'Mon 5 Jan', '09:00']);
  assert.equal(nextCheck(pane.objectives[0]).id, 1);
  assert.equal(nextCheck(pane.objectives[1]), null);
});

test("an objective's own chat holds that objective, its tasks and the follow-ups set in it, and nothing else; the main chat holds all", () => {
  const [kite] = pane.objectives;
  const other = { id: 9, chatId: 99 };
  const all = { ...pane, objectives: [kite, other], tasks: [...pane.tasks, { id: 50, objectiveId: null, chatId: kite.chatId }, { id: 51, objectiveId: 9, chatId: 99 }, { id: 52, objectiveId: null, chatId: 7 }] };
  const scope = scopeOf(all, kite.chatId, 1000);
  assert.deepEqual(scope.objectives.map((o) => o.id), [kite.id]);
  assert.deepEqual(scope.tasks.map((t) => t.id), [...pane.tasks.filter((t) => t.objectiveId === kite.id).map((t) => t.id), 50]);
  assert.equal(scopeOf(all, 1000, 1000), null);
  assert.equal(scopeOf(all, 12345, 1000), null, 'a chat nothing belongs to shows the main view');
});

test('a step or note is read from the latest pane, so a queued tap works from what the tap before it left', () => {
  const stale = { id: 4, startedAt: null, doneAt: null };
  const pane = { objectives: [{ steps: [{ id: 4, startedAt: 1, doneAt: null }], notes: [{ id: 9, isPrivate: true }] }] };
  assert.equal(latestRecord(pane, 'steps', stale).startedAt, 1);
  assert.equal(latestRecord(pane, 'notes', { id: 9, isPrivate: false }).isPrivate, true);
  assert.equal(latestRecord(null, 'steps', stale), stale);
});
