import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHearToggle } from './hear-toggle.js';

/** Just enough of an element for the icon and the button. */
function fakeElement() {
  const attributes = new Map();
  const classes = new Set();
  const listeners = new Map();
  const properties = new Map();
  return {
    title: '',
    style: { setProperty: (name, value) => properties.set(name, value) },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name),
    getAttribute: (name) => attributes.get(name) ?? null,
    append() {},
    replaceChildren() {},
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    addEventListener: (kind, listener) => listeners.set(kind, listener),
    click: () => listeners.get('click')(),
    property: (name) => properties.get(name),
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

/** Builds a toggle on fake parts; frames wait in a queue until `runFrames` runs them. */
function make({ storage = memoryStorage(), status = READY, check = async () => status, reducedMotion = false } = {}) {
  const button = fakeElement();
  const said = [];
  const calls = [];
  const frames = [];
  const toggle = createHearToggle({
    button,
    storage,
    status,
    check,
    announce: (message) => said.push(message),
    onStart: () => calls.push('start'),
    onStop: () => calls.push('stop'),
    reducedMotion: () => reducedMotion,
    requestFrame: (fn) => frames.push(fn),
  });
  const runFrames = () => { while (frames.length > 0) frames.shift()(); };
  const look = () => [button.getAttribute('data-state'), button.getAttribute('aria-pressed'), button.title];
  return { button, toggle, said, calls, frames, runFrames, look };
}

test('the mic shows every state with its tooltip, announces each change once, and rings with the voice level', () => {
  const previous = globalThis.document;
  globalThis.document = { createElementNS: () => fakeElement() };
  try {
    const storage = memoryStorage();
    storage.setItem('jet.hear', 'on');
    const mic = make({ storage });
    assert.deepEqual(mic.look(), ['off', 'true', 'Talk to Jet: off']);
    assert.deepEqual(mic.said, [], 'nothing is announced when the page loads');

    const table = [
      ['waitingForTouch', undefined, 'Click anywhere to start listening', null],
      ['starting', undefined, 'Asking for the microphone…', null],
      ['listening', undefined, 'Listening', 'Jet is listening'],
      ['halfDuplexPause', undefined, 'Paused while Jet speaks', null],
      ['listening', undefined, 'Listening', null],
      ['asleep', undefined, 'Listening paused after 10 quiet minutes. Click to listen again.', 'Listening paused'],
      ['listening', undefined, 'Listening', 'Jet is listening'],
      ['blocked', undefined, "Microphone blocked. Allow it in the browser's site settings, then click.", "Microphone blocked. Allow it in the browser's site settings, then click."],
      ['blocked', 'The microphone stopped. Click to listen again.', '', null],
      ['problem', 'Hearing needs GEMINI_API_KEY in .env', '', 'Hearing needs GEMINI_API_KEY in .env'],
      ['off', undefined, 'Talk to Jet: off', 'Jet is not listening'],
    ];
    for (const [state, reason, tooltip, announcement] of table) {
      const before = mic.said.length;
      mic.toggle.setState(state, reason);
      assert.deepEqual(mic.look(), [state, 'true', reason ?? tooltip], state);
      assert.deepEqual(mic.said.slice(before), announcement === null ? [] : [announcement], `${state} is announced once, or not at all`);
    }

    // The warning dot is for blocked and problem only; the pill lights while the mic is on its way or on.
    const flags = [];
    for (const state of ['off', 'starting', 'listening', 'halfDuplexPause', 'asleep', 'waitingForTouch', 'blocked', 'problem']) {
      mic.toggle.setState(state, 'why');
      flags.push([state, mic.button.classList.contains('has-problem'), mic.toggle.lit]);
    }
    assert.deepEqual(flags, [
      ['off', false, false], ['starting', false, true], ['listening', false, true], ['halfDuplexPause', false, true],
      ['asleep', false, false], ['waitingForTouch', false, false], ['blocked', true, false], ['problem', true, false],
    ]);

    // The ring answers the voice through an eased level, and words on their way make it pulse.
    mic.toggle.setState('listening');
    mic.toggle.setLevel(1);
    mic.frames.shift()();
    const first = Number(mic.button.property('--level'));
    assert.ok(first > 0 && first < 1, 'the ring eases toward the voice, not straight to it');
    mic.runFrames();
    assert.equal(Number(mic.button.property('--level')), 1);
    assert.equal(mic.frames.length, 0, 'the easing stops once the ring has caught up');
    mic.toggle.setBusy(2);
    assert.equal(mic.button.classList.contains('is-busy'), true);
    mic.toggle.setBusy(0);
    assert.equal(mic.button.classList.contains('is-busy'), false);
    mic.toggle.setState('asleep');
    assert.equal(Number(mic.button.property('--level')), 0, 'the ring rests when listening stops');
    mic.toggle.greet();
    assert.equal(mic.button.classList.contains('is-greeting'), true);

    // Under reduced motion the ring stays still.
    const still = make({ reducedMotion: true });
    still.toggle.setState('listening');
    still.toggle.setLevel(1);
    assert.equal(still.frames.length, 0);
    assert.equal(still.button.property('--level'), '0');

    // A server that cannot hear shows why and looks switched off, whatever was chosen.
    const reason = 'Hearing needs GEMINI_API_KEY in .env';
    const unset = make({ storage, status: { available: false, reason } });
    assert.deepEqual(unset.look(), ['unavailable', 'false', reason]);
    assert.equal(unset.button.getAttribute('aria-disabled'), 'true');
  } finally {
    globalThis.document = previous;
  }
});

test('a click starts or stops listening, keeps the choice on this device, and works when storage is blocked', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElementNS: () => fakeElement() };
  try {
    // Off starts; the choice is kept and the next page load finds it.
    const storage = memoryStorage();
    const first = make({ storage });
    assert.equal(first.toggle.wanted, false);
    first.button.click();
    assert.deepEqual([first.calls, storage.getItem('jet.hear'), first.toggle.wanted, first.button.getAttribute('aria-pressed')], [['start'], 'on', true, 'true']);
    assert.equal(first.button.getAttribute('data-state'), 'starting', 'the button answers at once, before the engine does');
    assert.equal(make({ storage }).toggle.wanted, true);

    // Listening stops, and off is remembered too.
    first.toggle.setState('listening');
    first.button.click();
    assert.deepEqual([first.calls, storage.getItem('jet.hear'), first.look(), first.said.at(-1)], [['start', 'stop'], null, ['off', 'false', 'Talk to Jet: off'], 'Jet is not listening']);
    assert.equal(make({ storage }).toggle.wanted, false);

    // Every state that is not listening starts again on a click, with the choice still on.
    for (const state of ['waitingForTouch', 'asleep', 'blocked', 'problem']) {
      const waiting = make({ storage });
      waiting.toggle.setState(state, 'why');
      waiting.button.click();
      assert.deepEqual(waiting.calls, ['start'], state);
    }
    const asking = make({ storage });
    asking.toggle.setState('starting');
    asking.button.click();
    assert.deepEqual(asking.calls, ['stop'], 'a click while the microphone is being asked for cancels it');

    // Storage that throws leaves the mic off, and the button still works.
    const blocked = make({ storage: blockedStorage });
    assert.equal(blocked.toggle.wanted, false);
    blocked.button.click();
    assert.deepEqual([blocked.calls, blocked.toggle.wanted], [['start'], true]);
    blocked.toggle.setState('listening');
    blocked.button.click();
    assert.deepEqual([blocked.calls, blocked.toggle.wanted], [['start', 'stop'], false]);

    // A server that cannot hear says why when pressed, and starts once an edited .env makes it able.
    const reason = 'Hearing needs GEMINI_API_KEY in .env';
    const unset = make({ status: { available: false, reason }, check: async () => ({ available: false, reason }) });
    await unset.button.click();
    assert.deepEqual([unset.calls, unset.said], [[], [reason]]);
    const fixed = make({ status: { available: false, reason }, check: async () => READY });
    await fixed.button.click();
    assert.deepEqual([fixed.calls, fixed.toggle.wanted, fixed.look()[1]], [['start'], true, 'true']);
  } finally {
    globalThis.document = previous;
  }
});
