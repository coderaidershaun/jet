import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eyeSizeFor, REST_EYE_SIZE } from './clip.js';
import { buildHello } from './clips/hello.js';
import { buildWorking } from './clips/working.js';
import { createPlayer } from './player.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../rig/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };

const nearly = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test('the player starts a clip from wherever Jet is and comes to rest when it ends', () => {
  const player = createPlayer(rig);
  player.state.body = rig.poses.soft.slice();
  const clip = buildHello(rig, shipmate);
  player.play(clip, 1000);
  assert.ok(player.playing);
  player.tick(1000);
  assert.deepEqual(player.state.body, rig.poses.soft, 'the first frame is the pose Jet was already in');
  const progress = player.tick(1000 + clip.phases[0].end + 400);
  assert.ok(!nearly(player.state.body, rig.poses.circle), 'mid-hello Jet is not a circle');
  assert.equal(progress.phases[0], 1, 'the stand-up phase is complete');
  assert.ok(progress.phases[1] > 0 && progress.phases[1] < 1, 'the hello phase is under way');
  player.tick(1000 + clip.total + 1);
  assert.ok(!player.playing);
  assert.deepEqual(player.state.body, rig.poses.circle);
  assert.equal(player.state.speed, 0);
});

test('at rest the circle opens its eyes, a hold away from the circle keeps its own, and eyes below 1.5 show none', () => {
  const player = createPlayer(rig, { random: () => 0.99 });
  player.eyes = 4;
  const open = REST_EYE_SIZE * eyeSizeFor(4);
  player.tick(120);
  const opening = player.state.eyes;
  assert.deepEqual(opening.slice(0, 4), rig.eyes.circle, 'the resting eyes sit where the circle keeps its eyes');
  assert.ok(opening[4] > 0 && opening[4] < open, 'they grow in place instead of cutting in');
  assert.ok(player.eyesMoved, 'the host is told to draw while they open');
  player.tick(300);
  assert.deepEqual(player.state.eyes, [...rig.eyes.circle, open, open]);
  player.tick(350);
  assert.equal(player.eyesMoved, false, 'open resting eyes need no drawing of their own');

  const loop = buildWorking(rig, shipmate, { spinMs: 1000 });
  player.play(loop, 400);
  player.tick(400 + loop.total + 1);
  const leftByTheLoop = player.state.eyes.slice();
  player.tick(400 + loop.total + 600);
  assert.deepEqual(player.state.eyes, leftByTheLoop, 'a hold away from the circle keeps the eyes it ended with');
  assert.equal(player.eyesMoved, false);

  for (const dial of [1, 0]) {
    const dim = createPlayer(rig);
    dim.eyes = dial;
    dim.tick(300);
    assert.deepEqual(dim.state.eyes.slice(4, 6), [0, 0], 'eyes ' + dial + ' shows no resting eyes');
  }
});

test('the resting eyes blink on a random gap of 4 to 9 s, and never under reduced motion', () => {
  // The player uses the first number when it is made, and 0 gives the shortest first gap, 4 s.
  const scripted = () => {
    const numbers = [0, 0.5];
    return () => numbers.shift() ?? 0.5;
  };
  const open = REST_EYE_SIZE * eyeSizeFor(4);
  const sizeAt = (player, now) => {
    player.tick(now);
    return player.state.eyes.slice(4, 6);
  };

  const player = createPlayer(rig, { random: scripted() });
  player.eyes = 4;
  assert.deepEqual(sizeAt(player, 3999), [open, open], 'open just before the first blink');
  assert.deepEqual(sizeAt(player, 4060), [open, 0], 'shut 60 ms into the blink');
  assert.deepEqual(sizeAt(player, 4140), [open, open], 'open again 140 ms after it began');
  // The tick at 4140 ends that blink and picks the next gap: 4 s plus half of the 5 s range.
  assert.deepEqual(sizeAt(player, 10639), [open, open], 'open until the next blink');
  assert.deepEqual(sizeAt(player, 10700), [open, 0], 'the next blink comes 6.5 s later');

  const still = createPlayer(rig, { random: scripted() });
  still.eyes = 4;
  still.reducedMotion = true;
  assert.deepEqual(sizeAt(still, 3999), [open, open]);
  assert.deepEqual(sizeAt(still, 4060), [open, open], 'reduced motion never blinks');
});

test('idle breathing moves the scale by 1.8% at full motion', () => {
  const player = createPlayer(rig);
  player.breathing = 10;
  player.tick(3400 / 4);
  assert.ok(Math.abs(player.state.scale - 1.018) < 1e-9, 'a quarter of a breath in, the scale is ' + player.state.scale);
});
