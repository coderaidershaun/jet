import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer } from '../player.js';
import { FLOOR } from '../parts/string.js';
import { buildSettle } from './settle.js';

const HOVERING = { standing: false, eyeKind: 'lid', reducedMotion: false };
const FRAME_MS = 16;

test('settle lands at 1080: round eyes at contact, the squash at y 0, standing with the string lying', () => {
  const clip = buildSettle(HOVERING);
  assert.deepEqual(clip.phases, [{ name: 'rise', end: 160 }, { name: 'descend', end: 680 }, { name: 'land', end: 1080 }]);
  assert.equal(clip.total, 1080);

  const player = createPlayer({ random: () => 1, layers: false });
  player.state.eyeKind = 'lid';
  player.state.anger = 0.6;
  player.play(clip, 0);
  const seen = new Map();
  for (let now = 0; now <= 4000; now += FRAME_MS) {
    player.tick(now);
    seen.set(now, { y: player.frame.y, kind: player.frame.eyes.kind, anger: player.frame.eyes.anger, squash: player.state.squash, lids: player.frame.eyes.lids, string: player.frame.string, tipBlend: player.state.stringPose?.blend[0] });
  }
  assert.ok(seen.get(160).y > 61.7, 'it rises a touch above the hover first');
  assert.equal(seen.get(640).kind, 'lid', 'the eyes keep their kind while open');
  assert.ok(seen.get(640).y > 0, 'still in the air');
  assert.equal(seen.get(688).kind, 'round', 'the kind changes under the shut lids at contact');
  assert.equal(seen.get(688).anger, 0);
  assert.ok(seen.get(688).lids.every((lid) => lid > 0.8), 'the lids are shut at contact');
  assert.equal(seen.get(688).y, 0);
  assert.ok(seen.get(768).squash[0] > 1.05 && seen.get(768).squash[1] < 0.95, 'squashed on the floor just after contact');
  assert.ok(seen.get(1088).lids.every((lid) => lid <= 0.01), 'the lids are open again');

  assert.ok(player.standing);
  assert.deepEqual(player.state.squash, [1, 1]);
  const lying = seen.get(4000).string;
  assert.ok(Math.max(...lying.map(([, y]) => y)) <= FLOOR);
  assert.ok(lying.at(-1)[1] > 236 && lying.at(-1)[0] < 70, 'the string lies out to the left on the floor');
  assert.ok(seen.get(320).string.at(-1)[0] > 100, 'the string still hangs when its end first reaches the floor');
  assert.ok(seen.get(640).string.at(-1)[0] < 70, 'and lies out to the left by the time the body lands');
  assert.ok(seen.get(1088).tipBlend > 1.001, 'the segment at the tip is still swinging past when the clip ends');
  assert.equal(seen.get(1216).tipBlend, 1, 'and comes to rest after it: the lay keeps running once the clip is over');
});
