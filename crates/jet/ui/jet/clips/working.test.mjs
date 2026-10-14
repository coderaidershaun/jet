import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPlayer } from '../player.js';
import { RING } from '../state.js';
import { sample } from '../track.js';
import { buildWorking, buildWorkingEnd } from './working.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../../rig/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };

// Degrees turned since the first sample, counting every whole turn the ring has made.
function turnedAt(ring, times) {
  let total = 0;
  let last = sample(ring, times[0])[RING.ROTATE];
  const out = [0];
  for (const time of times.slice(1)) {
    const now = sample(ring, time)[RING.ROTATE];
    total += now >= last ? now - last : now + 360 - last;
    last = now;
    out.push(total);
  }
  return out;
}
const every = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

test('the loop opens with its gap at the top right', () => {
  const clip = buildWorking(rig, shipmate);
  assert.deepEqual(clip.phases.map((p) => p.name), ['gather', 'open', 'spin']);
  const ring = sample(clip.ring, clip.phases[0].end + 40);
  assert.ok(ring[RING.DASH_OFF] > 0, 'the gap has started to open');
  const dashShare = ring[RING.DASH_ON] / (ring[RING.DASH_ON] + ring[RING.DASH_OFF]);
  const gapCentre = (ring[RING.ROTATE] + 360 * (dashShare + (1 - dashShare) / 2)) % 360;
  assert.ok(gapCentre > 270 && gapCentre < 360, 'the gap centre is at ' + gapCentre + ' degrees clockwise from 3 o’clock');
});

test('the loop spins clockwise and slows after eight seconds', () => {
  const clip = buildWorking(rig, shipmate);
  const spinStart = clip.phases[1].end;
  const times = every(spinStart, spinStart + 20000, 50);
  const turned = turnedAt(clip.ring, times);
  const degreesPerSecond = (from, to) => ((turned[to] - turned[from]) / ((to - from) * 50)) * 1000;
  assert.ok(Math.abs(degreesPerSecond(2, 12) - 360 / 1.1) < 8, 'one turn in 1.1 s at the start');
  assert.ok(Math.abs(degreesPerSecond(300, 390) - 360 / 1.8) < 8, 'one turn in 1.8 s after the slowing turn');
  for (let i = 1; i < turned.length; i++) assert.ok(turned[i] >= turned[i - 1], 'the loop never turns back');
  const rotates = clip.ring.map((key) => key.v[RING.ROTATE]);
  assert.ok(rotates.every((r) => r >= 0 && r <= 360), 'rotate stays within one turn');
});

test('a continuation keeps the rotation and the slow spin', () => {
  const player = createPlayer(rig);
  const first = buildWorking(rig, shipmate, { spinMs: 9000 });
  player.play(first, 0);
  player.tick(first.total + 1);
  const rotate = player.state.ring[RING.ROTATE];
  const elapsedMs = first.total + 1;
  const next = buildWorking(rig, shipmate, { continueFrom: { rotate, elapsedMs } });
  assert.deepEqual(next.phases.map((p) => p.name), ['spin']);
  player.play(next, 20000);
  player.tick(20000);
  assert.equal(player.state.ring[RING.ROTATE], rotate, 'the first frame is where the loop stopped');
  player.tick(20300);
  const moved = (player.state.ring[RING.ROTATE] - rotate + 360) % 360;
  assert.ok(Math.abs(moved - (360 * 300) / 1800) < 1, 'slow spin, not the fast one: moved ' + moved);
});

test('the end finishes the turn before it closes', () => {
  const clip = buildWorkingEnd(rig, shipmate, { rotate: 90 });
  assert.deepEqual(clip.phases.map((p) => p.name), ['finish', 'close', 'fill', 'regrow']);
  const [finish, close, fill, regrow] = clip.phases.map((p) => p.end);
  assert.ok(finish <= 320, 'the turn finishes in at most 320 ms');
  const finished = sample(clip.ring, finish);
  assert.equal(finished[RING.ROTATE], 360, 'the whole turn is done');
  assert.ok(finished[RING.DASH_OFF] > 0, 'the gap is still open');
  assert.equal(sample(clip.ring, close)[RING.DASH_OFF], 0, 'the gap is closed');
  assert.equal(sample(clip.ring, fill)[RING.WIDTH], 38, 'the loop has filled to a disc');
  assert.deepEqual(clip.body.at(-1).v, rig.poses.circle);
  assert.equal(sample(clip.ring, regrow + 1)[RING.OPACITY], 0, 'the ring is gone at the end');
  assert.ok(buildWorkingEnd(rig, shipmate, { rotate: 359 }).phases[0].end >= 60, 'a short finish is still a visible beat');
  const still = buildWorkingEnd(rig, shipmate, { rotate: 0 });
  assert.equal(sample(still.ring, still.phases[0].end)[RING.ROTATE], 0, 'a loop with no turn left holds still, it does not spin a whole turn');
});

test('reduced motion opens the loop and holds it still', () => {
  const clip = buildWorking(rig, { ...shipmate, reducedMotion: true }, { spinMs: 5000 });
  const opened = sample(clip.ring, clip.phases[1].end);
  assert.ok(opened[RING.DASH_OFF] > 0, 'the loop is open');
  for (const time of every(clip.phases[1].end, clip.total, 250)) {
    assert.deepEqual(sample(clip.ring, time), opened, 'the ring changed at ' + time);
  }
});
