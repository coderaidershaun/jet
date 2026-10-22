import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer } from '../player.js';
import { buildWorking, buildWorkingEnd } from './working.js';

const HOVERING = { standing: false, eyeKind: 'round', reducedMotion: false };
const STEP_MS = 10;

// Plays a clip from the given state values and gives what the state was every STEP_MS, from `from` to `to`.
function trace(clip, { from = 0, to = clip.total, state = {} } = {}) {
  const player = createPlayer({ random: () => 1, layers: false });
  Object.assign(player.state, state);
  player.play(clip, from);
  const rows = [];
  for (let now = from; now <= to; now += STEP_MS) {
    player.tick(now);
    rows.push({ t: now - from, roll: player.state.roll, form: player.state.form, lids: [...player.state.lids] });
  }
  return { player, rows };
}

// Degrees turned between the first row and each later row, counting every whole turn.
function turnedBy(rows) {
  let total = 0;
  return rows.map((row, i) => {
    if (i > 0) total += (row.roll - rows[i - 1].roll + 360) % 360;
    return total;
  });
}

test('the eyes shut before the morph and the spin starts 240 ms into it', () => {
  const clip = buildWorking(HOVERING, { spinMs: 5000 });
  assert.deepEqual(clip.phases.map((phase) => phase.name), ['shut', 'morph', 'spin']);
  assert.deepEqual(clip.phases.map((phase) => phase.end), [120, 480, 360 + 5000]);
  assert.equal(clip.revealFrom, null);

  const { rows, player } = trace(clip, { to: 1000 });
  for (const row of rows) {
    if (row.form > 0) assert.deepEqual(row.lids, [1, 1], `the lids are shut by ${row.t} ms, when the form is ${row.form}`);
  }
  const [tip] = player.frame.string;
  assert.ok(player.frame.string.every(([x, y]) => Math.hypot(x - tip[0], y - tip[1]) < 1e-6), 'the string is reeled into the bow while the body is the spinner');
  const at = (t) => rows.find((row) => row.t === t);
  assert.equal(at(120).form, 0);
  assert.equal(at(480).form, 1);
  assert.ok(at(300).form > 0 && at(300).form < 1);
  assert.equal(at(360).roll, 0, 'the spin has not started 240 ms into the morph');
  assert.ok(at(380).roll > 0, 'and has started just after');
  assert.ok(at(1000).roll > at(900).roll);
});

test('the spinner turns clockwise at 1.1 s a turn, then 1.8 s after eight seconds, and a continuation keeps the angle and the slow spin', () => {
  const clip = buildWorking(HOVERING, { spinMs: 20000 });
  const { rows } = trace(clip, { to: 20000 + 360 });
  const turned = turnedBy(rows);
  assert.ok(turned.every((degrees, i) => i === 0 || degrees >= turned[i - 1]), 'it never turns back');
  assert.ok(rows.every((row) => row.roll >= 0 && row.roll <= 360), 'the roll stays within one turn');

  // Each whole turn ends with a 360 then a 0 at one time; those times are where the turns end.
  const turnEnds = clip.roll.filter((key, i) => key.v === 0 && clip.roll[i - 1]?.v === 360 && clip.roll[i - 1].t === key.t).map((key) => key.t);
  const lengths = turnEnds.map((end, i) => Math.round(end - (turnEnds[i - 1] ?? 360)));
  assert.equal(lengths[0], 1650, 'the first turn is 1.5 times a fast one');
  assert.deepEqual(lengths.slice(1, 7), Array(6).fill(1100), 'fast turns of 1.1 s');
  const slowing = lengths.findIndex((length) => length !== 1100 && length !== 1650);
  assert.ok(lengths[slowing] > 1100 && lengths[slowing] < 1800, 'one turn that slows from the fast speed to the slow one');
  assert.deepEqual(lengths.slice(slowing + 1), Array(lengths.length - slowing - 1).fill(1800), 'then slow turns of 1.8 s');
  const slowStartsAt = turnEnds[slowing - 1];
  assert.ok(slowStartsAt >= 8000 && slowStartsAt < 8000 + 1100, `the slowing turn starts after eight seconds: ${slowStartsAt}`);

  const first = buildWorking(HOVERING, { spinMs: 9000 });
  const { player } = trace(first, { to: first.total + 1 });
  assert.equal(player.playing, false);
  const stoppedAt = player.state.roll;
  assert.ok(stoppedAt > 0 && stoppedAt < 360);
  const next = buildWorking(HOVERING, { continueFrom: { roll: stoppedAt, elapsedMs: first.total }, spinMs: 3000 });
  assert.deepEqual(next.phases, [{ name: 'spin', end: 3000 }]);
  assert.ok(['y', 'form', 'lids', 'squash', 'lift'].every((name) => next[name].length === 0), 'a continuation writes only the spin');
  player.play(next, 20000);
  player.tick(20000);
  assert.equal(player.state.roll, stoppedAt, 'the first frame is where the spinner stopped');
  player.tick(20300);
  assert.ok(Math.abs(player.state.roll - stoppedAt - (360 * 300) / 1800) < 1, 'a slow spin, 60 degrees in 300 ms');

  const atTurnEnd = buildWorking(HOVERING, { continueFrom: { roll: 360, elapsedMs: 20000 }, spinMs: 3000 });
  const { rows: resumed } = trace(atTurnEnd, { to: 300, state: { roll: 360 } });
  assert.ok(Math.abs(resumed.at(-1).roll - (360 * 300) / 1800) < 1, `a spinner caught at 360 turns again at once: ${resumed.at(-1).roll}`);
});

test('workingEnd finishes the turn within 200 to 700 ms, unwinds less than a turn, and opens the lids only after the form is 0', () => {
  for (const [roll, elapsedMs] of [[0, 0], [90, 3000], [359, 3000], [200, 9000], [360, 3000]]) {
    const clip = buildWorkingEnd(HOVERING, { roll, elapsedMs });
    const [finish, unmorph, open] = clip.phases.map((phase) => phase.end);
    assert.deepEqual(clip.phases.map((phase) => phase.name), ['finish', 'unmorph', 'open']);
    assert.ok(finish >= 200 && finish <= 700, `the turn finishes in ${finish} ms from ${roll} degrees`);
    assert.equal(unmorph, finish + 360);
    assert.equal(open, finish + 660);
    assert.equal(clip.total, open);
    assert.equal(clip.revealFrom, null);

    const { rows, player } = trace(clip, { to: clip.total + 20, state: { roll, form: 1, lids: [1, 1] } });
    const turned = turnedBy(rows);
    assert.ok(turned.at(-1) < 360, `${turned.at(-1)} degrees from ${roll}: less than a turn`);
    assert.ok(rows.every((row, i) => i === 0 || row.roll >= rows[i - 1].roll || row.roll === 0), 'the roll never runs backwards');
    for (const row of rows) {
      if (row.lids[0] < 0.99) assert.equal(row.form, 0, `the lids start to open at ${row.t} ms while the form is ${row.form}`);
    }
    assert.equal(rows.find((row) => row.t === finish).roll, roll === 0 ? 0 : 360, 'the turn is whole when the melt begins');
    assert.deepEqual([player.state.roll, player.state.form, player.state.lids], [0, 0, [0, 0]], 'upright, a kite, eyes open');
  }
  // A spinner caught exactly at the end of a turn reads 360: the turn is whole, so it only holds for the beat.
  assert.equal(buildWorkingEnd(HOVERING, { roll: 360, elapsedMs: 3000 }).phases[0].end, 200, 'a whole turn is only the beat');
  assert.equal(buildWorkingEnd(HOVERING, { roll: 359, elapsedMs: 0 }).phases[0].end, 200, 'a short turn is still a beat');
  assert.equal(buildWorkingEnd(HOVERING, { roll: 1, elapsedMs: 9000 }).phases[0].end, 700, 'a long slow turn is cut to 700');
});

test('reduced motion morphs the form and holds the roll', () => {
  const reduced = { standing: true, eyeKind: 'round', reducedMotion: true };
  const clip = buildWorking(reduced, { spinMs: 5000 });
  assert.equal(clip.roll.length, 0);
  assert.equal(clip.total, 5360);
  const { rows } = trace(clip, { to: 3000 });
  assert.equal(rows.find((row) => row.t === 480).form, 1);
  assert.ok(rows.every((row) => row.roll === 0));
  const continued = buildWorking(reduced, { spinMs: 5000, continueFrom: { roll: 0, elapsedMs: 4000 } });
  assert.equal(continued.roll.length, 0);
  assert.deepEqual(continued.phases, [{ name: 'spin', end: 5000 }]);
});
