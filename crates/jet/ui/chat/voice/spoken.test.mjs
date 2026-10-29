import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpokenReveal } from './spoken.js';
import { segment } from './segment.js';

const BYTES_PER_SECOND = 48000;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

/** One fake clock for the player and for the plain reveal inside, so that sound and text keep the same time. */
function world() {
  let now = 0;
  let timers = [];
  const clock = {
    now: () => now,
    after(fn, ms) {
      const timer = { fn, at: now + ms };
      timers.push(timer);
      return () => { timers = timers.filter((other) => other !== timer); };
    },
  };
  const painted = [];
  const timeline = [];
  const played = [];
  const requests = [];
  const states = [];
  const world = {
    painted, played, requests, states, timeline, silenced: 0,
    now: () => now,
    shown: () => (painted.at(-1) ?? '').replace(/<\/?p>/g, ''),
    /** Steps through time in tens of milliseconds, noting each time the number of words shown changes. */
    async advance(ms) {
      const target = now + ms;
      const runDue = async (limit) => {
        for (let due = nextDue(limit); due; due = nextDue(limit)) {
          timers = timers.filter((t) => t !== due);
          now = Math.max(now, due.at);
          due.fn();
          await flush();
        }
      };
      const nextDue = (limit) => timers.filter((t) => t.at <= limit).sort((a, b) => a.at - b.at)[0];
      while (now < target) {
        const step = Math.min(target, now + 10);
        await runDue(step);
        now = step;
        await flush();
        await runDue(step);
        const words = world.shown().split(' ').filter(Boolean).length;
        if (words !== (timeline.at(-1)?.[1] ?? 0)) timeline.push([now, words]);
      }
    },
    /** The time at which the shown text first held `count` words. */
    seenAt: (count) => timeline.find(([, words]) => words >= count)?.[0],
    reveal() {
      return createSpokenReveal({
        render: async (text) => '<p>' + text + '</p>',
        paint: (html) => painted.push(html),
        speak: (text, signal) => new Promise((resolve, reject) => requests.push({ text, signal, resolve: (seconds) => resolve(new ArrayBuffer(Math.round(seconds * BYTES_PER_SECOND))), reject })),
        player: {
          ready: () => true,
          now: () => now / 1000,
          outputLatency: () => 0,
          play(pcm, at) {
            const clip = { start: at, end: at + pcm.byteLength / BYTES_PER_SECOND };
            played.push(clip);
            return clip;
          },
          silence() { world.silenced++; },
        },
        clock,
        onState: (state) => states.push(state),
      });
    },
  };
  return world;
}

test('words appear as their audio plays and the reply finishes after the voice', async () => {
  const w = world();
  const reveal = w.reveal();
  const text = 'Hello brave new world. Second sentence here.';
  reveal.text(text);
  await w.advance(10);
  assert.deepEqual(w.requests.map((request) => request.text), ['Hello brave new world.'], 'the first piece is one sentence');
  assert.equal(w.painted.length, 0, 'the words wait for the first clip');
  assert.equal(reveal.speaking, true);

  await w.advance(990);
  w.requests[0].resolve(2);
  await w.advance(500);
  let finishedAt = null;
  reveal.finish(() => { finishedAt = w.now(); });
  await w.advance(10);
  assert.equal(w.requests[1].text, 'Second sentence here.');
  await w.advance(290);
  w.requests[1].resolve(1.5);
  await w.advance(2900);
  assert.equal(finishedAt, null, 'the reply is not finished while Jet is still talking');
  assert.equal(reveal.speaking, true);
  await w.advance(1500);

  const [first, second] = w.played;
  assert.ok(Math.abs(second.start - first.end - 0.25) < 1e-9, 'a quarter of a second between two clips of one block');
  assert.ok(finishedAt >= second.end * 1000 - 1 && finishedAt < second.end * 1000 + 120, `finished at ${finishedAt}, the voice ended at ${second.end * 1000}`);
  assert.equal(w.shown(), text);
  assert.equal(reveal.speaking, false);
  assert.equal(w.states.at(-1).speaking, false);

  // Each word is shown shortly before the voice reaches it: never more than 450 ms early, and never late.
  const marks = segment(text, true).map((part) => part.marks);
  let word = 0;
  for (const [clip, clipMarks] of [[first, marks[0]], [second, marks[1]]]) {
    const total = clipMarks.reduce((sum, mark) => sum + mark.weight, 0);
    let before = 0;
    for (const mark of clipMarks) {
      word++;
      const heard = (clip.start + (before / total) * (clip.end - clip.start)) * 1000;
      const shown = w.seenAt(word);
      assert.ok(shown >= heard - 450 && shown <= heard + 60, `word ${word} shown at ${shown}, heard at ${heard}`);
      before += mark.weight;
    }
  }

  // While a tool runs after the voice has said what came before it, Jet is quiet, not speaking.
  const q = world();
  const quiet = q.reveal();
  quiet.text('Let me look.\n\n');
  await q.advance(10);
  q.requests[0].resolve(1);
  await q.advance(500);
  assert.equal(quiet.speaking, true);
  await q.advance(1000);
  assert.deepEqual([quiet.speaking, q.states.at(-1).speaking, q.shown()], [false, false, 'Let me look.']);
  quiet.text('Let me look.\n\nDone.');
  quiet.finish(() => {});
  await q.advance(10);
  assert.equal(quiet.speaking, true, 'the next clip is on its way');
});

test('flush silences and shows every word at once', async () => {
  // While text is still coming: the sound stops, every word shows, and the text after goes straight through.
  const w = world();
  const reveal = w.reveal();
  reveal.text('One two. Three four. Five six.');
  await w.advance(10);
  w.requests[0].resolve(2);
  await w.advance(100);
  assert.equal(w.requests.length, 2, 'the rest is fetched ahead');
  assert.ok(!w.shown().includes('four'));
  assert.equal(reveal.speaking, true);

  reveal.flush();
  assert.equal(w.silenced, 1);
  assert.ok(w.requests.slice(1).every((request) => request.signal.aborted), 'the clips still on their way are given up');
  assert.equal(reveal.speaking, false);
  await w.advance(100);
  assert.equal(w.shown(), 'One two. Three four. Five six.');
  reveal.text('One two. Three four. Five six. Seven.');
  await w.advance(100);
  assert.equal(w.shown(), 'One two. Three four. Five six. Seven.');
  w.requests[1].resolve(1);
  await w.advance(100);
  assert.equal(w.played.length, 1, 'a clip that arrives after the flush is never played');

  // After the last text: a finish that waits for the voice is released.
  const v = world();
  const waiting = v.reveal();
  waiting.text('One two. Three four.');
  await v.advance(10);
  v.requests[0].resolve(2);
  let finished = 0;
  waiting.finish(() => { finished++; });
  await v.advance(100);
  assert.equal(finished, 0, 'the reply waits for the voice');
  waiting.flush();
  await v.advance(100);
  assert.equal(finished, 1);
  assert.equal(v.silenced, 1);
  assert.equal(v.states.at(-1).speaking, false);
});

test('a failed clip shows its words and the voice goes on', async () => {
  // One clip fails: its words show at once, and the next clip plays.
  const a = world();
  const one = a.reveal();
  one.text('One two. Three four. Five six. Seven eight.');
  await a.advance(10);
  a.requests[0].reject({ kind: 'http', message: 'The voice request failed' });
  await a.advance(10);
  assert.equal(a.shown(), 'One two.');
  a.requests[1].resolve(3);
  await a.advance(10);
  assert.equal(a.played.length, 1);
  assert.equal(one.speaking, true);
  assert.deepEqual(a.states.map((state) => state.problem).filter((problem) => problem !== undefined), ['The voice request failed', null], 'the problem shows until a clip plays again');

  // A clip more than eight seconds late for its turn is given up, and the next one plays.
  const b = world();
  const two = b.reveal();
  two.text('One two. Three four. Five six.');
  await b.advance(10);
  b.requests[1].resolve(1);
  await b.advance(7800);
  assert.equal(b.shown(), '');
  assert.equal(b.played.length, 0);
  await b.advance(300);
  assert.ok(b.shown().startsWith('One two.'));
  assert.equal(b.played.length, 1);
  assert.equal(b.requests[0].signal.aborted, true);

  // Two failures in a row end the voice for the reply: everything shows, and the rest goes straight through.
  const c = world();
  const three = c.reveal();
  three.text('One two. Three four. Five six.');
  await c.advance(10);
  c.requests[0].reject({ kind: 'http', message: 'first' });
  c.requests[1].reject({ kind: 'rateLimited', message: "Google's voice quota is used up" });
  await c.advance(100);
  assert.equal(c.shown(), 'One two. Three four. Five six.');
  assert.equal(three.speaking, false);
  assert.equal(c.states.at(-1).problem, "Google's voice quota is used up");
  three.text('One two. Three four. Five six. Seven.');
  await c.advance(100);
  assert.equal(c.shown(), 'One two. Three four. Five six. Seven.');

  // A voice that is not set up is not tried again.
  const d = world();
  const four = d.reveal();
  four.text('One two. Three four. Five six.');
  await d.advance(10);
  d.requests[0].reject({ kind: 'notConfigured', message: 'Voice needs GEMINI_VOICE_ID in .env' });
  await d.advance(100);
  assert.equal(d.shown(), 'One two. Three four. Five six.');
  assert.equal(d.states.at(-1).problem, 'Voice needs GEMINI_VOICE_ID in .env');
});
