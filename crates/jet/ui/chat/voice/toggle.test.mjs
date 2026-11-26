// Proves the speaker button: the remembered choice, blocked storage, and the click that allows blocked sound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpokenReveal } from './spoken.js';
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
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
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

    // A problem with Google's voice marks the speaker and its tooltip until it clears.
    const trouble = make(memoryStorage());
    const marked = () => [trouble.button.classList.contains('has-problem'), trouble.button.title];
    trouble.toggle.setProblem("Jet can't speak right now: Google's voice quota is used up");
    assert.deepEqual(marked(), [true, "Jet can't speak right now: Google's voice quota is used up"]);
    trouble.toggle.setProblem(null);
    assert.deepEqual(marked(), [false, 'Speak replies: off']);

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

test('after a reload with the voice on, the click the blocked-sound notice asks for allows sound and keeps the voice on', async () => {
  // A reply spoken before any click let the page make sound.
  let now = 0;
  let timers = [];
  const clock = {
    now: () => now,
    after(fn, ms) { const timer = { fn, at: now + ms }; timers.push(timer); return () => { timers = timers.filter((t) => t !== timer); }; },
  };
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const tick = async (steps) => {
    for (let i = 0; i < steps; i++) {
      now += 10;
      for (const timer of timers.filter((t) => t.at <= now)) { timers = timers.filter((t) => t !== timer); timer.fn(); }
      await flush();
    }
  };
  const requests = [];
  const states = [];
  const reveal = createSpokenReveal({
    render: async (text) => '<p>' + text + '</p>',
    paint: () => {},
    speak: (text) => new Promise((resolve) => requests.push({ text, resolve })),
    player: { ready: () => false, now: () => now / 1000, outputLatency: () => 0, play: () => { throw new Error('not reached'); }, silence() {} },
    clock,
    onState: (state) => states.push(state),
  });
  reveal.text('Hello there. And more words here.');
  reveal.finish(() => {});
  await tick(5);
  requests[0].resolve(new ArrayBuffer(48000));
  await tick(20);
  const problem = states.map((state) => state.problem).find((text) => text);
  assert.equal(problem, 'The browser blocked sound; click the speaker to allow it.');

  const previous = globalThis.document;
  globalThis.document = { createElementNS: () => fakeElement() };
  try {
    const storage = memoryStorage();
    storage.setItem('jet.voice', 'on');
    const button = fakeElement();
    const changes = [];
    const toggle = createVoiceToggle({ button, storage, status: READY, check: async () => READY, replying: () => false, announce: () => {}, onChange: (on) => changes.push(on) });
    toggle.setProblem("Jet can't speak right now: " + problem);
    button.click();
    await flush();
    assert.deepEqual([toggle.on, changes, storage.getItem('jet.voice')], [true, [true], 'on'], 'the click allows sound with the voice still on');
  } finally {
    globalThis.document = previous;
  }
});

test('a click while another voice problem shows switches the voice off', () => {
  const previous = globalThis.document;
  globalThis.document = { createElementNS: () => fakeElement() };
  try {
    const storage = memoryStorage();
    storage.setItem('jet.voice', 'on');
    const button = fakeElement();
    const changes = [];
    const toggle = createVoiceToggle({ button, storage, status: READY, check: async () => READY, replying: () => false, announce: () => {}, onChange: (on) => changes.push(on) });
    toggle.setProblem("Jet can't speak right now: Google's voice quota is used up");
    button.click();
    assert.deepEqual([toggle.on, changes], [false, [false]]);
  } finally {
    globalThis.document = previous;
  }
});
