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

/** The spoken message in the thread and the message field, as two sinks that hold text and keep what was done to them. */
function room({ reducedMotion = false } = {}) {
  const forming = {
    text: '', writes: [], dropped: false,
    write(text) { forming.text = text; forming.writes.push(text); forming.dropped = false; },
    drop() { forming.text = ''; forming.dropped = true; },
  };
  const field = { text: '', write(text) { field.text = text; } };
  const clock = fakeClock();
  const dictation = createDictation({ forming, field, clock, reducedMotion: () => reducedMotion });
  return { forming, field, clock, dictation };
}

test('heard words land in the spoken message one after another, tidy and capitalised', () => {
  const { forming, field, clock, dictation } = room();
  dictation.open();
  assert.deepEqual(forming.writes, [], 'nothing shows until the first words');
  dictation.append('  hello   jet,\n what time ');
  assert.equal(forming.text, 'Hello', 'the first word lands at once, with a capital');
  assert.equal(forming.text, 'Hello', 'the rest follow one at a time, not at once');
  clock.advance(1000);
  assert.equal(forming.text, 'Hello jet, what time');
  assert.equal(field.text, '', 'heard words never land in the field unless the person took over');

  // A second burst joins with one space; the join is tidied wherever the words go.
  dictation.append('is it');
  clock.advance(1000);
  assert.equal(forming.text, 'Hello jet, what time is it');
  forming.text = 'typed ';
  dictation.append('more');
  assert.equal(forming.text, 'typed more', 'no second space after a space, and no capital in the middle of a message');
  forming.text = 'typed\n';
  dictation.append('more');
  assert.equal(forming.text, 'typed\nmore');
  forming.text = ' ';
  dictation.append('fresh start');
  assert.equal(forming.text, ' Fresh', 'a message that holds only space still starts a message');
  clock.advance(1000);
  assert.equal(forming.text, ' Fresh start');

  // Words that arrive while others are landing wait their turn, and the end of the turn lands them all at once.
  forming.text = '';
  dictation.append('one two');
  dictation.append('three four');
  assert.equal(forming.text, 'One', 'the rest wait behind the first');
  dictation.end();
  assert.equal(forming.text, 'One two three four');
  clock.advance(1000);
  assert.equal(forming.text, 'One two three four', 'nothing lands after the end');
});

test('a keystroke or Esc during a spoken turn moves its words into the field, and that message no longer sends itself', () => {
  const { forming, field, clock, dictation } = room();
  dictation.open();
  assert.equal(dictation.autoSend, true);
  dictation.append('hello there');
  clock.advance(1000);
  dictation.showLive('hello there how');
  assert.equal(forming.text, 'Hello there how');

  // The key is already in the field when the page hears of it: the words go before it, and the live words stay behind.
  field.text = 'x';
  dictation.takeOver();
  assert.equal(field.text, 'Hello there x');
  assert.deepEqual([forming.text, forming.dropped], ['', true], 'the spoken message leaves the thread');
  assert.equal(dictation.autoSend, false);

  dictation.append('and again');
  clock.advance(1000);
  assert.equal(field.text, 'Hello there x and again', 'the words keep landing, now in the field');
  assert.equal(dictation.autoSend, false, 'more speech does not turn auto-send back on');

  // Emptying the field drops words still on their way to the message just sent, and the next words form a new message.
  dictation.append('five six');
  field.text = '';
  dictation.reset();
  clock.advance(1000);
  assert.equal(field.text, '');
  assert.equal(dictation.autoSend, true);
  dictation.append('next');
  assert.equal(forming.text, 'Next');
  assert.equal(field.text, '');

  // Esc with nothing typed moves the words alone.
  const esc = room();
  esc.dictation.open();
  esc.dictation.append('hello');
  esc.dictation.takeOver();
  assert.equal(esc.field.text, 'Hello');
});

test('under reduced motion a burst of words lands whole', () => {
  const { forming, dictation } = room({ reducedMotion: true });
  dictation.open();
  dictation.append('hello there jet');
  assert.equal(forming.text, 'Hello there jet');
});

test('live words show after the heard words until those land in their place, and leave with the turn, a take-over or a send by hand', () => {
  const { forming, field, clock, dictation } = room();

  // Live words show at once, with a capital when they start the message, and follow the recognizer.
  dictation.open();
  dictation.showLive('hello');
  assert.equal(forming.text, 'Hello');
  dictation.showLive('hello there how');
  assert.equal(forming.text, 'Hello there how');

  // Heard words take the place of the live words they cover in one update, with no typewriter.
  forming.writes.length = 0;
  dictation.append('Hello there,');
  assert.deepEqual(forming.writes, ['Hello there, how']);
  dictation.showLive('hello there how are');
  assert.equal(forming.text, 'Hello there, how are', 'only the words past the two heard ones show as live words');

  // The turn ends: the live words go, and the next turn counts heard words from zero.
  dictation.end();
  assert.equal(forming.text, 'Hello there,');
  forming.text = ''; // The message was sent, so it no longer forms.
  const before = forming.writes.length;
  dictation.open();
  assert.equal(forming.writes.length, before, 'the next turn shows nothing until its first words');
  dictation.append('one two three');
  assert.equal(forming.text, 'One', 'with no live words showing the typewriter runs as before');
  dictation.showLive('one two three four');
  assert.equal(forming.text, 'One two three four', 'the words still waiting land before the live words');
  clock.advance(1000);
  assert.equal(forming.text, 'One two three four', 'nothing lands twice');

  // A take-over takes the live words away, and none show until the field is empty.
  field.text = 'x';
  dictation.takeOver();
  assert.equal(field.text, 'One two three x');
  dictation.showLive('one two three four five');
  assert.equal(forming.text, '');
  field.text = '';
  dictation.reset();
  dictation.end();
  dictation.open();
  dictation.showLive('again');
  assert.equal(forming.text, 'Again');

  // Live words that go before any heard word landed leave no message, and a message is never written empty.
  dictation.showLive('');
  assert.equal(forming.dropped, true);
  dictation.showLive('again');
  dictation.end();
  assert.deepEqual([forming.text, forming.dropped], ['', true]);
  assert.equal(forming.writes.includes(''), false);

  // A turn thrown away takes its message and the words still waiting for it.
  dictation.open();
  dictation.append('one two three');
  dictation.discard();
  clock.advance(1000);
  assert.deepEqual([forming.text, forming.dropped], ['', true]);

  // A message sent by hand holds what is shown, and the rest of that turn is dropped.
  dictation.open();
  dictation.showLive('again and more');
  dictation.spend();
  assert.equal(dictation.autoSend, false);
  const written = forming.writes.length;
  dictation.append('Again and more.');
  dictation.showLive('again and more now');
  assert.equal(forming.writes.length, written, 'nothing more is written');
  dictation.end();
  assert.equal(dictation.autoSend, false);
  forming.text = ''; // The message was sent, so it no longer forms.
  dictation.open();
  assert.equal(dictation.autoSend, true);
  dictation.showLive('next');
  assert.equal(forming.text, 'Next');
});
