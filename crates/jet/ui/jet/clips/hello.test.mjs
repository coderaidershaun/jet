import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paint } from '../draw/paint.js';
import { createPlayer } from '../player.js';
import { restState } from '../state.js';
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

// Plays a clip to its end on a fixed clock from the rest state and gives the player and the eyes it showed.
function playToEnd(clip, { standing = false, eyeKind = 'round' } = {}) {
  const player = createPlayer({ random: () => 1, layers: false, standing });
  player.state.eyeKind = eyeKind;
  player.play(clip, 0);
  const shown = new Map();
  for (let now = 0; now <= clip.total + FRAME_MS; now += FRAME_MS) {
    player.tick(now);
    shown.set(now, { kind: player.frame.eyes.kind, lids: player.frame.eyes.lids });
  }
  return { player, shown };
}

test('brief ends at 1650 with no wink, revealFrom is wag, tracks and phases run forward, and the kite ends as it started', () => {
  const full = buildHello(HOVERING);
  const brief = buildHello(HOVERING, { brief: true });
  assert.deepEqual(full.phases, [{ name: 'dip', end: 180 }, { name: 'lift', end: 650 }, { name: 'wag', end: 1900 }, { name: 'drop', end: 2300 }, { name: 'rest', end: 2550 }]);
  assert.deepEqual(brief.phases.map((phase) => phase.end), [180, 650, 1150, 1450, 1650]);
  assert.equal(brief.total, 1650);
  assert.equal(full.revealFrom, 'wag');
  assert.equal(brief.revealFrom, 'wag');
  assert.ok(full.lids.some((key) => key.v[1] === 1), 'the full hello winks');
  assert.ok(brief.lids.every((key) => key.v[1] === 0), 'the brief hello does not');

  for (const clip of [full, brief, buildHello({ ...HOVERING, eyeKind: 'round', standing: true })]) {
    const ends = clip.phases.map((phase) => phase.end);
    assert.deepEqual(ends, [...ends].sort((a, b) => a - b), 'the phases run forward');
    for (const name of ['lift', 'lids', 'y', 'squash', 'form']) {
      const times = clip[name].map((key) => key.t);
      assert.deepEqual(times, [...times].sort((a, b) => a - b), `the ${name} track runs forward`);
      assert.ok(times.every((t) => t >= 0 && t <= clip.total), `the ${name} track stays inside the clip`);
    }
  }

  for (const standing of [false, true]) {
    for (const brief of [false, true]) {
      const { player } = playToEnd(buildHello({ standing, eyeKind: 'round', reducedMotion: false }, { brief }), { standing });
      assert.deepEqual(player.state, { ...restState({ standing }), eyeKind: 'lid' }, `back at rest, standing ${standing}, brief ${brief}; only the eyes stay lid`);
    }
  }

  const blinking = playToEnd(buildHello({ ...HOVERING, eyeKind: 'round' }));
  assert.equal(blinking.shown.get(40).kind, 'round');
  assert.deepEqual(blinking.shown.get(80), { kind: 'lid', lids: [1, 1] }, 'the opening blink swaps the eyes under its shut lids');
  const lidEyes = playToEnd(buildHello(HOVERING), { eyeKind: 'lid' });
  assert.deepEqual(lidEyes.shown.get(80), { kind: 'lid', lids: [0, 0] }, 'eyes that are already lid eyes do not blink');
});
