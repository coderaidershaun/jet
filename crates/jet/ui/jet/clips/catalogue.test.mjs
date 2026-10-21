import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPlayer } from '../player.js';
import { RING, TRACKS } from '../state.js';
import { CLIPS } from './catalogue.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../../rig/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };
const DIALS = {
  shipmate,
  'playful and candid': { ...shipmate, candid: 1, playful: 1 },
  'serious and deferential': { ...shipmate, candid: -1, playful: -1 },
  'reduced motion': { ...shipmate, reducedMotion: true },
  'motion 0': { ...shipmate, motion: 0 },
};

// The ways a clip can be asked for, besides its dials.
const OPTIONS = {
  hello: [{}, { brief: true }],
  zoom: [{}, { cruiseMs: 800 }],
  working: [{ spinMs: 5000 }, { spinMs: 5000, continueFrom: { rotate: 200, elapsedMs: 9000 } }],
  workingEnd: [{ rotate: 0 }, { rotate: 200 }],
};

function everyClip(dials = DIALS) {
  const out = [];
  for (const [name, entry] of Object.entries(CLIPS)) {
    for (const options of OPTIONS[name] ?? [{}]) {
      for (const [dialName, dial] of Object.entries(dials)) {
        out.push({ name, entry, options, dialName, dial, title: name + ' ' + JSON.stringify(options) + ' at ' + dialName });
      }
    }
  }
  return out;
}

const nearly = (a, b, eps = 1e-9) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);

test("every clip's tracks run forward in time", () => {
  for (const { entry, options, dial, title } of everyClip()) {
    const clip = entry.build(rig, dial, options);
    for (const name of TRACKS) {
      const times = clip[name].map((key) => key.t);
      for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], title + ': ' + name + ' goes backwards at key ' + i);
    }
    const ends = clip.phases.map((phase) => phase.end);
    for (let i = 1; i < ends.length; i++) assert.ok(ends[i] >= ends[i - 1], title + ': phases go backwards');
    assert.ok(clip.readout.length >= 3, title + ': the lab needs at least three rows to show');
  }
});

test('shape at zero never leaves the circle, in any clip', () => {
  const circleOutline = 32 + rig.stroke / 2;
  for (const { entry, options, dial, title } of everyClip(Object.fromEntries(Object.entries(DIALS).map(([k, v]) => [k, { ...v, shape: 0 }])))) {
    const clip = entry.build(rig, dial, options);
    for (const key of clip.body) assert.ok(nearly(key.v, rig.poses.circle), title + ': a body key left the circle');
    for (const { v } of clip.ring) {
      const visible = v[RING.OPACITY] > 0.005 && v[RING.RX] > 0.1 && v[RING.MIX] >= 0.5;
      if (!visible) continue;
      assert.ok(v[RING.RX] - v[RING.WIDTH] / 2 <= 1e-9, title + ': the ring has a hole');
      assert.equal(v[RING.DASH_OFF], 0, title + ': the ring has a gap');
      const reach = Math.hypot(v[RING.CX] - 50, v[RING.CY] - 56) + v[RING.RX] + v[RING.WIDTH] / 2;
      assert.ok(reach <= circleOutline + 1e-9, title + ': the ring sticks out of the circle by ' + (reach - circleOutline));
    }
  }
});

test('eyes at zero never show a face, in any clip', () => {
  for (const { entry, options, dial, title } of everyClip(Object.fromEntries(Object.entries(DIALS).map(([k, v]) => [k, { ...v, eyes: 0 }])))) {
    const clip = entry.build(rig, dial, options);
    for (const key of clip.eyes) assert.deepEqual(key.v.slice(4, 6), [0, 0], title + ': an eye key has a size');
  }
});

test('any clip interrupting any clip comes to rest with no ground speed or grooves', () => {
  const starts = everyClip({ shipmate });
  const groundCoverRing = (ring) => ring[RING.OPACITY] > 0.005 && ring[RING.RX] > 0.1 && ring[RING.MIX] < 0.5;
  for (const next of starts) {
    for (const before of [null, ...starts]) {
      const player = createPlayer(rig);
      let now = 0;
      if (before) {
        const first = before.entry.build(rig, shipmate, before.options);
        player.play(first, 0);
        now = first.total / 2;
        player.tick(now);
      }
      const clip = next.entry.build(rig, shipmate, next.options);
      player.play(clip, now);
      const title = next.title + (before ? ' interrupting ' + before.title : ' from rest');
      player.tick(now + clip.total + 1);
      const state = player.state;
      assert.ok(!player.playing, title + ': still playing after its total');
      assert.equal(state.speed, 0, title + ': the ground is still moving');
      assert.ok(!groundCoverRing(state.ring), title + ': a ground-coloured ring is left showing');
      if (next.entry.hold) continue;
      assert.ok(nearly(state.body, rig.poses.circle, 1e-6), title + ': does not end at the circle');
      assert.deepEqual(state.eyes.slice(4, 6), [0, 0], title + ': ends with eyes showing');
      assert.ok(nearly(state.colour, rig.palette.rest, 1e-6), title + ': ends tinted');
      assert.equal(state.scale, 1, title + ': ends at another scale');
      assert.ok(state.ring[RING.OPACITY] <= 0.005 || state.ring[RING.RX] <= 0.1, title + ': ends with the ring showing');
    }
  }
});
