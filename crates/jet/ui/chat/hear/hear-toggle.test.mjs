import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHearToggle } from './hear-toggle.js';

/** Just enough of an element for the icon and the button. */
function fakeElement() {
  const attributes = new Map();
  const classes = new Set();
  const listeners = new Map();
  return {
    title: '',
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name),
    getAttribute: (name) => attributes.get(name) ?? null,
    append() {},
    replaceChildren() {},
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    addEventListener: (kind, listener) => listeners.set(kind, listener),
    click: () => listeners.get('click')(),
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

const READY = { available: true, reason: null };

function make({ storage = memoryStorage(), status = READY, check = async () => status } = {}) {
  const button = fakeElement();
  const said = [];
  const calls = [];
  const toggle = createHearToggle({
    button,
    storage,
    status,
    check,
    announce: (message) => said.push(message),
    onStart: () => calls.push('start'),
    onStop: () => calls.push('stop'),
  });
  const look = () => [button.getAttribute('data-state'), button.getAttribute('aria-pressed'), button.title];
  return { button, toggle, said, calls, look };
}

test('the mic shows every state with its tooltip and announces each change once', () => {
  const previous = globalThis.document;
  globalThis.document = { createElementNS: () => fakeElement() };
  try {
    const storage = memoryStorage();
    storage.setItem('jet.hear', 'on');
    const mic = make({ storage });
    assert.deepEqual(mic.look().slice(0, 2), ['off', 'true']);
    assert.deepEqual(mic.said, [], 'nothing is announced when the page loads');

    const table = [
      ['waitingForTouch', null],
      ['starting', null],
      ['listening', 'Jet is listening'],
      ['halfDuplexPause', null],
      ['listening', null],
      ['asleep', 'Listening paused'],
      ['listening', 'Jet is listening'],
      ['blocked', "Microphone blocked. Allow it in the browser's site settings, then click."],
      ['blocked', null],
      // The thread says why the mic stopped, so the mic does not say it a second time.
      ['problem', null],
      ['off', 'Jet is not listening'],
    ];
    for (const [state, announcement] of table) {
      const before = mic.said.length;
      mic.toggle.setState(state);
      assert.equal(mic.look()[0], state);
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

    // A problem to show while the mic runs, such as Google refusing clips, marks the mic and its tooltip until it clears.
    const marked = () => [mic.look()[2], mic.button.classList.contains('has-problem')];
    mic.toggle.setState('listening');
    mic.toggle.setProblem('Google refused the clip');
    assert.deepEqual(marked(), ['Google refused the clip', true]);
    mic.toggle.setState('off');
    assert.equal(marked()[1], false, 'a mic that is off shows no problem');
    mic.toggle.setState('listening');
    assert.deepEqual(marked(), ['Google refused the clip', true]);
    mic.toggle.setProblem(null);
    assert.equal(marked()[1], false);

    mic.toggle.greet();
    assert.equal(mic.button.classList.contains('is-greeting'), true);

    // A server that cannot hear shows why and looks switched off, whatever was chosen.
    const reason = 'Hearing needs GEMINI_API_KEY in .env';
    const unset = make({ storage, status: { available: false, reason } });
    assert.deepEqual(unset.look(), ['unavailable', 'false', reason]);
    assert.equal(unset.button.getAttribute('aria-disabled'), 'true');
  } finally {
    globalThis.document = previous;
  }
});

test('a click starts or stops listening, and keeps the choice on this device', async () => {
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
    assert.deepEqual([first.calls, storage.getItem('jet.hear'), first.look().slice(0, 2), first.said.at(-1)], [['start', 'stop'], null, ['off', 'false'], 'Jet is not listening']);
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
