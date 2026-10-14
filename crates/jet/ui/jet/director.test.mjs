import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDrop } from './clips/drop.js';
import { buildZoom } from './clips/zoom.js';
import { createDirector, MOODS } from './director.js';
import { createPlayer } from './player.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../rig/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };
const FRAME_MS = 16;

function setup(dials = shipmate, random) {
  const player = createPlayer(rig);
  const director = createDirector({ player, rig, params: () => dials, random });
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
  let draws = 0;
  const random = () => {
    draws += 1;
    return 0.99;
  };
  const { director, seen, run } = setup(shipmate, random);
  const zoom = buildZoom(rig, shipmate, { cruiseMs: 2000 });
  const [launch, cruise] = zoom.phases;
  assert.deepEqual(
    director.send({ cruiseMs: 2000, dx: -300, dy: 400 }, 0),
    { moveAt: launch.end, moveMs: cruise.end - launch.end, profile: 'roll' },
    'the host moves the thread during the cruise and flies Jet with a roll',
  );
  assert.ok(draws > 0, 'the director chooses with the random it was given');
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

test('a quick reply skips the loop', () => {
  const { director, seen, run } = setup();
  director.send({ cruiseMs: 800 }, 0);
  run(0, 100);
  director.replying(100);
  director.done({ elapsedMs: 700 }, 150);
  run(150, 5000);
  assert.deepEqual(seen, ['zoom', 'done']);
});

test('a mood while working ends the loop before the mood plays', () => {
  const { director, seen, run } = setup();
  director.send({ cruiseMs: 800 }, 0);
  run(0, 3000);
  director.mood('excited', 3000);
  run(3000, 3010);
  assert.equal(director.status, 'working', 'the loop is closing, not skipped');
  run(3010, 8000);
  assert.deepEqual(seen, ['zoom', 'working', 'workingEnd', 'excited']);

  const failing = setup();
  failing.director.send({ cruiseMs: 800 }, 0);
  failing.run(0, 3000);
  failing.director.mood('excited', 3000);
  failing.run(3000, 3016);
  failing.director.failed(3016);
  assert.equal(failing.director.tick(3032).clip, 'workingEnd', 'a failure does not cut the loop while it closes');
  let now = 3032;
  while (failing.seen.at(-1) === 'workingEnd' && now < 5000) failing.run(now, (now += FRAME_MS));
  assert.deepEqual(failing.seen, ['zoom', 'working', 'workingEnd', 'error'], 'the error plays once the loop has closed');
  assert.equal(failing.director.status, 'failed');
  failing.run(now, 8000);
  assert.ok(!failing.seen.includes('excited'), 'the mood that was waiting is dropped');
});

test('done waits for the mood to finish', () => {
  const { director, player, seen, run } = setup();
  director.send({ cruiseMs: 800 }, 0);
  run(0, 3000);
  director.mood('thinking', 3000);
  run(3000, 4500);
  assert.equal(seen.at(-1), 'thinking');
  director.done({ elapsedMs: 9000 }, 4500);
  assert.equal(director.status, 'reacting', 'the mood is not cut');
  run(4500, 5000);
  assert.equal(seen.at(-1), 'thinking');
  let now = 5000;
  while (seen.at(-1) !== 'done' && now < 9000) run(now, (now += FRAME_MS));
  assert.deepEqual(seen.slice(-2), ['thinking', 'done']);
  assert.equal(player.clip.info.long, true, 'a job of 9 s gets the long done');
  run(now, 12000);
  assert.equal(seen.filter((name) => name === 'done').length, 1);
});

test('stop plays interrupted at once and drops the queue', () => {
  const { director, seen, run } = setup();
  director.send({ cruiseMs: 800 }, 0);
  run(0, 3000);
  director.mood('excited', 3000);
  director.done({ elapsedMs: 3000 }, 3000);
  run(3000, 3100);
  director.stopped(3100);
  assert.equal(director.tick(3116).clip, 'interrupted');
  assert.equal(director.status, 'stopped');
  run(3116, 9000);
  assert.equal(seen.at(-1), 'interrupted', 'nothing queued plays afterwards');
  assert.equal(director.tick(9016).busy, false);
});

test('typing leans only when idle and leans back only after a lean', () => {
  const { director, seen, run } = setup();
  director.typing(false, 0);
  run(0, 100);
  assert.deepEqual(seen, [], 'no lean back without a lean');
  director.typing(true, 100);
  run(100, 500);
  assert.equal(director.status, 'typing');
  director.typing(true, 500);
  director.typing(false, 600);
  run(600, 1200);
  assert.deepEqual(seen, ['lean', 'leanBack']);
  assert.equal(director.status, 'idle');

  director.send({ cruiseMs: 800 }, 2000);
  director.typing(true, 2100);
  run(2000, 2200);
  assert.equal(director.status, 'travelling', 'no lean during a reply');
  assert.deepEqual(seen, ['lean', 'leanBack', 'zoom']);
});

test('an unknown mood is treated as neutral', () => {
  const { director, seen, run } = setup();
  director.send({ cruiseMs: 800 }, 0);
  run(0, 3000);
  director.mood('flabbergasted', 3000);
  run(3000, 6000);
  assert.deepEqual(seen, ['zoom', 'working', 'workingEnd'], 'the loop closes and nothing else plays');

  const spoken = setup();
  spoken.director.mood('  HAPPY ', 0);
  spoken.run(0, 100);
  assert.deepEqual(spoken.seen, ['done']);
  for (const word of MOODS.filter((w) => w !== 'neutral')) {
    const { director: d, seen: s, run: r } = setup();
    d.mood(word, 0);
    r(0, 100);
    assert.equal(s.length, 1, word + ' plays a clip');
  }
});

test('reduced motion moves nowhere and skips the zoom', () => {
  const { director, seen, run } = setup({ ...shipmate, reducedMotion: true });
  assert.deepEqual(director.send({ cruiseMs: 2000 }, 0), { moveAt: 0, moveMs: 0, profile: 'roll' });
  run(0, 3000);
  assert.deepEqual(seen, ['working']);
  assert.equal(director.status, 'working');
});

test('the drop and the abseil are picked only for a move mostly straight down', () => {
  const profileFor = (move, chance) => {
    let draws = 0;
    const random = () => {
      draws += 1;
      return chance;
    };
    const { director } = setup(shipmate, random);
    const { profile } = director.send({ cruiseMs: 1400, ...move }, 0);
    assert.ok(draws > 0, 'the director chooses with the random it was given');
    return profile;
  };
  const chances = [0.1, 0.5, 0.9];
  assert.deepEqual(chances.map((chance) => profileFor({ dx: 0, dy: 400 }, chance)), ['roll', 'drop', 'abseil']);
  for (const move of [{ dx: 200, dy: 400 }, { dx: 0, dy: -400 }, { dx: 0, dy: 0 }]) {
    assert.deepEqual(chances.map((chance) => profileFor(move, chance)), ['roll', 'roll', 'roll'], JSON.stringify(move) + ' only rolls');
  }
});

test('a drop keeps its own timing, then the loop runs until the reply arrives', () => {
  const { director, seen, run } = setup(shipmate, () => 0.5);
  const drop = buildDrop(rig, shipmate, { cruiseMs: 1400 });
  const [launch, cruise] = drop.phases;
  assert.deepEqual(
    director.send({ cruiseMs: 1400, dx: 0, dy: 400 }, 0),
    { moveAt: launch.end, moveMs: cruise.end - launch.end, profile: 'drop' },
    'the host moves the thread during the drop\'s cruise and drops Jet',
  );
  assert.equal(director.status, 'travelling');
  run(0, drop.total + FRAME_MS);
  assert.equal(director.status, 'working');
  assert.deepEqual(seen, ['drop', 'working']);
});
