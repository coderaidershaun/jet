import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHearing } from './hearing.js';
import { SETTINGS } from './endpointer.js';

const HOP = SETTINGS.HOP_MS;

function fakeClock() {
  let timers = [];
  let now = 0;
  const next = (limit) => timers.filter((timer) => timer.at <= limit).sort((a, b) => a.at - b.at)[0];
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
  };
}

function memoryStorage() {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)), removeItem: (key) => items.delete(key) };
}

const blockedStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); },
};

/**
 * Hearing with a fake microphone, a fake detector that reads its probability from the first sample of
 * each hop (percent), and a transcriber answered by hand. Time moves only as frames are sent.
 */
function room({ storage = memoryStorage(), jetWords = '' } = {}) {
  const events = [];
  const requests = [];
  const clock = fakeClock();
  let atMs = 0;
  const capture = {
    onFrames: null,
    onEnded: null,
    started: 0,
    stopped: 0,
    failWith: null,
    async start() {
      atMs = 0; // a new capture counts its time from zero
      this.started++;
      if (this.failWith) throw this.failWith;
      return { sampleRate: 16000 };
    },
    stop() { this.stopped++; },
  };
  const hearing = createHearing({
    capture,
    vad: { probability: (hop) => hop[0] / 100, reset() {} },
    transcribe: (pcm, { signal }) => new Promise((resolve, reject) => requests.push({ pcm, signal, resolve, reject })),
    vocabulary: () => ['Jet'],
    recentJetWords: () => jetWords,
    onEvent: (event) => events.push(event),
    clock,
    storage,
  });
  const frames = (ms, percent) => {
    for (let spent = 0; spent < ms; spent += HOP * 2) {
      capture.onFrames(new Int16Array(512).fill(percent), [0.1, 0.1], atMs);
      atMs += HOP * 2;
    }
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    hearing,
    capture,
    events,
    requests,
    clock,
    frames,
    talk: (ms) => frames(ms, 90),
    hush: (ms) => frames(ms, 5),
    settle,
    of: (kind) => events.filter((event) => event.kind === kind),
    states: () => events.filter((event) => event.kind === 'state').map((event) => event.state),
    answer: async (at, text) => { requests[at].resolve({ text }); await settle(); },
    /** A sentence of 1.2 s and the breath after it, answered with `text`. */
    async say(text) {
      const before = requests.length;
      frames(1200, 90);
      frames(SETTINGS.PHRASE_GAP_MS + HOP, 5);
      await this.answer(before, text);
    },
  };
}

test('two spoken phrases and a pause become one turn with the words joined and capitalised', async () => {
  const world = room();
  await world.hearing.start();
  assert.deepEqual(world.states(), ['starting', 'listening']);

  world.talk(1200);
  world.hush(SETTINGS.PHRASE_GAP_MS + HOP);
  assert.deepEqual(world.of('utterance').map((event) => event.index), [0]);
  assert.equal(world.requests.length, 1);
  await world.answer(0, 'what  time is it');
  assert.deepEqual(world.of('words').map((event) => [event.index, event.text, event.interrupts]), [[0, 'what  time is it', false]]);
  assert.equal(world.of('turn').length, 0);

  world.talk(1200);
  world.hush(SETTINGS.PHRASE_GAP_MS + HOP);
  await world.answer(1, 'in Lisbon?');
  world.hush(SETTINGS.GAP_COMPLETE_MS);
  assert.deepEqual(world.of('turn').map((event) => event.text), ['What time is it in Lisbon?']);
  assert.equal(world.of('turn')[0].turnId, world.of('words')[0].turnId);
  assert.ok(world.of('level').length > 0);
});

test('Jet\'s own words are discarded as an echo, and the second one makes the microphone deaf while Jet speaks', async () => {
  const storage = memoryStorage();
  const jetWords = 'The time in Lisbon is ten past three.';
  const world = room({ storage, jetWords });
  await world.hearing.start();
  world.hearing.setJetSpeaking(true);

  await world.say('Lisbon time');
  assert.deepEqual(world.of('words').map((event) => [event.text, event.interrupts]), [['Lisbon time', true]], 'under three words is never judged an echo');
  world.hush(SETTINGS.GAP_COMPLETE_MS + 1000);
  assert.equal(world.of('turn').length, 1);

  await world.say('   ');
  assert.deepEqual(world.of('discarded').map((event) => event.reason), ['noWords'], 'nothing heard is not an echo');
  assert.equal(storage.getItem('jet.hear.strikes'), null, 'and costs no strike');

  await world.say('the time was five thirty');
  world.hush(SETTINGS.GAP_COMPLETE_MS + 1000);
  assert.equal(world.of('words').at(-1).text, 'the time was five thirty', 'two of five words shared with Jet is not an echo');
  await world.say('the time is five thirty');
  assert.deepEqual(world.of('discarded').map((event) => event.reason), ['noWords', 'echo'], 'three of five is');
  assert.deepEqual(world.of('words').map((event) => event.text), ['Lisbon time', '', 'the time was five thirty'], 'echo words are never shown');
  assert.equal(storage.getItem('jet.hear.strikes'), '1');
  assert.ok(!world.states().includes('halfDuplexPause'));

  await world.say('The time in Lisbon is ten past three');
  assert.equal(world.of('discarded').at(-1).reason, 'echo');
  assert.equal(world.states().at(-1), 'halfDuplexPause');
  const heard = world.events.length;
  world.talk(1200);
  assert.equal(world.events.length, heard, 'frames are ignored while Jet speaks');
  world.hearing.setJetSpeaking(false);
  assert.equal(world.states().at(-1), 'listening');

  const later = room({ storage });
  await later.hearing.start();
  later.hearing.setJetSpeaking(true);
  assert.equal(later.states().at(-1), 'halfDuplexPause', 'a bad speaker is learned once, not on every page load');
  later.hearing.stop();
  assert.equal(storage.getItem('jet.hear.strikes'), null, 'switching the mic off forgets the strikes');

  const blocked = room({ storage: blockedStorage, jetWords });
  await blocked.hearing.start();
  await blocked.say('the time in Lisbon is ten past three');
  assert.equal(blocked.of('discarded').at(-1).reason, 'echo', 'blocked storage does not break hearing');
});

test('after ten quiet minutes the microphone is released, and wake listens again', async () => {
  const world = room();
  await world.hearing.start();
  world.hearing.setJetSpeaking(true);
  world.hearing.setJetSpeaking(false);
  world.hush(100);
  const tenMinutes = 10 * 60 * 1000;
  world.clock.advance(tenMinutes - 1);
  assert.equal(world.states().at(-1), 'listening');
  world.clock.advance(1);
  assert.equal(world.states().at(-1), 'asleep');
  assert.equal(world.capture.stopped, 1, 'the microphone is let go');

  await Promise.all([world.hearing.wake(), world.hearing.wake()]);
  assert.equal(world.capture.started, 2, 'a second wake while the first is starting does not start the microphone again');
  assert.equal(world.capture.stopped, 1, 'nor stop the one that is starting');
  assert.equal(world.states().at(-1), 'listening');
  world.frames(300, 70);
  assert.equal(world.of('speech').length, 1, 'the ordinary start rule holds again, not a leftover from before the sleep');
  world.hush(SETTINGS.SHORT_GAP_MS + HOP);
  await world.answer(0, 'Hello there.');
  world.hush(SETTINGS.GAP_COMPLETE_MS);
  assert.equal(world.of('turn').length, 1);
  world.clock.advance(tenMinutes - 1000);
  assert.equal(world.states().at(-1), 'listening', 'a message starts the ten minutes over');
});

test('when the microphone or Google gives out, words already on their way are kept and nothing is sent on', async () => {
  const world = room();
  await world.hearing.start();
  world.talk(1200);
  assert.equal(world.requests.length, 0);
  world.capture.onEnded({ kind: 'trackEnded', message: 'The microphone was unplugged.' });
  assert.equal(world.requests.length, 1, 'the open utterance is sent');
  assert.deepEqual(world.events.at(-1), { kind: 'state', state: 'blocked', reason: 'The microphone was unplugged.' });
  await world.answer(0, 'Remind me to call');
  assert.deepEqual(world.of('words').map((event) => event.text), ['Remind me to call']);
  world.hush(5000);
  assert.equal(world.of('turn').length, 0, 'the words stay in the field');

  const muted = room();
  await muted.hearing.start();
  muted.capture.onEnded({ kind: 'muted', message: 'The browser muted the microphone.' });
  assert.equal(muted.states().at(-1), 'waitingForTouch');

  const denied = room();
  denied.capture.failWith = { kind: 'permissionDenied', message: 'The microphone is blocked.' };
  await denied.hearing.start();
  assert.deepEqual(denied.events, [{ kind: 'state', state: 'starting' }, { kind: 'state', state: 'blocked', reason: 'The microphone is blocked.' }]);

  const refused = room();
  await refused.hearing.start();
  refused.talk(1200);
  refused.hush(SETTINGS.PHRASE_GAP_MS + HOP);
  refused.requests[0].reject({ kind: 'rejected', message: 'Google refused the key.' });
  await refused.settle();
  assert.deepEqual(refused.events.at(-1), { kind: 'state', state: 'problem', reason: 'Google refused the key.' });
  assert.equal(refused.capture.stopped, 1);
});

test('stop leaves nothing in flight', async () => {
  const world = room();
  await world.hearing.start();
  world.talk(1200);
  world.hush(SETTINGS.PHRASE_GAP_MS + HOP);
  assert.equal(world.requests.length, 1);
  world.hearing.stop();
  assert.equal(world.requests[0].signal.aborted, true);
  assert.equal(world.capture.stopped, 1);
  assert.equal(world.states().at(-1), 'off');
  const seen = world.events.length;
  await world.answer(0, 'too late');
  world.clock.advance(SETTINGS.SLEEP_AFTER_MS);
  assert.equal(world.events.length, seen, 'no word, turn or sleep follows a stop');
});
