import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildZoom } from './clips/zoom.js';
import { createDirector, MOODS } from './director.js';
import { createPlayer } from './player.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../rig/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };
const FRAME_MS = 16;

function setup(dials = shipmate) {
  const player = createPlayer(rig);
  const director = createDirector({ player, rig, params: () => dials });
  const seen = [];
  // Runs frames from `from` to `to` and records each new clip name that shows up.
  function run(from, to) {
    for (let now = from; now <= to; now += FRAME_MS) {
      const { clip } = director.tick(now);
      if (clip && seen.at(-1) !== clip) seen.push(clip);
    }
    return to;
  }
  return { director, player, seen, run };
}

const ZOOM_DONE_MS = 3500;

test('a send zooms, then the loop runs until the reply arrives', () => {
  const { director, seen, run } = setup();
  const zoom = buildZoom(rig, shipmate, { cruiseMs: 2000 });
  const [launch, cruise] = zoom.phases;
  assert.deepEqual(
    director.send({ cruiseMs: 2000 }, 0),
    { moveAt: launch.end, moveMs: cruise.end - launch.end },
    'the host moves the thread during the cruise',
  );
  assert.equal(director.status, 'travelling');
  run(0, ZOOM_DONE_MS);
  assert.equal(director.status, 'working');
  run(ZOOM_DONE_MS, 40000);
  assert.deepEqual(seen, ['zoom', 'working'], 'the loop carries on through its continuation');
  director.replying(40000);
  run(40000, 41000);
  assert.deepEqual(seen, ['zoom', 'working', 'workingEnd']);
  assert.equal(director.status, 'idle');
  assert.equal(director.tick(42000).busy, false);
});

test('a quick reply skips the loop and plays nothing after the zoom', () => {
  const { director, seen, run } = setup();
  director.send({ cruiseMs: 800 }, 0);
  run(0, 100);
  director.replying(100);
  director.done(150);
  run(150, 5000);
  assert.deepEqual(seen, ['zoom']);
  assert.equal(director.status, 'idle');
});

test('a hello mood while working ends the loop, then plays a brief hello', () => {
  const { director, player, seen, run } = setup();
  director.send({ cruiseMs: 800 }, 0);
  run(0, 3000);
  director.mood('hello', 3000);
  run(3000, 3010);
  assert.equal(director.status, 'working', 'the loop is closing, not skipped');
  let now = 3010;
  while (seen.at(-1) !== 'hello' && now < 6000) run(now, (now += FRAME_MS));
  assert.deepEqual(seen, ['zoom', 'working', 'workingEnd', 'hello']);
  assert.equal(player.clip.info.brief, true);
  assert.equal(director.status, 'reacting');
});

test('a hello mood during the zoom plays once the zoom is over, and the loop never starts', () => {
  const { director, seen, run } = setup();
  director.send({ cruiseMs: 800 }, 0);
  run(0, 100);
  director.mood('  HELLO ', 100);
  run(100, 8000);
  assert.deepEqual(seen, ['zoom', 'hello']);
});

test('every other mood word only closes the loop', () => {
  for (const word of [...MOODS.filter((w) => w !== 'hello'), 'flabbergasted', '']) {
    const { director, seen, run } = setup();
    director.send({ cruiseMs: 800 }, 0);
    run(0, 3000);
    director.mood(word, 3000);
    run(3000, 6000);
    assert.deepEqual(seen, ['zoom', 'working', 'workingEnd'], JSON.stringify(word) + ' plays nothing after the loop');

    const resting = setup();
    resting.director.mood(word, 0);
    assert.equal(resting.director.tick(16).clip, null, JSON.stringify(word) + ' plays nothing at rest');
  }
});

test('done, a failure and a stop each close the loop and play nothing after it', () => {
  for (const end of ['done', 'failed', 'stopped']) {
    const { director, seen, run } = setup();
    director.send({ cruiseMs: 800 }, 0);
    run(0, 3000);
    director[end](3000);
    run(3000, 8000);
    assert.deepEqual(seen, ['zoom', 'working', 'workingEnd'], end);
    assert.equal(director.tick(8016).busy, false, end);
  }
});

test('a failure or a stop drops a queued hello, and done keeps it', () => {
  for (const [end, after] of [['failed', []], ['stopped', []], ['done', ['hello']]]) {
    const { director, seen, run } = setup();
    director.send({ cruiseMs: 800 }, 0);
    run(0, 3000);
    director.mood('hello', 3000);
    director[end](3016);
    run(3016, 9000);
    assert.deepEqual(seen, ['zoom', 'working', 'workingEnd', ...after], end);
  }
});

test('a stop during the zoom lets it land, and the loop never starts', () => {
  const { director, seen, run } = setup();
  director.send({ cruiseMs: 800 }, 0);
  run(0, 100);
  director.stopped(100);
  run(100, 8000);
  assert.deepEqual(seen, ['zoom']);
  assert.equal(director.status, 'idle');
});

test('hello waits while a reply runs', () => {
  const { director, seen, run } = setup();
  director.send({ cruiseMs: 800 }, 0);
  director.hello(16);
  run(16, 3000);
  assert.deepEqual(seen, ['zoom', 'working']);
});

test('reduced motion moves nowhere and skips the zoom', () => {
  const { director, seen, run } = setup({ ...shipmate, reducedMotion: true });
  assert.deepEqual(director.send({ cruiseMs: 2000 }, 0), { moveAt: 0, moveMs: 0 });
  run(0, 3000);
  assert.deepEqual(seen, ['working']);
  assert.equal(director.status, 'working');
});
