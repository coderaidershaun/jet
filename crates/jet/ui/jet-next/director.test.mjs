import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirector, MOODS } from './director.js';
import { EMOTIONS } from './emotions.js';
import { createPlayer } from './player.js';

const FRAME_MS = 16;
const FLY_DONE_MS = 1700;

function setup({ reducedMotion = false } = {}) {
  const player = createPlayer({ random: () => 1, layers: false, reducedMotion });
  const director = createDirector({ player });
  const seen = [];
  // Runs frames from `from` to `to` and records each new clip name that shows up.
  function run(from, to) {
    for (let now = from; now <= to; now += FRAME_MS) {
      const { clip } = director.tick(now);
      if (clip && seen.at(-1) !== clip) seen.push(clip);
    }
    return to;
  }
  // Runs frames from `from` until `name` plays, and gives the time it started.
  function runUntil(name, from) {
    let now = from;
    while (director.tick(now).clip !== name) {
      assert.ok(now < from + 20000, `${name} never played`);
      now += FRAME_MS;
    }
    seen.push(name);
    return now;
  }
  return { director, player, seen, run, runUntil };
}

test('a send flies then works until the reply arrives, with fly\'s own timing', () => {
  const { director, seen, run } = setup();
  assert.deepEqual(
    director.send({ cruiseMs: 2000 }, 0),
    { moveAt: 500, moveMs: 2000 },
    'the host moves the thread from the launch\'s end for the whole cruise',
  );
  assert.deepEqual(
    setup().director.send({ cruiseMs: 100 }, 0),
    { moveAt: 500, moveMs: 220 },
    'the cruise is never shorter than the ease down',
  );
  assert.equal(director.status, 'flying');
  run(0, 3500);
  assert.equal(director.status, 'working');
  run(3500, 40000);
  assert.deepEqual(seen, ['fly', 'working'], 'the spinner carries on through its continuation');
  director.replying(40000);
  run(40000, 42000);
  assert.deepEqual(seen, ['fly', 'working', 'workingEnd']);
  assert.equal(director.status, 'idle');
  assert.equal(director.tick(42000).busy, false);
});

test('a quick reply skips the spinner', () => {
  const { director, player, seen, run } = setup();
  director.send({ cruiseMs: 800 }, 0);
  run(0, 100);
  director.replying(100);
  director.done(150);
  run(150, 5000);
  assert.deepEqual(seen, ['fly', 'settle']);
  assert.equal(director.status, 'idle');
  assert.ok(player.standing);
});

test('a hello mood queues after the brake and every other mood word only closes the spinner', () => {
  for (const word of MOODS) assert.ok(Object.hasOwn(EMOTIONS, word), `${word} has an entry in EMOTIONS`);

  const flying = setup();
  flying.director.send({ cruiseMs: 800 }, 0);
  flying.run(0, 100);
  flying.director.mood('  HELLO ', 100);
  flying.run(100, FLY_DONE_MS - FRAME_MS);
  assert.deepEqual(flying.seen, ['fly'], 'the flight is not cut');
  flying.runUntil('hello', FLY_DONE_MS);
  assert.deepEqual(flying.seen, ['fly', 'hello'], 'the spinner never starts');
  assert.equal(flying.player.clip.total, 2550, 'a mood hello is the full wave');

  const working = setup();
  working.director.send({ cruiseMs: 800 }, 0);
  working.run(0, 3000);
  working.director.mood('hello', 3000);
  working.run(3000, 3010);
  assert.equal(working.director.status, 'working', 'the spinner is closing, not skipped');
  working.run(3010, 9000);
  assert.deepEqual(working.seen, ['fly', 'working', 'workingEnd', 'hello']);

  for (const word of [...MOODS.filter((w) => w !== 'hello'), 'flabbergasted', '']) {
    const { director, seen, run } = setup();
    director.send({ cruiseMs: 800 }, 0);
    run(0, 3000);
    director.mood(word, 3000);
    run(3000, 6000);
    assert.deepEqual(seen, ['fly', 'working', 'workingEnd'], `${JSON.stringify(word)} plays nothing after the spinner`);

    const resting = setup();
    resting.director.mood(word, 0);
    assert.equal(resting.director.tick(16).clip, null, `${JSON.stringify(word)} plays nothing at rest`);
  }
});

test('done settles; a done during hello settles after it; a hello after done plays before the settle', () => {
  const resting = setup();
  resting.director.done(0);
  resting.run(0, 3000);
  assert.deepEqual(resting.seen, ['settle']);
  assert.ok(resting.player.standing);
  resting.director.done(3000);
  assert.equal(resting.director.tick(3016).busy, false, 'a Jet that already stands does not settle again');

  const greeting = setup();
  greeting.director.hello(0);
  greeting.run(0, 100);
  greeting.director.done(100);
  greeting.run(100, 6000);
  assert.deepEqual(greeting.seen, ['hello', 'settle']);

  const late = setup();
  late.director.send({ cruiseMs: 800 }, 0);
  late.run(0, 100);
  late.director.done(100);
  late.director.hello(116);
  late.run(116, 8000);
  assert.deepEqual(late.seen, ['fly', 'hello', 'settle']);

  const working = setup();
  working.director.send({ cruiseMs: 800 }, 0);
  working.run(0, 3000);
  working.director.done(3000);
  working.run(3000, 8000);
  assert.deepEqual(working.seen, ['fly', 'working', 'workingEnd', 'settle']);
});

test('failed and stopped drop the queue, close the spinner and settle', () => {
  for (const end of ['failed', 'stopped']) {
    const spinning = setup();
    spinning.director.send({ cruiseMs: 800 }, 0);
    spinning.run(0, 3000);
    spinning.director[end](3000);
    spinning.run(3000, 8000);
    assert.deepEqual(spinning.seen, ['fly', 'working', 'workingEnd', 'settle'], end);

    const queued = setup();
    queued.director.send({ cruiseMs: 800 }, 0);
    queued.run(0, 3000);
    queued.director.mood('hello', 3000);
    queued.director[end](3016);
    queued.run(3016, 9000);
    assert.deepEqual(queued.seen, ['fly', 'working', 'workingEnd', 'settle'], `${end} drops the waiting hello`);

    const flying = setup();
    flying.director.send({ cruiseMs: 800 }, 0);
    flying.run(0, 100);
    flying.director[end](100);
    flying.run(100, 8000);
    assert.deepEqual(flying.seen, ['fly', 'settle'], `${end} lets the flight land, and the spinner never starts`);
  }
});

test('reduced motion never flies', () => {
  const { director, player, seen, run } = setup({ reducedMotion: true });
  assert.deepEqual(director.send({ cruiseMs: 2000 }, 0), { moveAt: 0, moveMs: 0 });
  run(0, 3000);
  assert.equal(director.status, 'working');
  director.done(3000);
  run(3000, 8000);
  assert.deepEqual(seen, ['working', 'workingEnd'], 'Jet never left the ground, so it does not settle');
  assert.ok(player.standing);
});

test('revealAt counts to the clip\'s reveal phase, or is 300 with no clip', () => {
  const resting = setup();
  assert.deepEqual(resting.director.mood('hello', 0), { revealAt: 650 }, 'the wave shows its text from the first wag');

  const none = setup();
  assert.deepEqual(none.director.mood('curious', 0), { revealAt: 300 });
  assert.deepEqual(none.director.mood('flabbergasted', 0), { revealAt: 300 });

  const flying = setup();
  flying.director.send({ cruiseMs: 800 }, 0);
  flying.run(0, 100);
  assert.deepEqual(flying.director.mood('hello', 100), { revealAt: FLY_DONE_MS - 100 + 650 }, 'the rest of the flight, then up to the wag');

  const working = setup();
  working.director.send({ cruiseMs: 800 }, 0);
  working.run(0, 3000);
  const { revealAt } = working.director.mood('hello', 3000);
  assert.equal(working.director.status, 'working');
  assert.equal(revealAt, working.player.clip.total + 650, 'the spinner closes first, then the wave');
});

test('status reads idle, flying, working and reacting', () => {
  const { director, seen, run, runUntil } = setup();
  assert.equal(director.status, 'idle');
  director.send({ cruiseMs: 800 }, 0);
  assert.equal(director.status, 'flying');
  run(0, 3000);
  assert.equal(director.status, 'working');
  director.mood('hello', 3000);
  assert.equal(director.status, 'working', 'while the spinner closes');
  const helloAt = runUntil('hello', 3016);
  assert.equal(director.status, 'reacting');
  director.done(helloAt);
  run(helloAt + FRAME_MS, helloAt + 6000);
  assert.equal(seen.at(-1), 'settle');
  assert.equal(director.status, 'idle');
});
