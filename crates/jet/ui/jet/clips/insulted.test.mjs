import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlayer } from '../player.js';
import { paint } from '../draw/paint.js';
import { HOVER_Y } from '../parts/forms.js';
import { buildInsulted } from './insulted.js';

const flip = JSON.parse(readFileSync(new URL('../fixtures/flip.json', import.meta.url), 'utf8'));
const START = { standing: false, eyeKind: 'lid', reducedMotion: false };
const nodes = (tree) => [tree, ...(tree.children ?? []).flatMap(nodes)];
const corners = (path) => [...path.matchAll(/Q(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 0.05, `${label}: ${actual} against ${expected}`);

test('the played flip matches the reference roll, height, eyes and fully raised string', () => {
  const player = createPlayer({ random: () => 1, layers: false });
  player.state.eyeKind = 'lid';
  player.play(buildInsulted(START), 0);
  assert.equal(flip.frames.length, 24);
  for (const reference of flip.frames) {
    const ms = reference.frame * 40;
    player.tick(ms);
    const frame = player.frame;
    near(frame.roll, reference.roll, `frame ${reference.frame} roll`);
    near(HOVER_Y - frame.y, reference.dy, `frame ${reference.frame} dy`);
    const eyes = nodes(paint(frame, { unitPx: 1 })).filter((node) => node.attrs.class === 'jet-eye-shape');
    assert.equal(eyes.length, 2);
    eyes.forEach((eye, side) => {
      const actual = corners(eye.attrs.d);
      assert.equal(actual.length, reference.eyes[side].length, `frame ${reference.frame} eye ${side} corners`);
      actual.forEach((point, i) => point.forEach((value, axis) =>
        near(value, reference.eyes[side][i][axis], `frame ${reference.frame} eye ${side}/${i}/${axis}`)));
    });
    if (ms >= 2000 && ms <= 3740) {
      assert.equal(frame.string.length, reference.string.length);
      frame.string.forEach((point, i) => point.forEach((value, axis) => near(value, reference.string[i][axis], `frame ${reference.frame} string ${i}/${axis}`)));
    }
  }
});

test('the flip pays out, writes and unwinds, reveals at the raised finger and returns to rest', () => {
  const clip = buildInsulted(START);
  assert.equal(clip.total, 4800);
  assert.equal(clip.revealFrom, 'hold');
  assert.equal(clip.phases[clip.phases.findIndex((phase) => phase.name === clip.revealFrom) - 1].end, 2720);
  const player = createPlayer({ random: () => 1, layers: false });
  player.state.eyeKind = 'lid';
  player.play(clip, 0);
  player.tick(2400);
  const palm = player.state.written.length;
  assert.ok(player.state.payout > 1.59 && player.state.payout < 1.60);
  player.tick(2720);
  assert.ok(player.state.written.length > palm);
  assert.equal(player.state.written.length, player.state.written.route.totalLength);
  player.tick(3800);
  assert.ok(player.state.written.length < palm, 'the same route unwinds backwards');
  player.tick(4800);
  assert.equal(player.state.y, HOVER_Y);
  assert.equal(player.state.anger, 0);
  assert.equal(player.state.eyeKind, 'lid');
  assert.equal(player.state.payout, 1);
  assert.equal(player.state.written, null);
  assert.equal(player.state.stringPose, null);

  for (const reducedMotion of [false, true]) {
    const grounded = createPlayer({ random: () => 1, layers: false, standing: true, reducedMotion });
    grounded.play(buildInsulted({ standing: true, eyeKind: 'round', reducedMotion }), 0);
    for (let ms = 0; ms <= 4800; ms += 16) {
      grounded.tick(ms);
      if (reducedMotion) assert.equal(grounded.frame.y, 0, 'reduced motion stays grounded');
      if (!reducedMotion && ms >= 420) assert.ok(grounded.frame.y > 50, 'normal motion lifts before the flip');
      if (reducedMotion) assert.deepEqual(grounded.frame.eyes.lids, [0, 0], 'reduced motion never blinks');
    }
    grounded.tick(4800);
    assert.equal(grounded.state.y, reducedMotion ? 0 : HOVER_Y);
  }
});
