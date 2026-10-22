import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer } from '../player.js';
import { HOVER_Y } from '../parts/forms.js';
import { TRACKS } from '../state.js';
import { CLIPS } from './catalogue.js';

// The ways each clip can be asked for.
const OPTIONS = {
  hello: [{}, { brief: true }],
  fly: [{ cruiseMs: 800 }],
  settle: [{}],
  working: [{ spinMs: 5000 }, { spinMs: 5000, continueFrom: { roll: 200, elapsedMs: 9000 } }],
  workingEnd: [{ roll: 0 }, { roll: 200, elapsedMs: 9000 }],
};

const FRAME_MS = 16;

const everyClip = Object.entries(CLIPS).flatMap(([name, entry]) =>
  OPTIONS[name].map((options) => ({ name, entry, options, title: `${name} ${JSON.stringify(options)}` })),
);

test("every clip's tracks and phases run forward from every start", () => {
  for (const { entry, options, title } of everyClip) {
    for (const standing of [true, false]) {
      const clip = entry.build({ standing, eyeKind: 'round', reducedMotion: false }, options);
      const where = `${title}, standing ${standing}`;
      for (const name of TRACKS) {
        const times = clip[name].map((key) => key.t);
        assert.ok(times.every((t) => t >= 0), `${where}: the ${name} track has a key before 0`);
        assert.ok(times.every((t, i) => i === 0 || t >= times[i - 1]), `${where}: the ${name} track goes backwards`);
      }
      const ends = clip.phases.map((phase) => phase.end);
      assert.ok(ends.every((end, i) => i === 0 || end >= ends[i - 1]), `${where}: the phases go backwards`);
      assert.equal(clip.total, ends.at(-1), `${where}: the clip ends with its last phase`);
    }
  }
});

test('any clip interrupting any clip ends at rest unless it is the hold', () => {
  for (const standing of [true, false]) {
    for (const next of everyClip) {
      for (const before of [null, ...everyClip]) {
        const player = createPlayer({ random: () => 1, layers: false, standing });
        let now = 0;
        if (before) {
          const first = before.entry.build({ standing, eyeKind: 'round', reducedMotion: false }, before.options);
          player.play(first, 0);
          now = first.total / 2;
          for (let tickAt = 0; tickAt <= now; tickAt += FRAME_MS) player.tick(tickAt);
        }
        const clip = next.entry.build({ standing: player.standing, eyeKind: player.state.eyeKind, reducedMotion: false }, next.options);
        player.play(clip, now);
        for (let tickAt = now; tickAt <= now + clip.total + 1; tickAt += FRAME_MS) player.tick(tickAt);
        player.tick(now + clip.total + 1);

        const title = `${next.title} interrupting ${before ? before.title : 'rest'}, standing ${standing}`;
        const { state } = player;
        assert.equal(player.playing, false, `${title}: still playing after its total`);
        if (next.entry.hold) continue;
        assert.equal(state.form, 0, `${title}: ends melted`);
        assert.deepEqual(state.squash, [1, 1], `${title}: ends squashed`);
        assert.deepEqual(state.lift, [0, 0], `${title}: ends with a corner lifted`);
        assert.ok(state.lids.every((lid) => lid <= 0.01), `${title}: ends with the eyes shut`);
        assert.ok([0, HOVER_Y].some((rest) => Math.abs(state.y - rest) < 1e-6), `${title}: ends at y ${state.y}`);
      }
    }
  }
});
