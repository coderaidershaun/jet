import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposerView } from './view.js';
import { createComposer } from './state.js';

/** Just enough of an element for the field, the button and the icons. */
function fakeElement(extra = {}) {
  return { style: {}, dataset: {}, scrollHeight: 0, offsetHeight: 0, clientHeight: 0, setAttribute() {}, append() {}, replaceChildren() {}, addEventListener() {}, ...extra };
}

test('sendNow sends the field as Enter would, holds it while Jet replies, and never stops the reply', () => {
  const previous = globalThis.document;
  globalThis.document = { createElementNS: () => fakeElement() };
  try {
    const make = (replying) => {
      const state = createComposer({ empty: false });
      state.replying = replying;
      const calls = [];
      const field = fakeElement({ value: '', placeholder: 'Message Jet' });
      const view = createComposerView({
        page: fakeElement(), composer: fakeElement(), field, button: fakeElement(), heldChip: fakeElement(), heldCancel: fakeElement(),
        state, reducedMotion: () => false,
        handlers: { send: (text) => calls.push(['send', text]), hold: (text) => calls.push(['hold', text]), stop: () => calls.push(['stop']), input: (text) => calls.push(['input', text]) },
      });
      return { view, field, calls };
    };

    const idle = make(false);
    idle.field.value = '  hello jet ';
    idle.view.sendNow();
    assert.deepEqual(idle.calls, [['input', ''], ['send', 'hello jet']]);
    assert.equal(idle.field.value, '', 'the field is emptied as an Enter would');

    const replying = make(true);
    replying.field.value = 'and one more thing';
    replying.view.sendNow();
    assert.deepEqual(replying.calls, [['input', ''], ['hold', 'and one more thing']], 'a spoken turn while Jet thinks is held, not a Stop');

    const empty = make(true);
    empty.view.sendNow();
    assert.deepEqual(empty.calls, [], 'with nothing to send it does nothing, and does not stop the reply either');
  } finally {
    globalThis.document = previous;
  }
});
