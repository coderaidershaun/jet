import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEndpointer, SETTINGS, WORDS_LATE_MS } from './endpointer.js';

const HOP = SETTINGS.HOP_MS;
const SPEECH = 0.9;
const QUIET = 0.05;

/** Feeds the endpointer hops of known length. Every hop is filled with its own number, so a clip shows which hops it holds. */
function rig() {
  const events = [];
  let turns = 0;
  let hopNumber = 0;
  let atMs = 0;
  const endpointer = createEndpointer({
    newTurn: () => `turn-${++turns}`,
    onEvent: (event) => events.push({ ...event, at: atMs + HOP }), // when the hop being fed ended
  });
  const feed = (ms, p, rms) => {
    for (let spent = 0; spent < ms; spent += HOP) {
      endpointer.frame({ hop: new Int16Array(256).fill(++hopNumber), p, rms, atMs });
      atMs += HOP;
    }
  };
  return {
    endpointer,
    events,
    talk: (ms, p = SPEECH, rms = 0.1) => feed(ms, p, rms),
    hush: (ms, rms = 0.001) => feed(ms, QUIET, rms),
    now: () => atMs,
    of: (kind) => events.filter((event) => event.kind === kind),
    /** What happened, in order, leaving out the steady stream of levels. */
    story: () => events.filter((event) => event.kind !== 'level').map((event) => [event.kind, event.on ?? event.reason ?? event.index].filter((part) => part !== undefined).join(':')),
  };
}

const hopsOf = (clip) => Array.from({ length: clip.length / 256 }, (_, at) => clip[at * 256]);

/** One spoken sentence of 1.2 s, its pause cut at 320 ms, and the words that came back for it. */
function sentence(text, { leadIn = 0 } = {}) {
  const room = rig();
  if (leadIn) room.hush(leadIn);
  room.talk(1200);
  const spokenEnd = room.now();
  room.hush(SETTINGS.PHRASE_GAP_MS);
  if (text !== null) room.endpointer.words({ index: 0, text });
  return { room, spokenEnd };
}

test('a phrase is cut at a breath, a short one waits longer, a run-on is cut at its quietest hop, and the clip keeps a little sound around the speech', () => {
  const { room, spokenEnd } = sentence(null, { leadIn: 480 });
  const [clip] = room.of('utterance');
  assert.equal(clip.at - spokenEnd, SETTINGS.PHRASE_GAP_MS, 'cut as the breath is reached');
  assert.deepEqual(room.story(), ['speech:true', 'speech:false', 'utterance:0', 'pausing:true']);
  const hops = hopsOf(clip.pcm);
  const firstSpeechHop = 480 / HOP + 1;
  const lastSpeechHop = firstSpeechHop + 1200 / HOP - 1;
  assert.ok(firstSpeechHop - hops[0] > 0, 'some sound before the first word');
  assert.ok(hops.at(-1) - lastSpeechHop > 0, 'and some of the pause after the last');

  const short = rig();
  short.talk(500);
  short.hush(SETTINGS.SHORT_GAP_MS - HOP);
  assert.equal(short.of('utterance').length, 0, 'a short phrase is not cut at a breath');
  short.hush(HOP);
  assert.equal(short.of('utterance').length, 1, 'but a longer pause closes it, so "Yes." alone is sent');

  const runOn = rig();
  runOn.talk(6992);
  runOn.talk(HOP, SPEECH, 0.0001); // the quietest hop, inside the last 1.2 s before the cut
  runOn.talk(SETTINGS.MAX_UTTERANCE_MS - 6992 - HOP);
  const [first] = runOn.of('utterance');
  const quietHop = 6992 / HOP + 1;
  assert.equal(hopsOf(first.pcm).at(-1), quietHop, 'the clip ends at the quietest hop');
  assert.deepEqual(runOn.story(), ['speech:true', 'utterance:0'], 'still speaking, no turn');
  runOn.talk(1000);
  runOn.hush(SETTINGS.PHRASE_GAP_MS);
  const [, second] = runOn.of('utterance');
  assert.equal(hopsOf(second.pcm)[0], quietHop + 1, 'the next utterance starts at the hop after the cut');
});

test('after the last words the send waits longer for words that sound unfinished, and speech that resumes reopens the turn', () => {
  const waits = [['What time is it?', SETTINGS.GAP_COMPLETE_MS], ['the time in Lisbon', SETTINGS.GAP_NEUTRAL_MS], ['I was wondering about,', SETTINGS.GAP_OPEN_MS]];
  assert.ok(waits[0][1] < waits[1][1] && waits[1][1] < waits[2][1]);
  for (const [text, wait] of waits) {
    const { room, spokenEnd } = sentence(text);
    room.hush(wait - SETTINGS.PHRASE_GAP_MS - HOP);
    assert.equal(room.of('turn').length, 0, `${text}: nothing before its wait`);
    room.hush(HOP);
    const [turn] = room.of('turn');
    assert.ok(turn.at - spokenEnd >= wait && turn.at - spokenEnd < wait + HOP, `${text}: sent after ${turn.at - spokenEnd} ms`);
    assert.deepEqual(room.story().slice(-2), ['pausing:false', 'turn']);
  }

  const room = rig();
  room.talk(1200);
  room.hush(SETTINGS.PHRASE_GAP_MS);
  room.endpointer.words({ index: 0, text: 'I was wondering,' });
  room.hush(400);
  room.talk(1200);
  assert.deepEqual(room.story(), ['speech:true', 'speech:false', 'utterance:0', 'pausing:true', 'pausing:false', 'speech:true']);
  assert.equal(new Set(room.events.filter((event) => event.turnId).map((event) => event.turnId)).size, 1, 'the same turn');
});

test('the turn waits for late words, then goes on without them, and later words are dropped', () => {
  const waiting = sentence(null);
  waiting.room.hush(WORDS_LATE_MS - HOP * 2);
  assert.equal(waiting.room.of('discarded').length, 0, 'still waiting just before the cap');
  waiting.room.hush(HOP * 3);
  assert.deepEqual(waiting.room.of('discarded').map((event) => event.reason), ['late'], 'nothing came, so the turn is discarded');
  waiting.room.endpointer.words({ index: 0, text: 'Too late.' });
  waiting.room.hush(2000);
  assert.equal(waiting.room.of('turn').length, 0, 'words for a closed turn change nothing');

  const partly = rig();
  partly.talk(1200);
  partly.hush(SETTINGS.PHRASE_GAP_MS);
  partly.talk(1200);
  partly.hush(SETTINGS.PHRASE_GAP_MS);
  partly.endpointer.words({ index: 0, text: 'First half,' });
  partly.hush(WORDS_LATE_MS);
  assert.equal(partly.of('turn').length, 1, 'with some words, the turn is sent with what came');

  const slow = sentence(null);
  slow.room.hush(SETTINGS.GAP_OPEN_MS * 2);
  assert.equal(slow.room.of('turn').length, 0, 'long silence alone does not send a turn whose words are missing');
  slow.room.endpointer.words({ index: 0, text: 'Hello there.' });
  assert.equal(slow.room.of('turn').length, 1, 'words arriving after the gap has passed send the turn at once');

  const runOn = rig();
  runOn.talk(SETTINGS.MAX_UTTERANCE_MS + WORDS_LATE_MS);
  runOn.hush(SETTINGS.PHRASE_GAP_MS);
  runOn.endpointer.words({ index: 1, text: 'and that is all.' });
  assert.equal(runOn.of('turn').length, 0, 'a late first clip does not hurry the end of the thought');
  runOn.hush(SETTINGS.GAP_COMPLETE_MS - SETTINGS.PHRASE_GAP_MS);
  assert.equal(runOn.of('turn').length, 1, 'the turn ends with the words that came, after its own gap');
});

test('a blip or a microphone fade-in is never sent, and a turn whose words are empty or failed is discarded', () => {
  const blip = rig();
  blip.talk(150);
  blip.hush(SETTINGS.SHORT_GAP_MS + HOP);
  assert.equal(blip.of('utterance').length, 0);
  assert.deepEqual(blip.story(), ['speech:true', 'speech:false', 'discarded:tooShort']);

  const justOpened = rig();
  justOpened.hush(160, 1e-5);
  justOpened.talk(128, SPEECH, 0.003);
  justOpened.hush(1000, 0.003);
  assert.ok(Math.max(...justOpened.of('level').map((event) => event.level)) < 0.1, 'room noise just after the microphone opens is not loud');
  assert.ok(justOpened.of('level').every((event) => !event.speech), 'and the fade-in is not speech');

  const cough = sentence('  ');
  assert.deepEqual(cough.room.story(), ['speech:true', 'speech:false', 'utterance:0', 'pausing:true', 'pausing:false', 'discarded:noWords']);

  const refused = sentence(null);
  refused.room.endpointer.words({ index: 0, text: '', failed: true });
  assert.deepEqual(refused.room.story(), ['speech:true', 'speech:false', 'utterance:0', 'pausing:true', 'pausing:false', 'discarded:failed']);
});

test('while Jet speaks, and for a while after, only sure and lasting speech counts', () => {
  const guarded = rig();
  guarded.endpointer.setGuard({ jetSpeaking: true });
  guarded.talk(SETTINGS.GUARD_START_MS * 2, SETTINGS.GUARD_ON_P - 0.05);
  assert.equal(guarded.of('speech').length, 0, 'not sure enough');
  guarded.talk(SETTINGS.GUARD_START_MS - HOP * 2, 0.8);
  assert.equal(guarded.of('speech').length, 0, 'and too short');
  guarded.talk(HOP * 2, 0.8);
  assert.deepEqual(guarded.of('speech').map((event) => [event.on, event.interrupts]), [[true, true]]);

  const tail = rig();
  tail.endpointer.setGuard({ jetSpeaking: true });
  tail.hush(500);
  tail.endpointer.setGuard({ jetSpeaking: false });
  tail.talk(SETTINGS.GUARD_TAIL_MS - HOP * 2, 0.7);
  assert.equal(tail.of('speech').length, 0, 'the strict rule holds after Jet stops');
  tail.hush(HOP * 3);
  tail.talk(96, 0.7);
  assert.deepEqual(tail.of('speech').map((event) => [event.on, event.interrupts]), [[true, false]], 'then the ordinary rule applies');
});
