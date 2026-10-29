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
    hush: (ms) => feed(ms, QUIET, 0.001),
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

test('a second of speech is cut at a 320 ms breath, a shorter phrase waits for 600 ms, and the clip holds a little of the sound around it', () => {
  const { room, spokenEnd } = sentence(null, { leadIn: 480 });
  const [clip] = room.of('utterance');
  assert.equal(clip.at - spokenEnd, 320, 'cut as the 320 ms breath is reached');
  assert.deepEqual(room.story(), ['speech:true', 'speech:false', 'utterance:0', 'pausing:true']);
  const hops = hopsOf(clip.pcm);
  const firstSpeechHop = 480 / HOP + 1;
  const lastSpeechHop = firstSpeechHop + 1200 / HOP - 1;
  assert.equal(firstSpeechHop - hops[0], 19, 'about 300 ms (19 hops) of sound before the first word');
  assert.ok(hops.at(-1) - lastSpeechHop > 0 && hops.at(-1) - lastSpeechHop <= 300 / HOP, 'and at most 300 ms of the pause after the last');

  const short = rig();
  short.talk(500);
  short.hush(320 + HOP);
  assert.equal(short.of('utterance').length, 0, 'under a second, a 320 ms breath is not a cut');
  short.hush(592 - 336);
  assert.equal(short.of('utterance').length, 0, 'and not at 592 ms');
  short.hush(HOP);
  assert.equal(short.of('utterance').length, 1, 'but 600 ms is, so "Yes." alone is sent');

  const quietRoom = rig();
  quietRoom.hush(320);
  quietRoom.talk(320);
  const levels = quietRoom.of('level').map((event) => event.level);
  assert.equal(levels.length, 20, 'one level for every two hops');
  assert.ok(levels[3] < 0.1 && levels.at(-1) > 0.5, 'the level follows the voice above the room');
});

test('after the last words the send waits 700, 1000 or 1500 ms, as the ending says', () => {
  const waits = [['What time is it?', SETTINGS.GAP_COMPLETE_MS], ['the time in Lisbon', SETTINGS.GAP_NEUTRAL_MS], ['I was wondering about,', SETTINGS.GAP_OPEN_MS]];
  assert.deepEqual(waits.map(([, wait]) => wait), [700, 1000, 1500]);
  for (const [text, wait] of waits) {
    const { room, spokenEnd } = sentence(text);
    room.hush(wait - SETTINGS.PHRASE_GAP_MS - HOP);
    assert.equal(room.of('turn').length, 0, `${text}: nothing before ${wait} ms`);
    room.hush(HOP);
    const [turn] = room.of('turn');
    assert.ok(turn.at - spokenEnd >= wait && turn.at - spokenEnd < wait + HOP, `${text}: sent after ${turn.at - spokenEnd} ms`);
    assert.deepEqual(room.story().slice(-2), ['pausing:false', 'turn']);
  }
});

test('the turn waits for late words for six seconds, then goes on without them, and later words are dropped', () => {
  assert.equal(WORDS_LATE_MS, 6000);
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

test('a blip is never sent, and a turn whose words are empty is discarded', () => {
  const blip = rig();
  blip.talk(150);
  blip.hush(SETTINGS.SHORT_GAP_MS + HOP);
  assert.equal(blip.of('utterance').length, 0);
  assert.deepEqual(blip.story(), ['speech:true', 'speech:false', 'discarded:tooShort']);

  const cough = sentence('  ');
  assert.deepEqual(cough.room.story(), ['speech:true', 'speech:false', 'utterance:0', 'pausing:true', 'pausing:false', 'discarded:noWords']);
});

test('a run-on is cut at its quietest moment without ending the turn, and the rest heads the next utterance', () => {
  const room = rig();
  room.talk(6992);
  room.talk(HOP, SPEECH, 0.0001); // the quietest hop, inside the last 1.2 s before the cut
  room.talk(8000 - 6992 - HOP);
  const [first] = room.of('utterance');
  assert.equal(room.of('utterance').length, 1);
  const quietHop = 6992 / HOP + 1;
  assert.equal(hopsOf(first.pcm).at(-1), quietHop, 'the clip ends at the quietest hop');
  assert.deepEqual(room.story(), ['speech:true', 'utterance:0'], 'still speaking, no turn');

  room.talk(1000);
  room.hush(SETTINGS.PHRASE_GAP_MS);
  const [, second] = room.of('utterance');
  assert.equal(hopsOf(second.pcm)[0], quietHop + 1, 'the next utterance starts at the hop after the cut');
  room.endpointer.words({ index: 0, text: 'A long first part,' });
  room.endpointer.words({ index: 1, text: 'and then the rest.' });
  room.hush(SETTINGS.GAP_COMPLETE_MS);
  assert.equal(room.of('turn').length, 1);
});

test('speech that resumes while the turn waits reopens it, and the halo goes off', () => {
  const room = rig();
  room.talk(1200);
  room.hush(SETTINGS.PHRASE_GAP_MS);
  room.endpointer.words({ index: 0, text: 'I was wondering,' });
  room.hush(400);
  room.talk(1200);
  assert.deepEqual(room.story(), ['speech:true', 'speech:false', 'utterance:0', 'pausing:true', 'pausing:false', 'speech:true']);
  assert.equal(new Set(room.events.filter((event) => event.turnId).map((event) => event.turnId)).size, 1, 'the same turn');
  room.hush(SETTINGS.PHRASE_GAP_MS);
  room.endpointer.words({ index: 1, text: 'about the weather.' });
  room.hush(SETTINGS.GAP_COMPLETE_MS);
  assert.equal(room.of('turn').length, 1);
});

test('while Jet speaks, and for a second after, speech must hold 0.75 for 400 ms to count', () => {
  const guarded = rig();
  guarded.endpointer.setGuard({ jetSpeaking: true });
  guarded.talk(1000, 0.7);
  assert.equal(guarded.of('speech').length, 0, 'at 0.7 it is not sure enough');
  guarded.talk(400 - HOP, 0.8);
  assert.equal(guarded.of('speech').length, 0, 'and 384 ms is too short');
  guarded.talk(HOP, 0.8);
  assert.deepEqual(guarded.of('speech').map((event) => [event.on, event.interrupts]), [[true, true]]);

  const tail = rig();
  tail.endpointer.setGuard({ jetSpeaking: true });
  tail.hush(500);
  tail.endpointer.setGuard({ jetSpeaking: false });
  tail.talk(1000 - HOP * 2, 0.7);
  assert.equal(tail.of('speech').length, 0, 'the strict rule holds for a second after Jet stops');
  tail.hush(HOP * 3);
  tail.talk(96, 0.7);
  assert.deepEqual(tail.of('speech').map((event) => [event.on, event.interrupts]), [[true, false]], 'then the ordinary rule applies');
});
