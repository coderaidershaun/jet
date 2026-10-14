import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROP, PROP_STRIDE } from '../state.js';
import { sample } from '../track.js';
import { buildBatBall, buildDoze } from './antics.js';

const rig = JSON.parse(readFileSync(fileURLToPath(new URL('../../../rig/jet.json', import.meta.url)), 'utf8'));

const shipmate = { candid: 0.55, playful: 0.35, shape: 6, eyes: 4, colour: 6, motion: 6, reducedMotion: false };
const BOUNCE_MS = 520;

// The bat and the ball as they are drawn, in rig units before their scale.
const BAT_LENGTH = 30;
const batHalfWidth = (along) => 1.4 + (1.6 * along) / BAT_LENGTH;
const BALL_RADIUS = 4;

const slot = (prop, i) => prop.slice(i * PROP_STRIDE, (i + 1) * PROP_STRIDE);

/** How far along the bat the ball's centre is, in bat units from the grip, and how far above the bat's centre line. */
function ballOnBat(prop) {
  const [batX, batY, rotate, batScale] = slot(prop, 0);
  const [ballX, ballY] = slot(prop, 1);
  const r = (rotate * Math.PI) / 180;
  const dx = ballX - batX;
  const dy = ballY - batY;
  return { along: (dx * Math.sin(r) - dy * Math.cos(r)) / batScale, above: -dx * Math.cos(r) - dy * Math.sin(r) };
}

test('the ball lands on the bat every 520 ms, the body squashes after each landing, and a continued loop starts where the last ended', () => {
  const clip = buildBatBall(rig, shipmate, { loopMs: 4 * BOUNCE_MS });
  const pickedUp = clip.phases[0].end;
  const landings = [0, 1, 2, 3, 4].map((k) => pickedUp + k * BOUNCE_MS);
  assert.equal(landings.at(-1), clip.total, 'the loop ends on a landing');

  for (const at of landings) {
    const prop = sample(clip.prop, at);
    const { along, above } = ballOnBat(prop);
    const touching = batHalfWidth(along) * slot(prop, 0)[PROP.SCALE] + BALL_RADIUS * slot(prop, 1)[PROP.SCALE];
    assert.ok(along >= 18 && along <= BAT_LENGTH, 'at ' + at + ' ms the ball lands ' + along + ' bat units from the grip, off the barrel');
    assert.ok(Math.abs(above - touching) < 0.3, 'at ' + at + ' ms the ball is ' + (above - touching) + ' off the bat');
    const body = sample(clip.body, at);
    assert.deepEqual([prop[PROP.X], prop[PROP.Y]], [body[12], body[13]], 'at ' + at + ' ms the bat is in the right hand');
  }
  const ballY = (at) => sample(clip.prop, at)[PROP_STRIDE + PROP.Y];
  for (const at of landings.slice(0, -1)) {
    assert.ok(ballY(at) - ballY(at + 260) >= 15, 'the ball flies up after the landing at ' + at + ' ms');
    const landed = sample(clip.body, at);
    const squashed = sample(clip.body, at + 70);
    assert.ok(squashed[1] > landed[1], 'the head drops after the landing at ' + at + ' ms');
    assert.ok(squashed[12] > landed[12], 'the hand gives way after the landing at ' + at + ' ms');
  }

  const full = buildBatBall(rig, shipmate, { loopMs: 2 * BOUNCE_MS });
  const continued = buildBatBall(rig, shipmate, { loopMs: 2 * BOUNCE_MS, continued: true });
  const bounceKeys = (track, from) => track.filter((key) => key.t > from).map((key) => [key.t - from, key.v]);
  for (const name of ['body', 'eyes', 'prop']) {
    assert.deepEqual(bounceKeys(continued[name], 0), bounceKeys(full[name], full.phases[0].end), 'the continued ' + name + ' track bounces on from the landing');
  }
});

test('a deferential Jet swings the bat less', () => {
  const swingOf = (dials) => {
    const rotates = buildBatBall(rig, dials, { loopMs: 2 * BOUNCE_MS }).prop.map((key) => key.v[PROP.ROTATE]);
    return Math.max(...rotates) - Math.min(...rotates);
  };
  assert.ok(swingOf({ ...shipmate, candid: -1 }) < swingOf(shipmate));
});

test('doze closes faint eyes to slits and sways 3%, and holds still under reduced motion', () => {
  const clip = buildDoze(rig, shipmate, { loopMs: 5600 });
  const [, , , , rx, ry, tint] = clip.eyes.at(-1).v;
  assert.equal(tint, 1, 'the eyes stay faint');
  assert.ok(rx > 0 && ry < 0.3 * rx, 'the eyes close to slits');
  const scales = clip.scale.map((key) => key.v);
  assert.ok(Math.abs(Math.max(...scales) - 1.03) < 1e-9, 'the sway reaches 3%');
  assert.equal(Math.min(...scales), 1, 'the sway comes back to full size');
  assert.equal(clip.props, undefined, 'the doze holds no prop');
  assert.equal(clip.prop.length, 0, 'the doze moves no prop');

  const still = buildDoze(rig, { ...shipmate, reducedMotion: true }, { loopMs: 5600 });
  assert.ok(still.scale.every((key) => key.v === 1), 'reduced motion does not sway');
  assert.deepEqual(still.body.at(-1).v, rig.poses.circle, 'reduced motion stays at the circle');
});
