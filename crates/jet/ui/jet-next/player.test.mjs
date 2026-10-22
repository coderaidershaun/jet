import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClip } from './clip.js';
import { HOVER_Y } from './parts/forms.js';
import { createPlayer } from './player.js';

const FRAME_MS = 40;

// Ticks the player on a fixed clock from `from` to `to`, calling `each(now)` after every tick.
function run(player, from, to, each = () => {}) {
  for (let now = from; now <= to; now += FRAME_MS) {
    player.tick(now);
    each(now);
  }
}

// The keys of a clip as plain data, to compare before and after a run.
const keysOf = (clip) =>
  JSON.stringify(Object.entries(clip).map(([name, value]) => [name, Array.isArray(value) ? value.map(({ t, v }) => [t, v]) : value]));

test('a clip plays from the live state and its keys are left untouched', () => {
  const player = createPlayer({ layers: false });
  player.state.y = 30;
  player.state.lift = [4, 8];
  const { clip, y, lift, phase, finish } = createClip();
  y(400, 0);
  lift(400, [0, 20]);
  phase('go', 400);
  finish();
  const keysBefore = keysOf(clip);

  player.play(clip, 1000);
  player.tick(1000);
  assert.equal(player.state.y, 30, 'the first frame is where Jet already was');
  assert.deepEqual(player.state.lift, [4, 8]);
  assert.ok(player.playing);
  player.tick(1200);
  assert.equal(player.state.y, 15);
  assert.deepEqual(player.state.lift, [2, 14]);
  const end = player.tick(1400);
  assert.equal(end.phases[0], 1);
  assert.equal(player.playing, false, 'the clip ends at its total');
  assert.equal(player.state.y, 0, 'the state keeps the last values');
  assert.deepEqual(keysOf(clip), keysBefore, 'playing never changes the clip');

  player.play(clip, 2000);
  player.tick(2000);
  assert.equal(player.state.y, 0, 'the second run starts from where Jet is now, not from where the first one started');
  player.tick(2200);
  assert.deepEqual(player.state.lift, [0, 20], 'the lift holds at 20, where the first run left it');
  assert.equal(player.state.y, 0);
});

test('the body rolls a tenth of the lift 100 ms late, across a clip change', () => {
  const player = createPlayer({ layers: false });
  const rise = createClip();
  rise.lift(400, [0, 20]);
  rise.phase('rise', 400);
  const fall = createClip();
  fall.lift(400, [0, 0]);
  fall.phase('fall', 400);

  // The lift as it really was: rising to 20 until the second clip takes over at 200 ms, then back to 0.
  const liftAt = (ms) => (ms < 200 ? Math.max(0, (20 * ms) / 400) : Math.max(0, 10 * (1 - (ms - 200) / 400)));
  player.play(rise.finish(), 0);
  for (let now = 0; now <= 700; now += FRAME_MS) {
    player.tick(now);
    assert.ok(Math.abs(player.frame.roll - -0.1 * liftAt(now - 100)) < 1e-9, `roll at ${now} ms`);
    if (now === 200) player.play(fall.finish(), 200);
  }
  const left = createPlayer({ layers: false });
  const lowerLeft = createClip();
  lowerLeft.lift(100, [30, 0]);
  lowerLeft.phase('lift', 100);
  left.play(lowerLeft.finish(), 0);
  run(left, 0, 400);
  assert.ok(Math.abs(left.frame.roll - 3) < 1e-9, 'a lifted left corner rolls the body the other way');
});

test('stretch follows the lift speed on the moving corner only', () => {
  const player = createPlayer({ layers: false });
  const { clip, lift, phase, finish } = createClip();
  lift(300, [0, 30]);
  phase('lift', 300);
  player.play(finish(), 0);

  player.tick(150);
  assert.deepEqual(player.frame.liftSpeed.map(Math.round), [0, 100], 'the right corner rises at 100 degrees a second');
  assert.ok(Math.abs(player.frame.stretch[1] - 1) < 1e-9, '100 of 250 degrees a second stretches by 2.5 x 0.4');
  assert.equal(player.frame.stretch[0], 0, 'the resting corner is never pushed out');
  player.tick(1000);
  assert.deepEqual(player.frame.stretch, [0, 0], 'a corner that holds still does not stretch');
  assert.equal(player.stretchFromSpeed(-600), 2.5, 'stretch stops at 2.5 units, in either direction');
});

test('the idle layers stay on during a clip and go off with layers false', () => {
  const busy = createClip();
  busy.lift(2000, [0, 10]);
  busy.phase('wave', 2000);
  const clip = busy.finish();

  const on = createPlayer();
  const off = createPlayer({ layers: false });
  for (const player of [on, off]) player.play(clip, 0);
  on.tick(750);
  off.tick(750);
  assert.ok(on.playing);
  assert.ok(Math.abs(on.frame.y - (HOVER_Y + 1.6)) < 1e-9, 'the bob is at the top of its 3 s swing');
  assert.equal(off.frame.y, HOVER_Y);
  assert.equal(on.state.y, HOVER_Y, 'the layers never change the state');
  assert.ok(Math.abs(off.frame.roll - -0.325) < 1e-9, 'with the layers off only the hand moves the body');
  const sway = Math.abs(on.frame.roll - off.frame.roll);
  assert.ok(sway > 0 && sway < 1, 'the string sways the hovering body a little');

  const standing = createPlayer({ standing: true });
  standing.tick(0);
  assert.equal(standing.frame.roll, -2, 'a standing kite leans two degrees towards its string');
  const still = createPlayer({ standing: true, reducedMotion: true });
  still.tick(0);
  assert.equal(still.frame.roll, 0, 'reduced motion holds the layers still');
});

test('the contact point stays put while y is 0, and y never goes below 0', () => {
  const player = createPlayer({ standing: true });
  const crouch = createClip();
  crouch.squash(140, [1.087, 0.92]);
  crouch.roll(300, 12);
  crouch.y(400, -6);
  crouch.phase('crouch', 400);
  player.play(crouch.finish(), 0);
  run(player, 0, 500, () => {
    const [x, y] = player.frame.string[0];
    assert.ok(Math.hypot(x - 100, y - 231.8) < 0.2, `the foot slid to ${x}, ${y}`);
    assert.ok(player.frame.y >= 0, 'the kite never sinks into the floor');
  });
  assert.equal(player.state.y, -6, 'only the frame is kept above the floor');
});

test('blinks come on a random gap of 4 to 9 s with a 40 ms hold, never under reduced motion', () => {
  // The first number gives the shortest gap, 4 s; the next gives 6.5 s.
  const closures = (player, until) => {
    const seen = [];
    for (let now = 0; now <= until; now += 10) {
      player.tick(now);
      seen.push([now, player.frame.eyes.lids[0]]);
    }
    return seen;
  };
  const shut = (seen) => seen.filter(([, closure]) => Math.abs(closure - 1) < 1e-9).map(([now]) => now);

  const player = createPlayer({ random: sequence(0) });
  const seen = closures(player, 14000);
  assert.equal(seen.find(([now]) => now < 4000 && closure(seen, now) !== 0), undefined, 'no blink before 4 s');
  assert.deepEqual(shut(seen).filter((now) => now < 5000), [4060, 4070, 4080, 4090, 4100], 'shut for 40 ms');
  assert.deepEqual(shut(seen).filter((now) => now > 5000), [10560, 10570, 10580, 10590, 10600], 'the next blink comes 6.5 s later');
  assert.ok(Math.abs(Math.min(...seen.map(([, c]) => c)) - -0.07) < 1e-9, 'the lid opens with an overshoot');
  assert.equal(closure(seen, 4340), 0, 'the blink is over after 340 ms');

  const quick = createPlayer({ random: sequence(0) });
  const clip = createClip();
  clip.lift(600, [0, 0]);
  clip.phase('busy', 600);
  quick.play(clip.finish(), 3900);
  const during = closures(quick, 4500).filter(([now]) => now >= 3900);
  assert.deepEqual(shut(during), [], 'a blink that falls inside a clip is skipped');

  const still = createPlayer({ random: sequence(0), reducedMotion: true });
  assert.deepEqual(shut(closures(still, 14000)), [], 'reduced motion never blinks');
});

test('a keyed eye kind waits for shut lids, and round returns on the first idle blink 3 s after a clip', () => {
  const player = createPlayer({ random: sequence(0) });
  const shutting = createClip();
  shutting.eyeKind(100, 'lid');
  shutting.lids(300, [1, 1]);
  shutting.lids(340, [1, 1]);
  shutting.lids(500, [0, 0]);
  shutting.phase('shut', 500);
  player.tick(0);
  player.play(shutting.finish(), 0);
  const kindAt = {};
  run(player, 20, 500, (now) => (kindAt[now] = player.frame.eyes.kind));
  assert.equal(player.state.eyeKind, 'lid');
  assert.equal(kindAt[260], 'round', 'the key took hold at 100 ms but the lids are still open');
  assert.equal(kindAt[300], 'lid', 'the kind changes once both lids are shut');
  assert.equal(kindAt[500], 'lid');

  // The clip ended at 500 ms. The first blink, at 4 s, comes 3.5 s later, so it returns the eyes to round.
  player.state.anger = 0.8;
  const blinkKinds = {};
  run(player, 520, 4400, (now) => (blinkKinds[now] = [player.frame.eyes.kind, player.frame.eyes.anger]));
  assert.deepEqual(blinkKinds[4040], ['lid', 0.8], 'still lid until the lid is shut');
  assert.deepEqual(blinkKinds[4080], ['round', 0], 'round under the shut lid');
  assert.deepEqual(blinkKinds[4400], ['round', 0]);

  // A blink less than 3 s after the clip leaves the eyes alone.
  const early = createPlayer({ random: sequence(0) });
  early.state.eyeKind = 'lid';
  const late = createClip();
  late.lift(1500, [0, 0]);
  late.phase('late', 1500);
  early.tick(0);
  early.play(late.finish(), 0);
  run(early, 40, 4400);
  assert.equal(early.frame.eyes.kind, 'lid', 'the blink at 4 s is only 2.5 s after the clip ended');
});

test('carry adds no position and leans the string away from the motion', () => {
  const carried = createPlayer({ layers: false });
  const control = createPlayer({ layers: false });
  run(carried, 0, 800, () => carried.carry(5, 0));
  run(control, 0, 800);
  const [moved, still] = [carried.frame, control.frame];
  assert.equal(moved.y, still.y, 'carry changes no height');
  assert.deepEqual(moved.pivot, still.pivot);
  assert.ok(Math.abs(moved.roll - 1.25) < 0.01, '125 units a second leans the body 1.25 degrees into the motion');
  const freeEnd = (frame) => frame.string[16];
  assert.ok(freeEnd(moved)[0] < freeEnd(still)[0] - 3, 'the free end of the string trails behind a body moving right');

  const racing = createPlayer({ layers: false });
  run(racing, 0, 800, () => racing.carry(100, 0));
  assert.equal(racing.frame.roll, 10, 'the lean stops at 10 degrees');
});

// Gives the numbers in turn as the player's random source, then 0.5 for ever.
function sequence(...numbers) {
  return () => numbers.shift() ?? 0.5;
}

const closure = (seen, at) => seen.find(([now]) => now === at)[1];
