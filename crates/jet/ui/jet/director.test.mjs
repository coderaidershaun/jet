import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDrop } from './clips/drop.js';
import { CLIPS } from './clips/catalogue.js';
import { buildZoom } from './clips/zoom.js';
import { createDirector, MOODS } from './director.js';
import { createPlayer } from './player.js';
import { PROP, PROP_STRIDE } from './state.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../rig/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };
const FRAME_MS = 16;

// A draw of 0 takes the first of every choice, which is no send reaction.
function setup(dials = shipmate, random = () => 0) {
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
// Each choice the director makes takes the next of these draws, then 0.
const drawsOf = (...draws) => () => draws.shift() ?? 0;

test('a send zooms, then the loop runs until the reply arrives', () => {
  let draws = 0;
  const random = () => {
    draws += 1;
    return 0;
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
  const { director, seen, run } = setup(shipmate, () => 0);
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

test("typing picks lean, peer or creep with the director's random, and leans back from each", () => {
  const picks = [0, 0.5, 0.99];
  const { director, seen, run } = setup(shipmate, () => picks.shift());
  let now = 0;
  for (let i = 0; i < 3; i++) {
    director.typing(true, now);
    run(now, now + 600);
    director.typing(false, now + 600);
    now = run(now + 600, now + 1400) + FRAME_MS;
  }
  assert.deepEqual(seen, ['lean', 'leanBack', 'peer', 'leanBack', 'creep', 'leanBack']);
  assert.equal(director.status, 'idle');
});

test('a stall plays an antic only when idle or leaning, and keeps it going until something else plays', () => {
  const juggling = setup(shipmate, () => 0);
  juggling.director.stall(0);
  juggling.run(0, 100);
  assert.equal(juggling.director.status, 'typing');
  juggling.run(100, 25000);
  assert.deepEqual(juggling.seen, ['batBall'], 'the bat and ball carry on past one loop');
  assert.equal(juggling.player.clip.info.continued, true, 'the loop playing now carries on the first');

  const dozing = setup(shipmate, () => 0.99);
  dozing.director.stall(0);
  dozing.run(0, 100);
  assert.deepEqual(dozing.seen, ['doze']);

  const leaning = setup(shipmate, () => 0);
  leaning.director.typing(true, 0);
  leaning.run(0, 500);
  leaning.director.stall(500);
  leaning.run(500, 600);
  assert.deepEqual(leaning.seen, ['lean', 'batBall'], 'a stall after a lean plays an antic');

  const slow = setup({ ...shipmate, motion: 2 }, () => 0);
  slow.director.stall(0);
  slow.run(0, 100);
  assert.deepEqual(slow.seen, ['doze'], 'below motion 3 there is no bat to hold, so Jet dozes');

  const replying = setup(shipmate, () => 0);
  replying.director.send({ cruiseMs: 800 }, 0);
  replying.run(0, 100);
  replying.director.stall(100);
  replying.run(100, 200);
  assert.deepEqual(replying.seen, ['zoom'], 'no antic during a reply');

  const moved = setup(shipmate, () => 0);
  moved.director.mood('excited', 0);
  moved.run(0, 100);
  moved.director.stall(100);
  moved.run(100, 200);
  assert.deepEqual(moved.seen, ['excited'], 'no antic during a mood');

  const reduced = setup({ ...shipmate, reducedMotion: true }, () => 0);
  reduced.director.stall(0);
  reduced.run(0, 100);
  assert.deepEqual(reduced.seen, [], 'no antic under reduced motion');

  const dials = { ...shipmate };
  const switched = setup(dials, () => 0);
  switched.director.stall(0);
  switched.run(0, 100);
  dials.reducedMotion = true;
  switched.run(100, 12000);
  assert.deepEqual(switched.seen, ['batBall', 'batBallEnd'], 'once reduced motion is on, the antic ends instead of carrying on');
  assert.equal(switched.director.status, 'idle');
});

test('typing during an antic ends it and then plays a typing hold, and an emptied field ends it with nothing after', () => {
  const picks = [0, 0.5];
  const typingAgain = setup(shipmate, () => picks.shift());
  typingAgain.director.stall(0);
  typingAgain.run(0, 3000);
  typingAgain.director.typing(true, 3000);
  typingAgain.run(3000, 5000);
  assert.deepEqual(typingAgain.seen, ['batBall', 'batBallEnd', 'peer'], 'the antic ends with its own clip, then Jet peers in');
  assert.equal(typingAgain.director.status, 'typing');
  typingAgain.director.typing(false, 5000);
  typingAgain.run(5000, 6000);
  assert.equal(typingAgain.seen.at(-1), 'leanBack');
  assert.equal(typingAgain.director.status, 'idle');

  const emptied = setup(shipmate, () => 0);
  emptied.director.stall(0);
  emptied.run(0, 3000);
  emptied.director.typing(false, 3000);
  emptied.run(3000, 6000);
  assert.deepEqual(emptied.seen, ['batBall', 'batBallEnd'], 'an emptied field ends the antic and nothing follows');
  assert.equal(emptied.director.status, 'idle');

  const changedMind = setup(shipmate, () => 0);
  changedMind.director.stall(0);
  changedMind.run(0, 3000);
  changedMind.director.typing(true, 3000);
  changedMind.director.typing(false, 3000);
  changedMind.run(3000, 6000);
  assert.deepEqual(changedMind.seen, ['batBall', 'leanBack'], 'no typing hold plays after the lean back');
  assert.equal(changedMind.director.status, 'idle');
});

test('a send or a hello during an antic ends it with both props hidden', () => {
  const propOpacities = (prop) => [prop[PROP.OPACITY], prop[PROP_STRIDE + PROP.OPACITY]];
  const interruptions = {
    zoom: (director, now) => director.send({ cruiseMs: 800 }, now),
    hello: (director, now) => director.hello(now),
  };
  for (const [clip, interrupt] of Object.entries(interruptions)) {
    const { director, player, seen, run } = setup(shipmate, () => 0);
    director.stall(0);
    run(0, 1000);
    assert.ok(propOpacities(player.state.prop).every((opacity) => opacity > 0), 'the bat and the ball show before the ' + clip);
    interrupt(director, 1000);
    run(1000, 1216);
    assert.deepEqual(propOpacities(player.state.prop), [0, 0], 'the bat and the ball are gone 216 ms into the ' + clip);
    assert.equal(seen.at(-1), clip);
  }
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
  // the first draw picks no send reaction, the second picks the drop
  const { director, seen, run } = setup(shipmate, drawsOf(0, 0.5));
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

test('a send reaction plays first and the travel waits for it', () => {
  const firstDraw = { salute: 0.2, nod: 0.4, blink: 0.6, hop: 0.8 };
  for (const [name, draw] of Object.entries(firstDraw)) {
    const { director, seen, run } = setup(shipmate, drawsOf(draw));
    const reaction = CLIPS[name].build(rig, shipmate);
    const [launch, cruise] = buildZoom(rig, shipmate, { cruiseMs: 2000 }).phases;
    assert.deepEqual(
      director.send({ cruiseMs: 2000, dx: -300, dy: 400 }, 0),
      { moveAt: reaction.total + launch.end, moveMs: cruise.end - launch.end, profile: 'roll' },
      name + ': the host moves the thread only once the send reaction is over and the launch is done',
    );
    assert.equal(director.status, 'reacting', name);
    run(0, reaction.total - 1);
    assert.equal(director.status, 'reacting', name + ' is still playing');
    run(reaction.total, reaction.total);
    assert.equal(director.status, 'travelling', name + ' has ended and the travel starts');
    run(reaction.total, reaction.total + ZOOM_DONE_MS);
    assert.deepEqual(seen, [name, 'zoom', 'working']);
  }
});

test('a mood during the send reaction plays after the travel, and a stop drops the travel', () => {
  const salute = drawsOf(0.2);
  const { director, seen, run } = setup(shipmate, salute);
  director.send({ cruiseMs: 800 }, 0);
  run(0, 100);
  director.mood('excited', 100);
  run(100, 6000);
  assert.deepEqual(seen, ['salute', 'zoom', 'excited']);

  const stopping = setup(shipmate, drawsOf(0.2));
  stopping.director.send({ cruiseMs: 800 }, 0);
  stopping.run(0, 100);
  stopping.director.stopped(100);
  stopping.run(100, 6000);
  assert.deepEqual(stopping.seen, ['salute', 'interrupted'], 'the travel that was waiting is dropped');
});

test('a serious Jet skips the blink as a message goes out', () => {
  const firstClipAt = (dials, draw) => {
    const { director, seen, run } = setup(dials, drawsOf(draw));
    director.send({ cruiseMs: 800 }, 0);
    run(0, 0);
    return seen[0];
  };
  const serious = { ...shipmate, playful: -0.5 };
  for (let draw = 0; draw < 1; draw += 0.05) assert.notEqual(firstClipAt(serious, draw), 'blink', 'draw ' + draw);
  assert.equal(firstClipAt(shipmate, 0.6), 'blink', 'a Jet that is not serious still blinks');
});
