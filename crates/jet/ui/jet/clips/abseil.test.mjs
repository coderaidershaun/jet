import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STRIDE } from '../rig.js';
import { PROP, RING } from '../state.js';
import { sample } from '../track.js';
import { buildAbseil } from './abseil.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../../rig/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };

const width = (body) => {
  const xs = body.filter((_, i) => i % STRIDE === 0);
  return Math.max(...xs) - Math.min(...xs);
};
const timesBetween = (from, to) => Array.from({ length: Math.floor((to - from) / 10) + 1 }, (_, i) => from + i * 10);

test('the rope comes down in the launch, Jet kicks three times, and the rope whips away on landing', () => {
  const clip = buildAbseil(rig, shipmate, { cruiseMs: 1400 });
  const [launch, cruise] = clip.phases;
  const rope = (at) => sample(clip.prop, at);

  assert.equal(clip.props[0], 'rope');
  assert.equal(rope(0)[PROP.OPACITY], 0, 'the rope is hidden at the start');
  assert.equal(rope(launch.end)[PROP.OPACITY], 1, 'the rope is down by the end of the launch');
  const cruiseTimes = timesBetween(launch.end, cruise.end);
  assert.ok(cruiseTimes.every((at) => rope(at)[PROP.OPACITY] === 1), 'Jet holds the rope all the way down');

  const hanging = width(clip.body.find((key) => key.t === launch.end).v);
  const kicking = cruiseTimes.map((at) => width(sample(clip.body, at)) > hanging + 2);
  const kicks = kicking.filter((inKick, i) => inKick && !kicking[i - 1]).length;
  assert.equal(kicks, 3, 'Jet kicks off three times on the way down');

  const brakeTimes = timesBetween(cruise.end, clip.total);
  assert.ok(Math.min(...brakeTimes.map((at) => rope(at)[PROP.Y])) <= -40, 'the rope whips up');
  assert.equal(rope(clip.total)[PROP.OPACITY], 0, 'the rope is gone by the end');

  assert.ok(clip.speed.length > 0 && clip.speed.every((key) => key.v === 0), 'the ground never moves');
  assert.ok(clip.ring.length > 0 && clip.ring.every((key) => key.v[RING.OPACITY] === 0), 'no grooves show');
});
