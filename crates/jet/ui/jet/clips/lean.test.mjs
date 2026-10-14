import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPlayer } from '../player.js';
import { buildCreep, buildLean, buildPeer } from './lean.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../../rig/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };

const headY = (body) => body[1];
const handSpan = (body) => body[12] - body[48];
const foot = (body) => [body[30], body[31]];

test('peer rises on tiptoe with faint narrowed eyes, and creep steps closer and stays bigger', () => {
  const lean = buildLean(rig, shipmate).body.at(-1).v;

  const peer = buildPeer(rig, shipmate);
  const peered = peer.body.at(-1).v;
  assert.ok(headY(peered) < headY(lean), 'the peer stands taller than the lean');
  assert.ok(handSpan(peered) < handSpan(lean), 'the peer is narrower than the lean');
  const [, , , , rx, ry, tint] = peer.eyes.at(-1).v;
  assert.equal(tint, 1, 'the peeking eyes stay faint');
  assert.ok(rx > 0 && ry < rx, 'the peeking eyes are open and narrowed');

  const player = createPlayer(rig);
  const creep = buildCreep(rig, shipmate);
  player.play(creep, 0);
  player.tick(creep.total + 200);
  const held = player.state.body;
  assert.ok(!player.playing, 'the creep has ended and Jet holds it');
  assert.ok(handSpan(held) > handSpan(lean), 'the held creep is wider than the lean');
  assert.ok(headY(held) < headY(lean), 'the held creep is taller than the lean');
  assert.deepEqual(foot(held), [50, 88], 'the creep keeps its foot planted');
});
