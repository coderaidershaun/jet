import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildHello } from './hello.js';
import { createPlayer } from './player.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../src/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };
const tracks = ['body', 'eyes', 'colour', 'scale', 'ring', 'speed'];

const nearly = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test('every track runs forward in time and the clip ends back at the circle', () => {
  const clip = buildHello(rig, shipmate);
  for (const name of tracks) {
    const times = clip[name].map((k) => k.t);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], name + ' goes backwards at key ' + i);
  }
  assert.deepEqual(clip.phases.map((p) => p.name), ['stand up', 'hello', 'melt']);
  assert.ok(clip.phases[0].end < clip.phases[1].end && clip.phases[1].end < clip.total);
  assert.deepEqual(clip.body.at(-1).v, rig.poses.circle);
  assert.equal(clip.eyes.at(-1).v[4], 0, 'eyes are gone before the melt');
  assert.ok(clip.readout.length > 5);
});

test('playful adds wave cycles, serious removes them, reduced motion has none', () => {
  assert.equal(buildHello(rig, { ...shipmate, playful: 1 }).info.cycles, 3);
  assert.equal(buildHello(rig, { ...shipmate, playful: -1 }).info.cycles, 1);
  assert.equal(buildHello(rig, { ...shipmate, reducedMotion: true }).info.cycles, 0);
});

test('shape at zero never leaves the circle', () => {
  const clip = buildHello(rig, { ...shipmate, shape: 0 });
  for (const key of clip.body) assert.ok(nearly(key.v, rig.poses.circle), 'a body key left the circle');
});

test('eyes at zero never show a face', () => {
  const clip = buildHello(rig, { ...shipmate, eyes: 0 });
  for (const key of clip.eyes) assert.equal(key.v[4], 0);
});

test('motion switches the extra beats off', () => {
  const still = buildHello(rig, { ...shipmate, motion: 0 }).info;
  const lively = buildHello(rig, { ...shipmate, motion: 10 }).info;
  assert.deepEqual([still.dip, still.lag, still.tuck], [false, false, false]);
  assert.deepEqual([lively.dip, lively.lag, lively.tuck], [true, true, true]);
});

test('candid holds the arm up and deferential bows instead', () => {
  const candid = buildHello(rig, { ...shipmate, candid: 0.8 });
  const neutral = buildHello(rig, { ...shipmate, candid: 0 });
  const deferential = buildHello(rig, { ...shipmate, candid: -0.8 });
  assert.ok(candid.info.reach > neutral.info.reach && neutral.info.reach > deferential.info.reach);
  assert.equal(neutral.info.bow, 0);
  assert.ok(deferential.info.bow > 0.5);
});

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
