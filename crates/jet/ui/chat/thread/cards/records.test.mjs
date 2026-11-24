import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardOf } from './model.js';
import { foldRecords } from './records.js';

const objective = {
  id: 1, title: 'Ship the kite page', deliverable: 'A kite page', start: '2026-11-17', due: '2026-12-03', status: 'active', closedAt: null,
  steps: [{ id: 1, title: 'Build the frame', due: '2026-11-26', doneAt: 1 }, { id: 2, title: 'Fly it in the park', due: '2026-12-01', doneAt: null }],
  notes: [{ status: 'on track', moved: 'Frame is built', blockers: '', isPrivate: false }],
};
const task = { id: 4, kind: 'check', localTime: '2026-11-25T09:00', why: 'see whether the frame is built', dueAt: 1764061200 };
const call = (tool, command, result, extra = {}) => ({ id: 'c' + Math.random(), server: 'jet', tool, input: { command }, ok: true, result, durationMs: 40, ...extra });
const line = (tool, command, result) => cardOf(call(tool, command, result)).name;

test('each command of the objectives tool reads as plain words', () => {
  assert.equal(line('objectives_update', { action: 'create', title: 'Ship the kite page' }, { objective }), 'Recorded Ship the kite page');
  assert.equal(line('objectives_update', { action: 'edit', id: 1, deliverable: 'x' }, { objective }), 'Changed Ship the kite page');
  assert.equal(line('objectives_update', { action: 'edit', id: 1, status: 'paused' }, { objective: { ...objective, status: 'paused' } }), 'Paused Ship the kite page');
  assert.equal(line('objectives_update', { action: 'edit', id: 1, status: 'active' }, { objective }), 'Resumed Ship the kite page');
  assert.equal(line('objectives_update', { action: 'step_add', id: 1, title: 'Fly it in the park' }, { objective }), 'Added the step Fly it in the park');
  assert.equal(line('objectives_update', { action: 'step_tick', id: 1, step: 1 }, { objective }), 'Ticked Build the frame');
  assert.equal(line('objectives_update', { action: 'step_tick', id: 1, step: 2, done: false }, { objective }), 'Unticked Fly it in the park');
  assert.equal(line('objectives_update', { action: 'step_edit', id: 1, step: 2, due: '2026-12-01' }, { objective }), 'Moved Fly it in the park to Tue 1 Dec');
  assert.equal(line('objectives_update', { action: 'step_edit', id: 1, step: 2, title: 'Fly it in the park' }, { objective }), 'Renamed a step to Fly it in the park');
  assert.equal(line('objectives_update', { action: 'dates', id: 1, due: '2026-12-03', reason: 'wind' }, { objective }), 'Moved Ship the kite page to Tue 17 Nov – Thu 3 Dec');
  assert.equal(line('objectives_update', { action: 'note', id: 1, status: 'on track', moved: 'x' }, { objective }), 'Noted: on track');
  assert.equal(line('objectives_update', { action: 'close', id: 1, outcome: 'done' }, { objective: { ...objective, status: 'done' } }), 'Closed Ship the kite page as done');
  assert.equal(line('objectives_update', { action: 'close', id: 1, outcome: 'dropped' }, { objective: { ...objective, status: 'dropped' } }), 'Dropped Ship the kite page');
  assert.equal(line('objectives_list', undefined, { objectives: [objective, objective] }), 'Read your objectives');
  assert.equal(cardOf({ ...call('objectives_list', undefined, { objectives: [] }), input: { owner: 2 } }).name, "Read a colleague's shared objectives");
});

test('each command of the tasks tool reads as plain words, with the time as the user wrote it', () => {
  assert.equal(line('tasks_update', { action: 'schedule', objectiveId: 1, at: '2026-11-25T09:00', why: 'x' }, { task, moved: false }), 'Set a check for Wed 25 Nov, 09:00');
  assert.equal(line('tasks_update', { action: 'schedule', objectiveId: 1, at: '2026-11-25T09:00', why: 'x' }, { task, moved: true }), 'Moved the check to Wed 25 Nov, 09:00');
  assert.equal(line('tasks_update', { action: 'schedule', at: '2026-11-25T09:00', why: 'x' }, { task: { ...task, kind: 'follow_up' }, moved: false }), 'Set a follow-up for Wed 25 Nov, 09:00');
  assert.equal(line('tasks_update', { action: 'cancel', id: 4 }, { task }), 'Cancelled the check: see whether the frame is built');
  assert.equal(line('tasks_update', { action: 'checked', found: 'Frame built' }, { recorded: 'Frame built', next: '2026-11-27T09:00' }), 'Noted the check, next on Fri 27 Nov, 09:00');
  assert.equal(line('tasks_update', { action: 'checked', found: 'Frame built' }, { recorded: 'Frame built', next: null }), 'Noted the check');
  assert.equal(line('tasks_list', undefined, { tasks: [task], runs: [] }), "Read Jet's checks");
  assert.equal(line('people_list', undefined, { users: [], teams: [] }), 'Read the people list');
});

test('a card of Jet\'s records has no machine name, no duration under a second, and fields with no Unix time or JSON', () => {
  const card = cardOf(call('objectives_update', { action: 'create', title: 'Ship the kite page' }, { objective }));
  assert.equal(card.meta, '');
  assert.equal(card.head, 'Recorded Ship the kite page');
  const text = card.body.fields.map((field) => field.term + ' ' + field.text).join('\n');
  assert.doesNotMatch(text, /[{}[\]"]|1764061200|objectives_update/);
  assert.match(text, /Build the frame/);
  assert.match(cardOf({ ...call('jet', 'x', {}), server: 'quanty', tool: 'search', durationMs: 2400 }).meta, /2\.4 s/);
  assert.doesNotMatch(cardOf({ ...call('jet', 'x', {}), server: 'quanty', tool: 'search', durationMs: 400 }).meta, / s$/);
});

test('a reply\'s calls to Jet\'s own records fold into one line, and cards that ask for a tap stay apart', () => {
  const calls = [
    call('objectives_list', undefined, { objectives: [] }),
    call('objectives_update', { action: 'create', title: 'A' }, { objective }),
    call('objectives_update', { action: 'create', title: 'B' }, { objective }),
    call('tasks_update', { action: 'send', to: 2, kind: 'note', text: 'hi' }, { send: { id: 1, to: { id: 2, name: 'Ann' }, kind: 'note', text: 'hi', state: 'proposed' } }),
    { ...call('tasks_update', { action: 'schedule' }, null), ok: undefined },
  ];
  const items = foldRecords(calls);
  assert.equal(items.length, 3);
  assert.equal(items[0].kind, 'records');
  assert.equal(items[0].calls.length, 3);
  assert.equal(items[0].line, 'Jet updated your plan · 2 changes');
  assert.equal(items[1].call, calls[3]);
  assert.equal(items[2].call, calls[4], 'a running call stays its own line');
  assert.equal(foldRecords([calls[0]])[0].kind, 'call', 'one call alone is not folded');
  assert.equal(foldRecords([calls[0], calls[0]])[0].line, 'Jet read your plan');
});

test('a refused send or reply is headed as a message to a colleague that could not go, not as a change to the plan', () => {
  const refused = (command) => cardOf({ id: 'f', server: 'jet', tool: 'tasks_update', input: { command }, ok: false, result: { kind: 'sendLimit', message: 'Too many today.' } });
  assert.equal(refused({ action: 'send', to: 2, kind: 'question', text: 'x' }).head, 'Your message to a colleague could not go');
  assert.equal(refused({ action: 'reply', item: 1, outcome: 'answered' }).head, 'Your reply to a colleague could not go');
  assert.equal(refused({ action: 'schedule', at: 'x', why: 'y' }).head, 'Jet could not update your plan');
  assert.equal(refused({ action: 'send' }).advice, 'Too many today.');
});
