import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lerp } from '../maths.js';
import { sample } from '../track.js';
import { buildAnnoyed } from './annoyed.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../../rig/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };

const nearly = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const narrowed = (key) => key.v[4] > 0 && key.v[5] / key.v[4] < 0.5;

test('the centre and deferential never glare, tint or narrow the eyes', () => {
  const ks = shipmate.shape / 10;
  const standing = lerp(rig.poses.circle, rig.poses.land, ks);
  for (const candid of [0, -0.3, -1]) {
    const clip = buildAnnoyed(rig, { ...shipmate, candid });
    const atGlare = sample(clip.body, clip.phases[1].end);
    assert.ok(nearly(atGlare, standing), 'the body glared at candid ' + candid);
    assert.ok(clip.colour.every((key) => nearly(key.v, rig.palette.rest)), 'the body was tinted at candid ' + candid);
    assert.ok(!clip.eyes.some(narrowed), 'the eyes narrowed at candid ' + candid);
  }

  const candid = buildAnnoyed(rig, { ...shipmate, candid: 0.8 });
  assert.ok(!nearly(sample(candid.body, candid.phases[1].end), standing), 'a candid Jet glares');
  assert.ok(candid.colour.some((key) => !nearly(key.v, rig.palette.rest)), 'a candid Jet flushes');
  assert.ok(candid.eyes.some(narrowed), 'a candid Jet narrows its eyes');
});
