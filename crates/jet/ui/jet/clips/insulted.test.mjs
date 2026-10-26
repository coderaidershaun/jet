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
