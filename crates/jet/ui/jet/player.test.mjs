import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildHello } from './clips/hello.js';
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
