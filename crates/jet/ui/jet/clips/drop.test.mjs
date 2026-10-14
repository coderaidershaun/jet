import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eyeSizeFor } from '../clip.js';
import { STRIDE } from '../rig.js';
import { PROP, RING } from '../state.js';
import { sample } from '../track.js';
import { buildDrop } from './drop.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../../rig/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };

// The umbrella is placed by the tip of its handle, and its canopy starts 36 units above that tip.
const CANOPY_RIM = 36;
const headTop = (body) => Math.min(...body.filter((_, i) => i % STRIDE === 1)) - rig.stroke / 2;
const timesBetween = (from, to) => Array.from({ length: Math.floor((to - from) / 10) + 1 }, (_, i) => from + i * 10);

test('the umbrella opens 40% into the cruise above the head and folds in the brake', () => {
  const clip = buildDrop(rig, shipmate, { cruiseMs: 1400 });
  const { openAt, tempo } = clip.info;
  const [launch, cruise] = clip.phases;
  const umbrella = (at) => sample(clip.prop, at).slice(0, PROP.OPACITY + 1);

  assert.equal(clip.props[0], 'umbrella');
  assert.ok(Math.abs(openAt - (launch.end + 0.4 * (cruise.end - launch.end))) < 1e-6, 'it opens 40% into the cruise');
  assert.equal(umbrella(openAt - 1)[PROP.OPACITY], 0, 'it is hidden until it opens');
  assert.equal(umbrella(openAt + 150)[PROP.OPACITY], 1, 'it is open soon after');
  const scales = timesBetween(openAt, cruise.end).map((at) => umbrella(at)[PROP.SCALE]);
  assert.ok(Math.max(...scales) > 1.1, 'it pops open past its size');
  assert.ok(Math.abs(umbrella(cruise.end)[PROP.SCALE] - 1) < 1e-9, 'it settles to its size');

  for (const at of timesBetween(openAt + 90 * tempo, cruise.end)) {
    const [, y, , scale] = umbrella(at);
    const head = headTop(sample(clip.body, at));
    assert.ok(y - CANOPY_RIM * scale < head, 'at ' + at + ' ms the canopy rim at ' + (y - CANOPY_RIM * scale) + ' is not above the head at ' + head);
  }

  const [, , , foldedScale, foldedOpacity] = umbrella(clip.total);
  assert.ok(foldedScale <= 0.2, 'it is folded by the end');
  assert.equal(foldedOpacity, 0, 'it is gone by the end');

  assert.ok(clip.speed.length > 0 && clip.speed.every((key) => key.v === 0), 'the ground never moves');
  assert.ok(clip.ring.length > 0 && clip.ring.every((key) => key.v[RING.OPACITY] === 0), 'no grooves show');

  const wide = buildDrop(rig, { ...shipmate, eyes: 7 }, { cruiseMs: 1400 });
  const [wideLaunch, wideCruise] = wide.phases;
  const wideSize = 4.6 * eyeSizeFor(7);
  const faceInCruise = wide.eyes.filter((key) => key.t >= wideLaunch.end && key.t <= wideCruise.end && key.v[6] === 0 && key.v[4] >= wideSize - 1e-9);
  assert.ok(faceInCruise.length > 0, 'above eyes 6 Jet falls wide-eyed');
  const atLaunchEnd = wide.eyes.find((key) => key.t === wideLaunch.end);
  assert.deepEqual(sample(wide.eyes, wide.info.openAt), atLaunchEnd.v, 'the face holds still while Jet falls');
  const noFace = buildDrop(rig, { ...shipmate, eyes: 6 }, { cruiseMs: 1400 });
  assert.ok(noFace.eyes.every((key) => key.v[4] === 0 && key.v[5] === 0), 'at eyes 6 there is no face');
});
