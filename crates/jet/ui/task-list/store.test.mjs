// The task list's copy of the server: a change shows at once and is taken back when refused, and a read never
// draws over a task the person is editing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskStore } from './store.js';

const task = (id, title = `Task ${id}`) => ({ id, title, goalId: null, goalTitle: null, chatId: 1, date: '2026-11-25', day: 'today', late: false, state: 'not_started', startedAt: null, doneAt: null });
const answer = (tasks) => ({ timeZone: null, today: '2026-11-25', tomorrow: '2026-11-26', mainChatId: 1, doneCount: 0, goals: [], tasks, done: [] });

/** A server whose next answer the test gives by hand. */
function server() {
  const calls = [];
  const request = (path, body, method = 'GET') => new Promise((resolve, reject) => calls.push({ path, body, method, resolve, reject }));
  return { calls, request };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a refused change shows at once, is taken back, says why, and reads the list again', async () => {
  const fake = server();
  const store = createTaskStore({ request: fake.request, now: () => 100 });
  const first = store.refresh();
  fake.calls[0].resolve(answer([task(1, 'Call the bank')]));
  await first;

  const renamed = store.change(1, { title: 'Call the bank about rates' }, 'The task could not be renamed');
  assert.equal(store.state.list.tasks[0].title, 'Call the bank about rates', 'shown before the server answers');
  await tick();
  assert.equal(fake.calls[1].method, 'PATCH');
  fake.calls[1].reject({ kind: 'taskGone', message: 'That task is no longer in your list' });
  assert.deepEqual((await renamed).error, { kind: 'taskGone', message: 'That task is no longer in your list' });
  assert.equal(store.state.list.tasks[0].title, 'Call the bank', 'taken back');
  assert.equal(store.state.alert, 'The task could not be renamed. That task is no longer in your list. Try again.');
  assert.equal(fake.calls[2].path, '/api/task-list', 'and the list is read again');
});

test('two changes go out in the order made, the second only once the first is answered', async () => {
  const fake = server();
  const store = createTaskStore({ request: fake.request });
  const first = store.refresh();
  fake.calls[0].resolve(answer([task(1), task(2), task(3)]));
  await first;
  store.change(3, { after: 1 }, 'The task could not be moved');
  store.change(3, { after: null }, 'The task could not be moved');
  assert.deepEqual(store.state.list.tasks.map((t) => t.id), [3, 1, 2]);
  await tick();
  assert.equal(fake.calls.length, 2, 'the second waits');
  fake.calls[1].resolve(answer([task(1), task(3), task(2)]));
  await tick(); await tick();
  assert.deepEqual(fake.calls[2].body, { after: null });
  assert.deepEqual(store.state.list.tasks.map((t) => t.id), [3, 1, 2], 'the answer of the first is drawn under the second, still waiting');
});

test('a read keeps a task being edited as it is, and draws once the edit ends', async () => {
  const fake = server();
  const store = createTaskStore({ request: fake.request });
  const first = store.refresh();
  fake.calls[0].resolve(answer([task(1, 'Draft the spec'), task(2, 'Call the bank')]));
  await first;
  store.keep('task', 2);
  const again = store.refresh();
  fake.calls[1].resolve(answer([task(2, 'Call the bank')]));
  await again;
  assert.deepEqual(store.state.list.tasks.map((t) => t.id), [1, 2], 'nothing drawn over the open row');
  store.release();
  assert.deepEqual(store.state.list.tasks.map((t) => t.id), [2]);

  store.keep('task', 2);
  const gone = store.refresh();
  fake.calls[2].resolve(answer([]));
  await gone;
  assert.equal(store.state.gone, 'Call the bank', 'a read without the open task ends the edit and names it');
  assert.deepEqual(store.state.list.tasks, []);
});

test('an add carries its goal, and Move all to Today sends one change per task, in order, with no place', async () => {
  const fake = server();
  const store = createTaskStore({ request: fake.request });
  const first = store.refresh();
  fake.calls[0].resolve(answer([{ ...task(1), late: true, date: '2026-11-23' }, { ...task(2), late: true, date: '2026-11-24' }]));
  await first;
  const added = store.add('Order the fabric', 'tomorrow', 7);
  await tick();
  assert.deepEqual(fake.calls[1].body, { title: 'Order the fabric', day: 'tomorrow', goalId: 7 });
  fake.calls[1].reject({ kind: 'offline', message: 'Jet could not be reached' });
  assert.equal((await added).notice, 'The task could not be added. Jet could not be reached. Try again.');
  assert.equal(store.state.alert, '', 'a failed add is shown beside its field, not in the alert');
  store.moveAllToToday([2, 1]);
  assert.deepEqual(store.state.list.tasks.map((t) => [t.id, t.late]), [[1, false], [2, false]], 'both leave Overdue at once, in their places');
  for (const id of [2, 1]) {
    await tick(); await tick();
    const call = fake.calls.at(-1);
    assert.deepEqual([call.method, call.path, call.body], ['PATCH', `/api/task-list/tasks/${id}`, { day: 'today' }]);
    call.resolve(answer([]));
  }
});
