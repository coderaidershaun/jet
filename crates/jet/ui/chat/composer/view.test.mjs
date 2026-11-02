import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposerView } from './view.js';
import { createComposer } from './state.js';

/** Just enough of an element for the field, the button and the icons; `fire` runs the listener the view added. */
function fakeElement(extra = {}) {
  const listeners = {};
  return {
    style: {}, dataset: {}, scrollHeight: 0, offsetHeight: 0, clientHeight: 0, setAttribute() {}, append() {}, replaceChildren() {},
    addEventListener(type, listener) { listeners[type] = listener; },
    fire(type, event = {}) { listeners[type]({ preventDefault() {}, stopPropagation() {}, ...event }); },
    ...extra,
  };
}

const ENTER = { key: 'Enter', shiftKey: false, isComposing: false };

test('Send, Enter and the end of a spoken turn send the forming message while the field is empty, hold it while Jet replies, and never stop the reply', () => {
  const previous = globalThis.document;
  globalThis.document = { createElementNS: () => fakeElement() };
  try {
    const make = ({ replying = false, spoken = '' } = {}) => {
      const state = createComposer({ empty: false });
      state.replying = replying;
      const calls = [];
      const field = fakeElement({ value: '', placeholder: 'Message Jet' });
      const button = fakeElement();
      const view = createComposerView({
        page: fakeElement(), composer: fakeElement(), field, button, heldChip: fakeElement(), heldCancel: fakeElement(),
        state, reducedMotion: () => false, forming: () => spoken,
        handlers: {
          send: (text) => calls.push(['send', text]), hold: (text) => calls.push(['hold', text]), stop: () => calls.push(['stop']),
          input: (text) => calls.push(['input', text]), formingTaken: () => calls.push(['formingTaken']),
        },
      });
      return { view, field, button, calls };
    };

    // With the field empty, Send and Enter take the forming message and leave the field alone.
    const clicked = make({ spoken: 'Hello there' });
    clicked.button.fire('click');
    assert.deepEqual(clicked.calls, [['formingTaken'], ['send', 'Hello there']]);
    const entered = make({ spoken: 'Hello there' });
    entered.field.fire('keydown', ENTER);
    assert.deepEqual(entered.calls, [['formingTaken'], ['send', 'Hello there']]);

    // A draft the person typed is theirs: Enter sends it, and the end of the spoken turn sends the forming message beside it.
    const typed = make({ spoken: 'Hello' });
    typed.field.value = 'draft';
    typed.field.fire('keydown', ENTER);
    assert.deepEqual(typed.calls, [['input', ''], ['send', 'draft']]);
    const beside = make({ spoken: 'Hello' });
    beside.field.value = 'draft';
    assert.equal(beside.view.sendNow(), true);
    assert.deepEqual(beside.calls, [['formingTaken'], ['send', 'Hello']]);
    assert.equal(beside.field.value, 'draft');

    // While Jet replies the forming message is held, and the reply is never stopped.
    const replying = make({ replying: true, spoken: 'and one more thing' });
    replying.field.fire('keydown', ENTER);
    assert.equal(replying.view.sendNow(), true);
    assert.deepEqual(replying.calls, [['formingTaken'], ['hold', 'and one more thing'], ['formingTaken'], ['hold', 'and one more thing']]);

    // Nothing forms: the end of a turn does nothing, and does not stop the reply either.
    const nothing = make({ replying: true });
    assert.equal(nothing.view.sendNow(), false);
    assert.deepEqual(nothing.calls, []);
  } finally {
    globalThis.document = previous;
  }
});
