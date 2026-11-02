import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDictation } from './dictation.js';

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

/** A field that only holds text, and a view that writes to it, keeps every write, and counts how often the page was told. */
function room({ reducedMotion = false } = {}) {
  const field = { value: '' };
  const writes = [];
  const told = [];
  const composerView = {
    dictate: (text) => { writes.push(text); field.value = text; },
    dictated: () => told.push(field.value),
  };
  const clock = fakeClock();
  const dictation = createDictation({ field, composerView, clock, reducedMotion: () => reducedMotion });
  return { field, writes, told, clock, dictation };
}

test('heard words land one every 35 ms, tidy and capitalised, and the page is told once the burst has landed', () => {
  const { field, told, clock, dictation } = room();
  dictation.append('  hello   jet,\n what time ');
  assert.equal(field.value, 'Hello', 'the first word lands at once, with a capital');
  clock.advance(34);
  assert.equal(field.value, 'Hello');
  clock.advance(1);
  assert.equal(field.value, 'Hello jet,');
  clock.advance(35);
  assert.equal(field.value, 'Hello jet, what');
  assert.deepEqual(told, [], 'the page is not told word by word');
  clock.advance(35);
  assert.equal(field.value, 'Hello jet, what time');
  assert.deepEqual(told, ['Hello jet, what time']);
  assert.equal(dictation.landing, false);

  // A second burst joins with one space; typed text is kept as it is and only the join is tidied.
  dictation.append('is it');
  clock.advance(35);
  assert.equal(field.value, 'Hello jet, what time is it');
  field.value = 'typed ';
  dictation.append('more');
  assert.equal(field.value, 'typed more', 'no second space after a space, and no capital in the middle of a message');
  field.value = 'typed\n';
  dictation.append('more');
  assert.equal(field.value, 'typed\nmore');
  field.value = ' ';
  dictation.append('fresh start');
  assert.equal(field.value, ' Fresh', 'a field that holds only space still starts a message');
  clock.advance(35);
  assert.equal(field.value, ' Fresh start');

  // Words that arrive while others are landing wait their turn, and flush lands them all at once.
  field.value = '';
  dictation.append('one two');
  dictation.append('three four');
  assert.equal(dictation.landing, true);
  dictation.flush();
  assert.equal(field.value, 'One two three four');
  assert.equal(dictation.landing, false);
  clock.advance(1000);
  assert.equal(field.value, 'One two three four', 'nothing lands after a flush');
});

test('a keystroke during a spoken turn turns auto-send off until the field is emptied', () => {
  const { field, clock, dictation } = room();
  assert.equal(dictation.autoSend, true);
  dictation.append('hello there jet');
  dictation.takeOver();
  assert.equal(dictation.autoSend, false);
  clock.advance(100);
  assert.equal(field.value, 'Hello there jet', 'the words keep landing after a take-over');
  dictation.append('and again');
  assert.equal(dictation.autoSend, false, 'more speech does not turn auto-send back on');
  dictation.reset();
  assert.equal(dictation.autoSend, true);

  // Emptying the field also drops words that were still on their way to the message just sent.
  field.value = '';
  dictation.append('one two three');
  dictation.reset();
  clock.advance(1000);
  assert.equal(field.value, 'One');
});

test('under reduced motion a burst of words lands whole', () => {
  const { field, told, dictation } = room({ reducedMotion: true });
  dictation.append('hello there jet');
  assert.equal(field.value, 'Hello there jet');
  assert.deepEqual(told, ['Hello there jet']);
  assert.equal(dictation.landing, false);
});

test('live words show after the heard words until those land in their place, and leave with the turn, a take-over or a send by hand', () => {
  const { field, writes, told, clock, dictation } = room();

  // Live words show at once, with a capital when they start the message, and follow the recognizer.
  dictation.showLive('hello');
  assert.equal(field.value, 'Hello');
  dictation.showLive('hello there how');
  assert.equal(field.value, 'Hello there how');

  // Heard words take the place of the live words they cover in one update, with no typewriter.
  writes.length = 0;
  dictation.append('Hello there,');
  assert.deepEqual(writes, ['Hello there, how']);
  assert.deepEqual(told, ['Hello there, how']);
  dictation.showLive('hello there how are');
  assert.equal(field.value, 'Hello there, how are', 'only the words past the two heard ones show as live words');

  // The turn ends: the live words go, and the next turn counts heard words from zero.
  dictation.clearLive();
  assert.equal(field.value, 'Hello there,');
  dictation.append('one two three');
  assert.equal(field.value, 'Hello there, one', 'with no live words showing the typewriter runs as before');
  dictation.showLive('one two three four');
  assert.equal(field.value, 'Hello there, one two three four', 'the words still waiting land before the live words');
  clock.advance(1000);
  assert.equal(field.value, 'Hello there, one two three four', 'nothing lands twice');

  // A take-over takes the live words away, and none show until the field is empty.
  field.value += 'x';
  dictation.takeOver();
  assert.equal(field.value, 'Hello there, one two threex');
  dictation.showLive('one two three four five');
  assert.equal(field.value, 'Hello there, one two threex');
  field.value = '';
  dictation.reset();
  dictation.clearLive();
  dictation.showLive('again');
  assert.equal(field.value, 'Again');

  // A message sent by hand holds the live words, and the rest of that turn is dropped.
  field.value = '';
  dictation.reset();
  assert.equal(dictation.autoSend, false);
  dictation.showLive('again and more');
  dictation.append('Again and more.');
  assert.equal(field.value, '');
  dictation.clearLive();
  assert.equal(dictation.autoSend, true);
  dictation.showLive('next');
  assert.equal(field.value, 'Next');
});
