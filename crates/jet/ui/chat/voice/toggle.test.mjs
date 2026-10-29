import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceToggle } from './toggle.js';

/** Just enough of an element for the icons and the button. */
function fakeElement() {
  const attributes = new Map();
  const classes = new Set();
  let onClick = null;
  return {
    title: '',
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name),
    getAttribute: (name) => attributes.get(name) ?? null,
    append() {},
    replaceChildren() {},
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
    addEventListener: (kind, listener) => { if (kind === 'click') onClick = listener; },
    click: () => onClick(),
  };
}

function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
}

const blockedStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
  removeItem() { throw new Error('blocked'); },
};

const READY = { available: true, reason: null };

test('the speaker is off by default, remembers the choice on this device, and still works when storage is blocked', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElementNS: () => fakeElement() };
  try {
    const make = (storage, status = READY, check = async () => status) => {
      const button = fakeElement();
      const changes = [];
      const said = [];
      const toggle = createVoiceToggle({ button, storage, status, check, replying: () => false, announce: (message) => said.push(message), onChange: (on) => changes.push(on) });
      return { button, toggle, changes, said };
    };

    // A new device starts quiet; a press turns voice on and keeps the choice, and the next page load finds it.
    const storage = memoryStorage();
    const first = make(storage);
    assert.deepEqual([first.toggle.on, first.button.getAttribute('aria-pressed'), first.button.title], [false, 'false', 'Speak replies: off']);
    first.button.click();
    assert.deepEqual([first.toggle.on, first.button.getAttribute('aria-pressed'), first.changes, storage.getItem('jet.voice')], [true, 'true', [true], 'on']);
    const reloaded = make(storage);
    assert.deepEqual([reloaded.toggle.on, reloaded.button.getAttribute('aria-pressed')], [true, 'true']);
    reloaded.button.click();
    assert.deepEqual([reloaded.toggle.on, reloaded.changes, storage.getItem('jet.voice')], [false, [false], null]);
    assert.equal(make(storage).toggle.on, false, 'off is remembered too');

    // Storage that throws leaves the speaker off, and the button still turns voice on and off.
    const blocked = make(blockedStorage);
    assert.equal(blocked.toggle.on, false);
    blocked.button.click();
    assert.deepEqual([blocked.toggle.on, blocked.button.getAttribute('aria-pressed')], [true, 'true']);
    blocked.button.click();
    assert.equal(blocked.toggle.on, false);

    // A server that cannot speak shows why, keeps the button pressable, and says why when it is pressed.
    const reason = 'Voice needs GEMINI_VOICE_ID in .env';
    const wanted = memoryStorage();
    wanted.setItem('jet.voice', 'on');
    const unset = make(wanted, { available: false, reason });
    assert.deepEqual([unset.toggle.on, unset.button.getAttribute('aria-pressed'), unset.button.getAttribute('aria-disabled'), unset.button.title], [false, 'false', 'true', reason]);
    await unset.button.click();
    assert.deepEqual([unset.toggle.on, unset.said, unset.changes], [false, [reason], []]);
  } finally {
    globalThis.document = previous;
  }
});
