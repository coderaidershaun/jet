import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paint } from '../draw/paint.js';
import { createPlayer } from '../player.js';
import { buildHello } from './hello.js';

const wave = JSON.parse(readFileSync(new URL('../fixtures/wave.json', import.meta.url), 'utf8'));

const FRAME_MS = 40;
const HOVERING = { standing: false, eyeKind: 'lid', reducedMotion: false };

const everyNode = (node) => [node, ...(node.children ?? []).flatMap(everyNode)];
const only = (tree, name) => {
  const found = everyNode(tree).filter((node) => node.attrs.class === name);
  assert.equal(found.length, 1, `exactly one .${name}`);
  return found[0];
};
const rollOf = (tree) => Number(/rotate\((-?[\d.]+)\)/.exec(only(tree, 'jet-body').attrs.transform)[1]);
const foldOf = (tree) => Number(only(only(tree, 'jet-hand-right'), 'jet-fold').attrs.opacity);
const winkOf = (tree) => Number(/scale\(1 ([\d.]+)\)/.exec(only(only(tree, 'jet-eye-right'), 'jet-eye-shape').attrs.transform)[1]);
const squintOf = (tree) => Number(/scale\(1 ([\d.]+)\)/.exec(only(only(tree, 'jet-eye-left'), 'jet-eye-shape').attrs.transform)[1]);
// The drawing's left eye squints 18% of the wink. The fixture keeps the right eye only, so the left is read off it.
const squintFor = (winkScale) => 1 - Math.max(0, 0.18 * (1 - winkScale));
// A shut eye is drawn no flatter than 0.04, so at that floor the wink's real closure, and the squint it causes, cannot be read.
const LID_FLOOR = 0.04;

test('the played wave matches jet-wave.svg frame for frame', () => {
  const player = createPlayer({ random: () => 1, layers: false });
  player.state.eyeKind = 'lid';
  player.play(buildHello(HOVERING), 0);

  assert.equal(wave.frames.length, 75);
  for (const [index, roll, handOpacity, winkScale] of wave.frames) {
    player.tick(index * FRAME_MS);
    const tree = paint(player.frame, { unitPx: 1 });
    assert.ok(Math.abs(rollOf(tree) - roll) <= 0.05, `frame ${index}: roll ${rollOf(tree)} against ${roll}`);
    assert.ok(Math.abs(player.frame.roll - roll) <= 0.05, `frame ${index}: frame roll ${player.frame.roll} against ${roll}`);
    assert.ok(Math.abs(foldOf(tree) - handOpacity) <= 0.02, `frame ${index}: hand ${foldOf(tree)} against ${handOpacity}`);
    assert.ok(Math.abs(winkOf(tree) - winkScale) <= 0.02, `frame ${index}: wink ${winkOf(tree)} against ${winkScale}`);
    if (winkScale > LID_FLOOR) assert.ok(Math.abs(squintOf(tree) - squintFor(winkScale)) <= 0.02, `frame ${index}: left squint ${squintOf(tree)} against ${squintFor(winkScale)}`);
  }
});
