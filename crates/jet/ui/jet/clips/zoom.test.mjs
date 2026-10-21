import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RING } from '../state.js';
import { sample } from '../track.js';
import { buildZoom } from './zoom.js';
import { buildHello } from './hello.js';
import { createPlayer } from '../player.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../../rig/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };
const tracks = ['body', 'eyes', 'colour', 'scale', 'ring', 'speed'];
const nearly = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test('the zoom runs forward, moves the ground only in the middle, and ends at rest', () => {
  const clip = buildZoom(rig, shipmate);
  for (const name of tracks) {
    const times = clip[name].map((k) => k.t);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], name + ' goes backwards at key ' + i);
  }
  assert.deepEqual(clip.phases.map((p) => p.name), ['launch', 'cruise', 'brake']);
  assert.equal(clip.speed[0].v, 0);
  assert.equal(clip.speed.at(-1).v, 0);
  const midCruise = (clip.phases[0].end + clip.phases[1].end) / 2;
  assert.ok(sample(clip.speed, midCruise) > 100, 'the ground is moving mid-cruise');
  assert.ok(sample(clip.ring, midCruise)[RING.OPACITY] > 0.3, 'the grooves show mid-cruise');
  assert.equal(clip.ring.at(-1).v[RING.OPACITY], 0, 'the grooves are gone at the end');
  assert.deepEqual(clip.body.at(-1).v, rig.poses.circle);
});

test('the cruise length is the host’s decision', () => {
  const short = buildZoom(rig, shipmate, { cruiseMs: 800 });
  const long = buildZoom(rig, shipmate, { cruiseMs: 4000 });
  assert.ok(long.total - short.total > 2500);
});

test('shape at zero never leaves the circle, even while zooming', () => {
  const clip = buildZoom(rig, { ...shipmate, shape: 0 });
  for (const key of clip.body) assert.ok(nearly(key.v, rig.poses.circle), 'a body key left the circle');
});

test('motion and reduced motion take the extras away', () => {
  assert.equal(buildZoom(rig, { ...shipmate, motion: 2 }).info.grooves, false);
  const reduced = buildZoom(rig, { ...shipmate, reducedMotion: true });
  assert.equal(reduced.info.bobDepth, 0);
  assert.equal(reduced.info.grooves, false);
});

test('candid zooms faster and playful bobs more', () => {
  const neutral = buildZoom(rig, { ...shipmate, candid: 0, playful: 0 });
  assert.ok(buildZoom(rig, { ...shipmate, candid: 0.8, playful: 0 }).info.cruiseSpeed > neutral.info.cruiseSpeed);
  assert.ok(buildZoom(rig, { ...shipmate, candid: 0, playful: 0.9 }).info.bobDepth > neutral.info.bobDepth);
});

test('a hello that interrupts a zoom stops the ground and hides the grooves', () => {
  const player = createPlayer(rig);
  player.play(buildZoom(rig, shipmate), 0);
  const zoom = player.clip;
  const midCruise = (zoom.phases[0].end + zoom.phases[1].end) / 2;
  player.tick(midCruise);
  assert.ok(player.state.speed > 100);
  player.play(buildHello(rig, shipmate), midCruise);
  player.tick(midCruise + 1);
  assert.ok(player.state.speed > 50, 'the ground is still moving at the hand-over');
  player.tick(midCruise + 600);
  assert.equal(player.state.speed, 0, 'the ground has stopped');
  assert.equal(player.state.ring[RING.OPACITY], 0, 'the grooves are gone');
});
