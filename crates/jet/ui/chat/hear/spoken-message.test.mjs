import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpokenMessage } from './spoken-message.js';

/** The thread's forming message, the field and the page around them. Send works as on the page: it takes the forming message, tells the spoken message so, and the bubble becomes the sent message. */
function room({ canSend = true, audible = false } = {}) {
  const forming = { text: '', write(text) { forming.text = text; }, drop() { forming.text = ''; } };
  const field = { text: '', write(text) { field.text = text; } };
  const page = { sent: [], halo: false, ducked: false, silenced: 0, canSend, audible };
  const spoken = createSpokenMessage({
    forming,
    field,
    clock: { after: () => () => {} },
    reducedMotion: () => true,
    liveWords: { dropFinished() {}, dropAll() {} },
    voice: { audible: () => page.audible, duck() { page.ducked = true; }, unduck() { page.ducked = false; } },
    silence() { page.silenced++; },
    composer: {
      sendNow() {
        if (!page.canSend || forming.text === '') return false;
        spoken.formingTaken();
        page.sent.push(forming.text);
        forming.text = '';
        return true;
      },
      setPending(on) { page.halo = on; },
    },
  });
  return { spoken, forming, field, page };
}

const speech = (turnId) => ({ kind: 'speech', on: true, turnId });
const words = (turnId, text, { interrupts = false } = {}) => ({ kind: 'words', turnId, index: 0, text, interrupts });
const pausing = (turnId) => ({ kind: 'pausing', turnId, on: true });
const ended = (turnId) => ({ kind: 'turn', turnId, text: '' });

test('a spoken message sends itself at the end of its turn, and moves into the field when the person types, presses Esc while pausing, or it cannot go yet', () => {
  const sends = room();
  sends.spoken.hear(speech('t1'));
  sends.spoken.hear(words('t1', 'hello there'));
  assert.equal(sends.forming.text, 'Hello there');
  sends.spoken.hear(pausing('t1'));
  assert.equal(sends.page.halo, true);
  sends.spoken.hear(ended('t1'));
  assert.deepEqual(sends.page.sent, ['Hello there']);
  assert.equal(sends.forming.text, '');
  assert.equal(sends.page.halo, false);

  const refused = room({ canSend: false });
  refused.spoken.hear(speech('t1'));
  refused.spoken.hear(words('t1', 'with a file'));
  refused.spoken.hear(ended('t1'));
  assert.deepEqual(refused.page.sent, []);
  assert.equal(refused.forming.text, '');
  assert.equal(refused.field.text, 'With a file');

  const typing = room();
  typing.spoken.hear(speech('t1'));
  typing.spoken.hear(words('t1', 'hello'));
  typing.field.text = 'x';
  typing.spoken.typed('x');
  assert.equal(typing.field.text, 'Hello x');
  assert.equal(typing.forming.text, '');
  typing.spoken.hear(words('t1', 'again'));
  assert.equal(typing.field.text, 'Hello x again');
  typing.spoken.hear(ended('t1'));
  assert.deepEqual(typing.page.sent, []);

  const escaping = room();
  escaping.spoken.hear(speech('t1'));
  escaping.spoken.hear(words('t1', 'wait'));
  assert.equal(escaping.spoken.escape(), false);
  assert.equal(escaping.forming.text, 'Wait');
  escaping.spoken.hear(pausing('t1'));
  assert.equal(escaping.spoken.escape(), true);
  assert.equal(escaping.field.text, 'Wait');
  assert.equal(escaping.forming.text, '');
  assert.equal(escaping.page.halo, false);
  assert.equal(escaping.spoken.escape(), false);
});

test("a turn the mic cut short or threw away never sends itself unless Google could not hear it and the browser's live words show, and its late words land only in a field the person took over", () => {
  const outside = room();
  outside.spoken.showLive('jet said this');
  assert.equal(outside.forming.text, '');
  outside.spoken.hear(speech('t1'));
  outside.spoken.showLive('hello');
  assert.equal(outside.forming.text, 'Hello');

  const cutShort = room();
  cutShort.spoken.hear(speech('t1'));
  cutShort.spoken.hear(words('t1', 'hello'));
  cutShort.spoken.micStopped();
  assert.equal(cutShort.field.text, 'Hello');
  assert.equal(cutShort.forming.text, '');
  cutShort.spoken.hear(words('t1', 'there'));
  assert.equal(cutShort.field.text, 'Hello there');

  const late = room();
  late.spoken.hear(speech('t1'));
  late.spoken.micStopped();
  late.spoken.hear(speech('t2'));
  late.spoken.hear(words('t1', 'late'));
  assert.equal(late.forming.text, '');
  late.spoken.hear(words('t2', 'new'));
  assert.equal(late.forming.text, 'New');

  const discarded = room();
  discarded.spoken.hear(speech('t1'));
  discarded.spoken.hear(words('t1', 'cough'));
  discarded.spoken.hear({ kind: 'discarded', turnId: 't1', reason: 'tooShort' });
  assert.equal(discarded.forming.text, '');
  assert.equal(discarded.field.text, '');
  assert.deepEqual(discarded.page.sent, []);

  // When Google gave no words the live words are all the person said, so they are sent in their place.
  for (const reason of ['failed', 'late']) {
    const unheard = room();
    unheard.spoken.hear(speech('t1'));
    unheard.spoken.showLive('hello there');
    unheard.spoken.hear({ kind: 'discarded', turnId: 't1', reason });
    assert.deepEqual(unheard.page.sent, ['Hello there'], reason);
  }
  const nothing = room();
  nothing.spoken.hear(speech('t1'));
  nothing.spoken.hear({ kind: 'discarded', turnId: 't1', reason: 'failed' });
  assert.deepEqual(nothing.page.sent, []);
  assert.equal(nothing.forming.text, '');
});

test("Jet's voice is ducked while the person speaks over it, and words that cut in quiet the reply", () => {
  const over = room({ audible: true });
  over.spoken.hear(speech('t1'));
  assert.equal(over.page.ducked, true);
  over.spoken.hear(words('t1', 'stop', { interrupts: true }));
  assert.equal(over.page.silenced, 1);
  assert.equal(over.page.ducked, false);
  over.spoken.hear(speech('t1'));
  assert.equal(over.page.ducked, true);
  over.spoken.hear(ended('t1'));
  assert.equal(over.page.ducked, false);
  assert.deepEqual(over.page.sent, ['Stop']);
  over.spoken.hear(speech('t2'));
  assert.equal(over.page.ducked, true);
  over.spoken.micStopped();
  assert.equal(over.page.ducked, false);
});
