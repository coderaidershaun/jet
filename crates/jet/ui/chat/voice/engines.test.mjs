// Tests that each voice engine works alone and that the chosen one goes first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEARING, SPEAKING, buttonStatus, engineInUse, enginesOf } from './engines.js';
import { createHearToggle } from '../hear/hear-toggle.js';
import { createVoiceToggle } from './toggle.js';

const ON = { available: true, reason: null };
const off = (reason) => ({ available: false, reason });

function fakeButton() {
  const attributes = new Map();
  return {
    title: '',
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name),
    getAttribute: (name) => attributes.get(name) ?? null,
    append() {},
    replaceChildren() {},
    classList: { toggle() {}, remove() {} },
    addEventListener() {},
  };
}

/** Whether the mic or the speaker is disabled once it is given `status`. */
function disabledWith(way, status) {
  const previous = globalThis.document;
  globalThis.document = { createElementNS: () => fakeButton() };
  try {
    const button = fakeButton();
    const common = { button, storage: null, status, check: async () => status, announce() {} };
    if (way === HEARING) createHearToggle({ ...common, onStart() {}, onStop() {} });
    else createVoiceToggle({ ...common, replying: () => false, onChange() {} });
    return button.getAttribute('aria-disabled') === 'true';
  } finally {
    globalThis.document = previous;
  }
}

test('each engine works on its own, the chosen one goes first, and the mic or the speaker goes dark only when none can', () => {
  const ways = [
    [HEARING, 'phonon2', { webkitSpeechRecognition: class {} }, { SpeechRecognition: class {} }],
    [SPEAKING, 'phonon', { speechSynthesis: {}, SpeechSynthesisUtterance: class {} }, { speechSynthesis: {} }],
  ];
  for (const [way, local, browser, halfBrowser] of ways) {
    const cases = [
      // [server engines, scope, chosen, engine in use]
      [{ gemini: ON, [local]: off('Download it') }, {}, local, 'gemini'],
      [{ gemini: off('No key'), [local]: ON }, {}, 'gemini', local],
      [{ gemini: off('No key'), [local]: off('Download it') }, browser, 'gemini', 'browser'],
      [{ gemini: ON, [local]: ON }, browser, 'browser', 'browser'],
      [{ gemini: ON, [local]: ON }, {}, local, local],
      [undefined, {}, 'gemini', null],
      [{ gemini: off('No key'), [local]: off('Download it') }, {}, 'browser', null],
    ];
    for (const [server, scope, chosen, expected] of cases) {
      const engines = enginesOf(way, server, scope);
      const what = JSON.stringify({ way: way.button, server, scope: Object.keys(scope), chosen });
      assert.equal(engineInUse(way, chosen, engines), expected, what);
      assert.equal(disabledWith(way, buttonStatus(way, chosen, engines)), expected === null, what);
    }
    const hearsAlone = way === HEARING;
    assert.equal(enginesOf(way, {}, halfBrowser).browser.available, hearsAlone, `${way.button} with ${Object.keys(halfBrowser)}`);
    const none = buttonStatus(way, 'gemini', enginesOf(way, { gemini: off('No key'), [local]: off('Download it') }, {}));
    assert.match(none.reason, /Gemini: No key\. Browser: This browser has no .*Phonon(-2)?: Download it/);
  }
});
