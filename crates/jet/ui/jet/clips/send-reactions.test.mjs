import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPlayer } from '../player.js';
import { EYE_BLINK, EYE_OPEN } from './beats.js';
import { buildBlink, buildHop, buildNod, buildSalute } from './send-reactions.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../../rig/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };
const BUILDERS = { salute: buildSalute, nod: buildNod, blink: buildBlink, hop: buildHop };
const BUDGET_MS = { salute: 350, nod: 350, blink: 300, hop: 350 };
const EYE = { LEFT_Y: 1, RADIUS_X: 4, RADIUS_Y: 5, TINT: 6 };

test('every send reaction is over within 350 ms and has a beat in each named phase', () => {
  const dials = {
    shipmate,
    'playful and candid': { ...shipmate, candid: 1, playful: 1 },
    'serious and deferential': { ...shipmate, candid: -1, playful: -1 },
    'motion 0': { ...shipmate, motion: 0 },
  };
  for (const [name, build] of Object.entries(BUILDERS)) {
    for (const [dialName, dial] of Object.entries(dials)) {
      const title = name + ' at ' + dialName;
      const clip = build(rig, dial);
      assert.ok(clip.total <= BUDGET_MS[name], title + ' lasts ' + clip.total + ' ms');
      let previousEnd = 0;
      for (const { name: phase, end } of clip.phases) {
        assert.ok(phase, title + ': a phase has no name');
        assert.ok(clip.body.some(({ t }) => t > previousEnd && t <= end), title + ': the ' + phase + ' phase has no body key');
        previousEnd = end;
      }
      assert.equal(previousEnd, clip.total, title + ': the last phase does not end with the clip');
    }
  }
});

test('the salute reaches higher when candid and bows on the way down when deferential', () => {
  const candid = buildSalute(rig, { ...shipmate, candid: 0.8 }).info;
  const neutral = buildSalute(rig, { ...shipmate, candid: 0 }).info;
  const deferential = buildSalute(rig, { ...shipmate, candid: -0.8 }).info;
  assert.ok(candid.reach > 1 && deferential.reach < 1, 'candid lifts the arm past the drawn pose, deferential keeps it lower');
  assert.equal(neutral.bow, 0);
  assert.ok(deferential.bow > 0, 'a deferential Jet bows as the hand comes down');
});

test('the blink opens a face in ink and blinks it twice', () => {
  const faceKeys = (clip) => clip.eyes.filter(({ v }) => v[EYE.TINT] === 0);
  const blink = buildBlink(rig, shipmate);
  const { eyeSize } = blink.info;
  const shut = (key) => Math.abs(key.v[EYE.RADIUS_Y] - EYE_BLINK * eyeSize) < 1e-9;
  const open = (key) => Math.abs(key.v[EYE.RADIUS_Y] - EYE_OPEN * eyeSize) < 1e-9;
  const face = faceKeys(blink);
  const shutAt = face.flatMap((key, i) => (shut(key) ? [i] : []));
  assert.equal(shutAt.length, 2, 'two blinks of a face in ink');
  assert.ok(face.slice(shutAt[0] + 1, shutAt[1]).some(open), 'the eyes open between the blinks');
  assert.ok(!faceKeys(buildBlink(rig, { ...shipmate, reducedMotion: true })).some(shut), 'reduced motion holds the eyes open');
});

test('the nod and the hop keep faint eyes that ride the body', () => {
  const player = createPlayer(rig, { random: () => 0 });
  player.eyes = shipmate.eyes;
  // Well after the faint eyes have grown in, and before their first blink.
  player.tick(0);
  player.tick(1000);
  const restSize = player.state.eyes[EYE.RADIUS_X];
  for (const [name, build] of [['nod', buildNod], ['hop', buildHop]]) {
    const clip = build(rig, shipmate);
    assert.ok(clip.eyes.every(({ v }) => v[EYE.TINT] === 1), name + ' never shows a face');
    assert.ok(clip.eyes.some(({ v }) => Math.abs(v[EYE.RADIUS_X] - restSize) < 1e-9), name + ' keeps the faint eyes at their size at rest');
  }
  const nod = buildNod(rig, shipmate);
  const dipEnd = nod.phases[0].end;
  const dipEyes = nod.eyes.find(({ t }) => t === dipEnd).v;
  assert.ok(dipEyes[EYE.LEFT_Y] > rig.eyes.circle[EYE.LEFT_Y], 'the eyes go down with the nod');
});
