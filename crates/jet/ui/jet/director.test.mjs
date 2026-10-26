import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirector, MOODS } from './director.js';
import { EMOTIONS } from './emotions.js';
import { createPlayer } from './player.js';

const FRAME_MS = 16;

function setup({ reducedMotion = false } = {}) {
  const player = createPlayer({ random: () => 1, layers: false, reducedMotion });
  const director = createDirector({ player });
  const seen = [];
  const rolls = [];
  // Runs frames from `from` to `to` and records each new clip name that shows up, and the roll of every frame.
  function run(from, to) {
    for (let now = from; now <= to; now += FRAME_MS) {
      const { clip } = director.tick(now);
      if (clip && seen.at(-1) !== clip) seen.push(clip);
      rolls.push(player.state.roll);
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
  return { director, player, seen, rolls, run, runUntil };
}

test('every way a reply ends (done, failed, stopped) returns Jet to rest, a mood Jet cannot show only closes the spinner, and reduced motion never flies or spins', () => {
  for (const end of ['failed', 'stopped']) {
    const spinning = setup();
    spinning.director.send({ cruiseMs: 800 }, 0);
    spinning.director.feel('neutral', 0);
    spinning.run(0, 3000);
    spinning.director[end](3000);
    spinning.run(3000, 8000);
    assert.deepEqual(spinning.seen, ['fly', 'working', 'workingEnd', 'settle'], end);

    const queued = setup();
    queued.director.send({ cruiseMs: 800 }, 0);
    queued.director.feel('neutral', 0);
    queued.run(0, 3000);
    queued.director.mood('hello', 3000);
    queued.director[end](3016);
    queued.run(3016, 9000);
    assert.deepEqual(queued.seen, ['fly', 'working', 'workingEnd', 'settle'], `${end} drops the waiting hello`);

    for (const reducedMotion of [false, true]) {
      const active = setup({ reducedMotion });
      active.director.send({ cruiseMs: 800 }, 0);
      active.director.feel('insulted', 100);
      const at = active.runUntil('insulted', 100);
      active.run(at, at + 1000);
      active.director[end](at + 1000);
      assert.notEqual(active.director.tick(at + 1000).clip, 'insulted', `${end} interrupts the active reaction`);
      active.run(at + 1000, at + 5000);
      assert.equal(active.director.status, 'idle');
      assert.ok(active.player.standing);
      if (reducedMotion) assert.equal(active.player.frame.y, 0);
    }

    const flying = setup();
    flying.director.send({ cruiseMs: 800 }, 0);
    flying.director.feel('neutral', 0);
    flying.run(0, 100);
    flying.director[end](100);
    flying.run(100, 8000);
    assert.deepEqual(flying.seen, ['fly', 'settle'], `${end} lets the flight land, and the spinner never starts`);
  }

  // A reply that finishes settles Jet, after a hello that is already playing or waiting.
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
  late.director.feel('neutral', 0);
  late.run(0, 100);
  late.director.done(100);
  late.director.hello(116);
  late.run(116, 8000);
  assert.deepEqual(late.seen, ['fly', 'hello', 'settle']);

  const working = setup();
  working.director.send({ cruiseMs: 800 }, 0);
  working.director.feel('neutral', 0);
  working.run(0, 3000);
  working.director.done(3000);
  working.run(3000, 8000);
  assert.deepEqual(working.seen, ['fly', 'working', 'workingEnd', 'settle']);

  for (const word of MOODS) assert.ok(Object.hasOwn(EMOTIONS, word), `${word} has an entry in EMOTIONS`);
  for (const word of ['neutral', 'happy', 'excited', 'thinking', 'curious', 'sorry', 'alert', 'annoyed', 'flabbergasted', '']) {
    const { director, seen, run } = setup();
    director.send({ cruiseMs: 800 }, 0);
    director.feel('neutral', 0);
    run(0, 3000);
    director.mood(word, 3000);
    run(3000, 6000);
    assert.deepEqual(seen, ['fly', 'working', 'workingEnd'], `${JSON.stringify(word)} plays nothing after the spinner`);

    const resting = setup();
    resting.director.mood(word, 0);
    assert.equal(resting.director.tick(16).clip, null, `${JSON.stringify(word)} plays nothing at rest`);
  }

  const { director, player, seen, rolls, run } = setup({ reducedMotion: true });
  assert.deepEqual(director.send({ cruiseMs: 2000 }, 0), { moveAt: 0, moveMs: 0 });
  director.feel('neutral', 0);
  run(0, 3000);
  assert.equal(director.status, 'working');
  assert.equal(player.state.form, 1, 'the form still morphs');
  assert.ok(rolls.every((roll) => roll === 0), 'the spinner never turns');
  director.done(3000);
  run(3000, 8000);
  assert.deepEqual(seen, ['working', 'workingEnd'], 'Jet never left the ground, so it does not settle');
  assert.ok(player.standing);
});
