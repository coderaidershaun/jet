import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer } from '../player.js';
import { HOVER_Y } from '../parts/forms.js';
import { sample } from '../track.js';
import { buildFly } from './fly.js';

const STANDING = { standing: true, eyeKind: 'round', reducedMotion: false };
const HOVERING = { standing: false, eyeKind: 'round', reducedMotion: false };

test('fly has its four phases, the cruise is cruiseMs long, and y overshoots to 64 then settles at 58.8', () => {
  const clip = buildFly(HOVERING, { cruiseMs: 800 });
  assert.deepEqual(clip.phases, [
    { name: 'anticipate', end: 180 },
    { name: 'launch', end: 500 },
    { name: 'cruise', end: 1300 },
    { name: 'brake', end: 1700 },
  ]);
  assert.equal(clip.total, 1700);
  assert.equal(clip.revealFrom, null);
  assert.equal(sample(clip.y, 500), 64, 'the launch ends at the top, where the host starts to carry the node');
  assert.ok(Math.max(...clip.y.map((key) => key.v)) === 64);
  assert.equal(sample(clip.y, 720), HOVER_Y);
  assert.equal(sample(clip.y, 1700), HOVER_Y);
  assert.ok(sample(clip.y, 600) < 64 && sample(clip.y, 600) > HOVER_Y, 'it eases down while the node is already moving');
  assert.deepEqual(sample(clip.squash, 1700), [1, 1]);
  assert.deepEqual(sample(clip.squash, 1300 + 160), [1.04, 0.962], 'the brake squashes');

  const short = buildFly(HOVERING, { cruiseMs: 100 });
  assert.equal(short.total, 900 + 220, 'a cruise is never shorter than the ease down');
});

test('from standing the crouch squashes and the lying string releases during the launch; from a hover it dips 4', () => {
  const standing = buildFly(STANDING, { cruiseMs: 800 });
  assert.deepEqual(sample(standing.squash, 140), [1.087, 0.92]);
  assert.deepEqual(sample(standing.squash, 180), [1.087, 0.92], 'held to the end of the crouch');
  assert.deepEqual(sample(standing.squash, 280), [0.95, 1.053], 'stretched in the launch');
  assert.deepEqual(sample(standing.squash, 500), [1, 1]);
  assert.equal(sample(standing.y, 180), 0, 'no dip from standing');

  const hovering = buildFly(HOVERING, { cruiseMs: 800 });
  assert.deepEqual(sample(hovering.squash, 180), [1, 1], 'no crouch from a hover');
  assert.equal(sample(hovering.y, 140), HOVER_Y - 4);
  assert.equal(sample(hovering.y, 180), HOVER_Y - 4);
  assert.deepEqual(hovering.stringPose.map(({ t, v }) => [t, v]), [[180, null]], 'a hanging string stays hanging');

  assert.equal(standing.stringPose.length, 2);
  assert.equal(standing.stringPose[0].t, 180);
  assert.deepEqual(standing.stringPose[0].v.raise, { to: 0, lagMs: 40, durationMs: 300, overshoot: 1.4, order: 'base' });
  assert.deepEqual([standing.stringPose[1].t, standing.stringPose[1].v], [1080, null], 'the string hangs once the last segment has let go');

  const player = createPlayer({ random: () => 1, layers: false, standing: true });
  player.play(standing, 0);
  player.tick(170);
  assert.ok(player.state.stringPose.blend.every((blend) => blend === 1), 'the string still lies while Jet crouches');
  player.tick(420);
  const { blend } = player.state.stringPose;
  assert.ok(blend[0] < 0.2, `the base has let go: ${blend[0]}`);
  assert.ok(blend[15] === 1, 'the free end has not started');
  player.tick(1200);
  assert.equal(player.state.stringPose, null);
});
