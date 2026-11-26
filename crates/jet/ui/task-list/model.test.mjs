// The task list's rules that need no page: the agenda's parts and counts, the status cycle, the keyboard moves and
// the words of a row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agendaGroups, applyPatch, chipWords, goalStats, keyboardMove, matches, nextState, oneLine, readTaskList, sinceWords, summaryCounts } from './model.js';

const task = (id, day, extra = {}) => ({ id, title: `Task ${id}`, goalId: null, goalTitle: null, chatId: 1, date: null, day, late: false, state: 'not_started', startedAt: null, doneAt: null, ...extra });
const list = (tasks, done = []) => readTaskList({ timeZone: 'Europe/London', today: '2026-11-25', tomorrow: '2026-11-26', mainChatId: 1, doneCount: done.length, goals: [], tasks, done });
const late = (id) => task(id, 'today', { date: '2026-11-23', late: true });
const ids = (tasks) => tasks.map((t) => t.id);

test('a read of the wrong shape is empty, and late tasks leave Today for Overdue in the one order', () => {
  assert.deepEqual(readTaskList('nonsense').tasks, []);
  const read = list([task(1, 'later'), late(5), task(2, 'today', { state: 'in_progress' }), { id: 'x' }, task(3, 'tomorrow'), task(4, 'today')], [task(9, null, { doneAt: Date.parse('2026-11-25T09:00Z') / 1000 })]);
  const groups = agendaGroups(read);
  assert.deepEqual([groups.late, groups.today, groups.tomorrow, groups.later].map(ids), [[5], [2, 4], [3], [1]]);
  assert.deepEqual(summaryCounts(read), { overdue: 1, dueToday: 2, inProgress: 1, doneToday: 1 });
});

test('the box goes gray, yellow, green, and back to where it was before', () => {
  assert.equal(nextState({ state: 'not_started' }), 'in_progress');
  assert.equal(nextState({ state: 'in_progress' }), 'done');
  assert.equal(nextState({ state: 'done', startedAt: 10 }), 'in_progress');
  assert.equal(nextState({ state: 'done', startedAt: null }), 'not_started');
  assert.throws(() => nextState({ state: 'lost' }), /unknown state lost/);
});

test('Alt and an arrow move one place, and over the edge of a day to the next, but not while a filter is on', () => {
  const read = list([task(1, 'today'), task(2, 'today'), task(3, 'today'), task(4, 'tomorrow')]);
  assert.deepEqual(keyboardMove(read, 3, -1), { day: 'today', after: 1 });
  assert.deepEqual(keyboardMove(read, 2, -1), { day: 'today', after: null });
  assert.equal(keyboardMove(read, 1, -1), null);
  assert.deepEqual(keyboardMove(read, 3, 1), { day: 'tomorrow', after: null });
  assert.deepEqual(keyboardMove(read, 4, -1), { day: 'today', after: 3 });
  assert.deepEqual(keyboardMove(read, 4, 1), { day: 'later', after: null });
  assert.equal(keyboardMove(read, 3, -1, true), null);
});

test('a late task is never moved one place, so it keeps its date', () => {
  const read = list([task(1, 'today'), late(2), task(3, 'today')]);
  assert.equal(keyboardMove(read, 2, -1), null);
  assert.equal(keyboardMove(read, 2, 1), null);
});

test('a one-place move in Today counts only the rows in view and never names a late task as after', () => {
  const read = list([task(1, 'today'), late(7), task(2, 'today'), late(8), task(3, 'today'), task(4, 'tomorrow')]);
  assert.deepEqual(keyboardMove(read, 3, -1), { day: 'today', after: 1 }, 'up from the third shown row lands after the first');
  assert.deepEqual(keyboardMove(read, 1, 1), { day: 'today', after: 2 }, 'down steps past the late task beside it');
  assert.deepEqual(keyboardMove(read, 4, -1), { day: 'today', after: 3 }, 'up from Tomorrow lands after the last shown row');
  const moved = applyPatch(read, 3, keyboardMove(read, 3, -1), 0);
  assert.deepEqual(ids(agendaGroups(moved).today), [1, 3, 2]);
  assert.deepEqual(ids(agendaGroups(moved).late), [7, 8]);
});

test('a move shows at once with the date of the day rule, and a late task moved to Today keeps its place', () => {
  const read = list([late(1), task(2, 'today'), task(3, 'tomorrow', { date: '2026-11-26' })]);
  const moved = applyPatch(read, 1, { day: 'tomorrow', after: 3 }, 0);
  assert.deepEqual([ids(agendaGroups(moved).today), ids(agendaGroups(moved).tomorrow)], [[2], [3, 1]]);
  assert.equal(moved.tasks.find((t) => t.id === 1).date, '2026-11-26');
  const today = applyPatch(read, 1, { day: 'today' }, 0);
  assert.deepEqual([ids(today.tasks), today.tasks[0].late, today.tasks[0].date], [[1, 2, 3], false, '2026-11-25']);
});

test('a row says how late, how soon and how long in words, and a title is one line', () => {
  const read = list([]);
  assert.deepEqual(chipWords(late(1), read, 2026), { tone: 'late', lead: '', words: '2 days late', name: 'Was due Mon 23 Nov. Move' });
  assert.equal(chipWords(task(2, 'later', { date: '2026-11-29' }), read, 2026).name, 'Due Sun 29 Nov, in 4 days. Move');
  assert.equal(chipWords(task(3, 'later', { date: '2026-12-04' }), read, 2026).words, 'Fri 4 Dec');
  const now = Date.parse('2026-11-26T12:00Z') / 1000;
  assert.equal(sinceWords(Date.parse('2026-11-26T09:30Z') / 1000, now, 'Europe/London'), 'since 09:30');
  assert.equal(sinceWords(Date.parse('2026-11-24T09:30Z') / 1000, now, 'Europe/London'), 'since Tue');
  assert.equal(sinceWords(Date.parse('2026-11-16T09:30Z') / 1000, now, 'Europe/London'), 'since 16 Nov · 10 days');
  assert.equal(oneLine('Call the bank\n\nabout the loan'), 'Call the bank about the loan');
});

test('each filter shows its own tasks, and a goal leads with its late task', () => {
  const doneToday = task(9, null, { goalId: 4, doneAt: Date.parse('2026-11-25T09:00Z') / 1000 });
  const read = list([task(1, 'later', { goalId: 4 }), late(2), task(3, 'today', { state: 'in_progress' }), { ...late(5), goalId: 4 }], [doneToday]);
  const shown = (filter) => ids([...read.tasks, ...read.done].filter((t) => matches(t, filter, read)));
  assert.deepEqual([shown('late'), shown('today'), shown('progress'), shown('done'), shown({ goalId: 4 }), shown(null)], [[2, 5], [3], [3], [9], [1, 5, 9], [1, 2, 3, 5, 9]]);
  assert.deepEqual(goalStats(read, { id: 4 }), { inProgress: 0, late: 1, next: read.tasks.find((t) => t.id === 5) });
  assert.throws(() => matches(read.tasks[0], 'soon', read), /unknown filter soon/);
  assert.throws(() => chipWords({ ...task(6, 'someday'), date: null }, read, 2026), /unknown day someday/);
});
