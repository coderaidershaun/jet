// The task list's rules that need no page: the days in order, the status cycle and the keyboard moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, dayGroups, keyboardMove, metaWords, nextState, readTaskList } from './model.js';

const task = (id, day, extra = {}) => ({ id, title: `Task ${id}`, goalId: null, goalTitle: null, chatId: 1, date: null, day, late: false, state: 'not_started', startedAt: null, doneAt: null, ...extra });
const list = (tasks, done = []) => readTaskList({ timeZone: 'Europe/London', today: '2026-11-25', tomorrow: '2026-11-26', mainChatId: 1, doneCount: done.length, goals: [], tasks, done });

test('a read of the wrong shape is empty, and the days keep the one order', () => {
  assert.deepEqual(readTaskList('nonsense').tasks, []);
  const read = list([task(1, 'later'), task(2, 'today'), { id: 'x' }, task(3, 'tomorrow'), task(4, 'today')]);
  const groups = dayGroups(read);
  assert.deepEqual(Object.keys(groups), ['today', 'tomorrow', 'later']);
  assert.deepEqual([groups.today, groups.tomorrow, groups.later].map((day) => day.map((t) => t.id)), [[2, 4], [3], [1]]);
});

test('the box goes gray, yellow, green, and back to where it was before', () => {
  assert.equal(nextState({ state: 'not_started' }), 'in_progress');
  assert.equal(nextState({ state: 'in_progress' }), 'done');
  assert.equal(nextState({ state: 'done', startedAt: 10 }), 'in_progress');
  assert.equal(nextState({ state: 'done', startedAt: null }), 'not_started');
  assert.throws(() => nextState({ state: 'lost' }), /unknown state lost/);
});

test('Alt and an arrow move one place, and over the edge of a day to the next', () => {
  const read = list([task(1, 'today'), task(2, 'today'), task(3, 'today'), task(4, 'tomorrow')]);
  assert.deepEqual(keyboardMove(read, 3, -1), { day: 'today', after: 1 });
  assert.deepEqual(keyboardMove(read, 2, -1), { day: 'today', after: null });
  assert.equal(keyboardMove(read, 1, -1), null);
  assert.deepEqual(keyboardMove(read, 3, 1), { day: 'tomorrow', after: null });
  assert.deepEqual(keyboardMove(read, 4, -1), { day: 'today', after: 3 });
  assert.deepEqual(keyboardMove(read, 4, 1), { day: 'later', after: null });
});

test('a move shows at once in its new day and place, with the date of the day rule', () => {
  const read = list([task(1, 'today', { date: '2026-11-24', late: true }), task(2, 'today'), task(3, 'tomorrow', { date: '2026-11-26' })]);
  const moved = applyPatch(read, 1, { day: 'tomorrow', after: 3 }, 0);
  const groups = dayGroups(moved);
  assert.deepEqual([groups.today.map((t) => t.id), groups.tomorrow.map((t) => t.id)], [[2], [3, 1]]);
  assert.equal(moved.tasks.find((t) => t.id === 1).date, '2026-11-26');
  assert.equal(moved.tasks.find((t) => t.id === 1).late, false);
  const done = applyPatch(read, 2, { state: 'done' }, 99);
  assert.deepEqual([done.tasks.map((t) => t.id), done.done.map((t) => t.id), done.doneCount], [[1, 3], [2], 1]);
});

test('a carried task says the day it is from, and a task in Later its own day', () => {
  const read = list([]);
  assert.deepEqual(metaWords(task(1, 'today', { goalTitle: 'Ship it', date: '2026-11-24', late: true }), read, 2026), { goal: 'Ship it', fact: 'from 24 Nov' });
  assert.deepEqual(metaWords(task(2, 'later', { date: '2026-12-04' }), read, 2026), { goal: '', fact: 'Fri 4 Dec' });
});
