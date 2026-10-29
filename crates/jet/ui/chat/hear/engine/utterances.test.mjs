import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUtterances } from './utterances.js';
import { WORDS_LATE_MS } from './endpointer.js';

/** A clock whose timers fire only when the test says so. */
function fakeClock() {
  let now = 0;
  let timers = [];
  return {
    after(fn, ms) {
      const timer = { fn, at: now + ms };
      timers.push(timer);
      return () => { timers = timers.filter((other) => other !== timer); };
    },
    advance(ms) {
      const target = now + ms;
      for (let due = next(target); due; due = next(target)) {
        timers = timers.filter((timer) => timer !== due);
        now = due.at;
        due.fn();
      }
      now = target;
    },
    pending: () => timers.length,
  };
  function next(limit) { return timers.filter((timer) => timer.at <= limit).sort((a, b) => a.at - b.at)[0]; }
}

/** A transcriber whose answers the test gives by hand, one request at a time. */
function rig() {
  const requests = [];
  const delivered = [];
  const fatal = [];
  const clock = fakeClock();
  const utterances = createUtterances({
    transcribe: (pcm, { vocabulary, signal }) => new Promise((resolve, reject) => requests.push({ pcm, vocabulary, signal, resolve, reject })),
    vocabulary: () => ['Jet'],
    clock,
    onWords: (words) => delivered.push(words),
    onFatal: (error) => fatal.push(error),
  });
  const clip = (mark) => new Int16Array([mark]);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { requests, delivered, fatal, clock, utterances, clip, settle };
}

test('words come out in order however Google answers, two requests at a time, with one retry and a deadline', async () => {
  const room = rig();
  for (const index of [0, 1, 2]) room.utterances.enqueue(room.clip(index), { turnId: 'a', index });
  assert.equal(room.requests.length, 2, 'at most two in flight');
  assert.deepEqual(room.requests[0].vocabulary, ['Jet']);

  room.requests[1].resolve({ text: 'second' });
  await room.settle();
  assert.deepEqual(room.delivered, [], 'the second answer waits for the first');
  room.requests[0].resolve({ text: 'first' });
  await room.settle();
  assert.deepEqual(room.delivered.map((words) => words.text), ['first', 'second']);
  assert.equal(room.requests.length, 3, 'the third started when a place freed');

  room.requests[2].reject({ kind: 'http', message: 'busy' });
  await room.settle();
  room.clock.advance(400);
  assert.equal(room.requests.length, 4, 'one retry after 400 ms');
  room.requests[3].reject({ kind: 'http', message: 'busy again' });
  await room.settle();
  assert.deepEqual(room.delivered.at(-1), { turnId: 'a', index: 2, text: '', error: { kind: 'http', message: 'busy again' } }, 'after the retry it has failed');

  room.utterances.enqueue(room.clip(3), { turnId: 'b', index: 0 });
  room.clock.advance(WORDS_LATE_MS - 1);
  assert.equal(room.requests[4].signal.aborted, false);
  room.clock.advance(1);
  await room.settle();
  assert.equal(room.requests[4].signal.aborted, true, 'a request still out at the deadline is given up');
  assert.equal(room.delivered.at(-1).error.kind, 'late');
  room.requests[4].resolve({ text: 'too late' });
  await room.settle();
  assert.equal(room.delivered.length, 4, 'an answer after the deadline is ignored');
});

test('a refused key stops everything and is reported once, and stop aborts what is in flight', async () => {
  const fatalRoom = rig();
  fatalRoom.utterances.enqueue(fatalRoom.clip(0), { turnId: 'a', index: 0 });
  fatalRoom.utterances.enqueue(fatalRoom.clip(1), { turnId: 'a', index: 1 });
  fatalRoom.requests[0].reject({ kind: 'rejected', message: 'The key was refused.' });
  await fatalRoom.settle();
  assert.deepEqual(fatalRoom.fatal, [{ kind: 'rejected', message: 'The key was refused.' }]);
  assert.equal(fatalRoom.requests[1].signal.aborted, true);
  assert.equal(fatalRoom.requests.length, 2, 'no retry');
  assert.deepEqual(fatalRoom.delivered, []);

  const stopping = rig();
  for (const index of [0, 1, 2]) stopping.utterances.enqueue(stopping.clip(index), { turnId: 'a', index });
  stopping.utterances.stop();
  assert.ok(stopping.requests.every((request) => request.signal.aborted));
  assert.equal(stopping.clock.pending(), 0, 'no deadline is left running');
  stopping.requests[0].resolve({ text: 'late' });
  stopping.requests[1].reject({ kind: 'network', message: 'The request was aborted.' });
  await stopping.settle();
  assert.deepEqual(stopping.delivered, []);
  assert.equal(stopping.clock.pending(), 0, 'an aborted request is not tried again');
  assert.equal(stopping.requests.length, 2, 'the queued clip never started');
});
