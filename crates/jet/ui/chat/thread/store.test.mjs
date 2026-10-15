import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThread } from './store.js';

const at = (day, hour, minute, second = 0) => new Date(2026, 9, day, hour, minute, second).getTime();
const entry = (id, role, when, text = role + ' ' + id) => ({ id, role, text, html: '<p>' + text + '</p>', status: 'complete', at: when });
const NOW = at(14, 10, 0);

test('messages of one role under three minutes apart group, and day changes and notices become pills', () => {
  const thread = createThread({ now: () => NOW });
  thread.load([
    entry(1, 'user', at(12, 23, 58)),
    entry(2, 'jet', at(12, 23, 59)),
    entry(3, 'user', at(13, 9, 0)),
    entry(4, 'user', at(13, 9, 1)),
    entry(5, 'jet', at(13, 9, 2)),
    entry(6, 'jet', at(13, 9, 6)),
    entry(7, 'jet', at(13, 9, 7)),
    entry(8, 'user', at(14, 9, 0)),
  ]);
  thread.addNotice('Started a fresh conversation', at(14, 9, 1));
  thread.addUser('and then', at(14, 9, 2));

  const shape = thread.rows().map((row) => {
    if (row.type === 'day') return 'day:' + row.label;
    if (row.type === 'notice') return 'notice';
    return row.type + (row.first ? '[' : '') + (row.last ? ']' : '');
  });
  assert.deepEqual(shape, [
    'day:Mon 12 Oct',
    'user[]', 'jet[]',
    'day:Yesterday',
    'user[', 'user]', 'jet[]', 'jet[', 'jet]',
    'day:Today',
    'user[]',
    'notice',
    'user[]',
  ]);
  const jets = thread.rows().filter((row) => row.type === 'jet');
  assert.deepEqual(jets.map((row) => row.live), [false, false, false, true], 'only the newest Jet row holds the lane');
});

test('a reply slot moves from waiting to streaming and ends as finished, failed or stopped', () => {
  const thread = createThread({ now: () => NOW });
  thread.addUser('hello', at(14, 9, 0));
  assert.equal(thread.replying, false);

  thread.openSlot(at(14, 9, 0));
  assert.equal(thread.replying, true);
  assert.equal(thread.slot.status, 'waiting');
  assert.equal(thread.rows().at(-1).entry.status, 'waiting');

  thread.addNotice('Started a fresh conversation', at(14, 9, 0));
  assert.deepEqual(thread.rows().slice(-2).map((row) => row.type), ['notice', 'jet'], 'a notice during a reply sits above the reply');

  thread.setMood('happy');
  thread.appendText('Hi ');
  thread.appendText('there');
  assert.equal(thread.slot.status, 'streaming');
  assert.equal(thread.slot.text, 'Hi there');
  assert.equal(thread.slot.mood, 'happy');
  thread.reveal('<p>Hi there</p>');
  assert.equal(thread.rows().at(-1).entry.html, '<p>Hi there</p>');

  thread.finish(entry(2, 'jet', at(14, 9, 1), 'Hi there'));
  assert.equal(thread.replying, false);
  assert.equal(thread.slot, null);
  assert.equal(thread.rows().at(-1).entry.status, 'complete');
  assert.equal(thread.rows().filter((row) => row.type === 'jet').length, 1, 'the slot became the finished row');

  const failure = { kind: 'claudeMissing', message: 'Claude Code was not found; looked in /usr/bin' };
  thread.openSlot(at(14, 9, 2));
  thread.fail(failure, { id: 3, role: 'jet', text: '', html: '', status: 'failed', error: failure.message, at: at(14, 9, 2) });
  const failed = thread.rows().at(-1);
  assert.equal(failed.entry.status, 'failed');
  assert.deepEqual(failed.failure, failure);
  assert.equal(thread.replying, false);

  thread.openSlot(at(14, 9, 3));
  thread.appendText('Partial');
  thread.stop({ id: 4, role: 'jet', text: 'Partial', html: '<p>Partial</p>', status: 'stopped', at: at(14, 9, 3) });
  assert.equal(thread.rows().at(-1).entry.status, 'stopped');
  assert.equal(thread.rows().at(-1).entry.text, 'Partial');
});

test('a held message waits for the reply to end, a second Enter appends, and cancel returns the text', () => {
  const thread = createThread({ now: () => NOW });
  thread.addUser('first', at(14, 9, 0));
  thread.openSlot(at(14, 9, 0));

  thread.hold('and also this');
  thread.hold('one more thing');
  assert.equal(thread.held, 'and also this\n\none more thing');
  assert.equal(thread.takeHeld(), null, 'nothing is released while the reply runs');

  thread.finish(entry(2, 'jet', at(14, 9, 1)));
  assert.equal(thread.takeHeld(), 'and also this\n\none more thing');
  assert.equal(thread.held, null);
  assert.equal(thread.takeHeld(), null, 'it is released once');

  thread.openSlot(at(14, 9, 2));
  thread.hold('changed my mind');
  assert.equal(thread.cancelHold(), 'changed my mind');
  assert.equal(thread.held, null);
  assert.equal(thread.cancelHold(), '');
});

test("a reply's tool calls show as they start and finish, and one still running when the reply ends is kept as unfinished", () => {
  const thread = createThread({ now: () => NOW });
  const search = { id: 't1', server: 'quanty', tool: 'search', input: { question: 'what is vega?' } };
  const outcome = { ok: true, result: { results: [] }, summary: 'quanty · search · 0 results', durationMs: 800 };
  const toolsShown = () => thread.rows().at(-1).entry.tools;
  thread.addUser('what is vega?', at(14, 9, 0));
  thread.openSlot(at(14, 9, 0));
  assert.equal(toolsShown(), undefined, 'a reply with no calls has no list');

  thread.startTool(search);
  const running = toolsShown();
  assert.deepEqual(running, [search], 'a started call shows as running, with no outcome yet');
  thread.finishTool({ ...search, ...outcome });
  assert.deepEqual(toolsShown(), [{ ...search, ...outcome }], 'the finished call takes the place of the running one and keeps its input');
  assert.deepEqual(running, [search], 'the list a view already holds is not changed under it');

  thread.finishTool({ id: 't0', server: 'quanty', tool: 'health', ok: false, result: 'down', summary: 'quanty · health · failed', durationMs: 5 });
  assert.deepEqual(toolsShown().at(-1), { id: 't0', server: 'quanty', tool: 'health', input: null, ok: false, result: 'down', summary: 'quanty · health · failed', durationMs: 5 }, 'a call seen only when it finished is added');

  const second = { id: 't2', server: 'quanty', tool: 'answer', input: { question: 'and gamma?' } };
  thread.startTool(second);
  thread.appendText('Partial');
  thread.stop({ id: 9, role: 'jet', text: 'Partial', html: '<p>Partial</p>', status: 'stopped', at: at(14, 9, 1) });
  const stopped = thread.rows().at(-1).entry.tools;
  assert.deepEqual(stopped.map((call) => call.id), ['t1', 't0', 't2']);
  assert.equal(stopped[0].unfinished, undefined, 'a finished call stays as it was');
  assert.deepEqual(stopped[2], { ...second, unfinished: true }, 'the call still running when the reply stopped is kept and marked');

  thread.openSlot(at(14, 9, 2));
  thread.startTool(search);
  thread.finishTool({ ...search, ...outcome });
  thread.startTool(second);
  const saved = { ...search, ...outcome, summary: 'saved by the app' };
  thread.finish({ id: 10, role: 'jet', text: 'Done', html: '<p>Done</p>', status: 'complete', tools: [saved], at: at(14, 9, 3) });
  assert.deepEqual(thread.rows().at(-1).entry.tools, [saved, { ...second, unfinished: true }], 'the saved calls win, and a call the page saw that was not saved is kept');

  thread.openSlot(at(14, 9, 4));
  thread.startTool(search);
  thread.fail({ kind: 'io', message: 'broke' }, { id: null, role: 'jet', text: '', html: '', status: 'failed', at: at(14, 9, 4) });
  assert.deepEqual(thread.rows().at(-1).entry.tools, [{ ...search, unfinished: true }], 'a failure entry built without calls still shows the call');
  assert.throws(() => thread.startTool(search), /no reply is running/);
});
