// The mic button beside the speaker: whether the page listens. The choice belongs to the device, so
// it is kept in the browser. The button shows the state of the listening engine; the engine itself
// is started and stopped by whoever builds this.

import { icon } from '../../dom.js';

const KEY = 'jet.hear';
const NOT_AVAILABLE = 'Jet cannot hear right now';
const BLOCKED = "Microphone blocked. Allow it in the browser's site settings, then click.";
const TOOLTIPS = {
  off: 'Talk to Jet: off',
  waitingForTouch: 'Click anywhere to start listening',
  starting: 'Asking for the microphone…',
  listening: 'Listening',
  halfDuplexPause: 'Paused while Jet speaks',
  asleep: 'Listening paused after 10 quiet minutes. Click to listen again.',
  blocked: BLOCKED,
};
const ANNOUNCEMENTS = { off: 'Jet is not listening', listening: 'Jet is listening', asleep: 'Listening paused' };
/** A click while the mic is in one of these states switches it off; in any other it starts. */
const RUNNING_STATES = new Set(['starting', 'listening', 'halfDuplexPause']);
const EASE = 0.35;
const CLOSE_ENOUGH = 0.01;

/**
 * @param {{
 *   button: HTMLButtonElement,
 *   storage?: Storage | null,
 *   status: { available: boolean, reason: string | null },
 *   check: () => Promise<{ available: boolean, reason: string | null }>,
 *   announce: (message: string) => void,
 *   onStart: () => void,
 *   onStop: () => void,
 *   reducedMotion: () => boolean,
 *   requestFrame?: (fn: () => void) => unknown,
 * }} options   `status` is what the server said at the start; `check` asks again when the button is pressed while Jet cannot hear, so an edited `.env` needs no reload
 */
export function createHearToggle({ button, storage, status, check, announce, onStart, onStop, reducedMotion, requestFrame = (fn) => requestAnimationFrame(fn) }) {
  // Storage can be blocked, and then the choice lasts only until the page closes.
  const store = () => {
    try { return storage === undefined ? globalThis.localStorage : storage; } catch { return null; }
  };
  const read = () => {
    try { return store()?.getItem(KEY) === 'on'; } catch { return false; }
  };
  const write = (on) => {
    try {
      if (on) store()?.setItem(KEY, 'on');
      else store()?.removeItem(KEY);
    } catch { /* the choice is kept for this page only */ }
  };

  let wanted = read();
  let { available, reason } = status;
  let state = 'off';
  let stateReason = null;
  let level = 0;
  let easedLevel = 0;
  let easing = false;

  function tooltip() {
    if (!available) return reason ?? NOT_AVAILABLE;
    return stateReason ?? TOOLTIPS[state] ?? NOT_AVAILABLE;
  }

  function render() {
    button.setAttribute('data-state', available ? state : 'unavailable');
    button.setAttribute('aria-pressed', String(wanted && available));
    if (available) button.removeAttribute('aria-disabled');
    else button.setAttribute('aria-disabled', 'true');
    button.classList.toggle('has-problem', available && (state === 'blocked' || state === 'problem'));
    button.title = tooltip();
  }

  function paintLevel() {
    button.style.setProperty('--level', String(Number(easedLevel.toFixed(2))));
  }

  function ease() {
    if (state !== 'listening') { easing = false; return; }
    easedLevel += (level - easedLevel) * EASE;
    if (Math.abs(level - easedLevel) < CLOSE_ENOUGH) easedLevel = level;
    paintLevel();
    if (easedLevel === level) easing = false;
    else requestFrame(ease);
  }

  function setState(next, why) {
    const before = state;
    state = next;
    stateReason = why ?? null;
    if (next !== 'listening') { level = 0; easedLevel = 0; paintLevel(); }
    render();
    if (next === before) return;
    // Coming back from a pause for Jet's voice is not news, and the reply has just been announced.
    if (next === 'listening' && before === 'halfDuplexPause') return;
    if (next === 'blocked' || next === 'problem') announce(why ?? BLOCKED);
    else if (ANNOUNCEMENTS[next]) announce(ANNOUNCEMENTS[next]);
  }

  function begin() {
    wanted = true;
    write(true);
    setState('starting');
    onStart();
  }

  function end() {
    wanted = false;
    write(false);
    setState('off');
    onStop();
  }

  button.replaceChildren(icon('mic'));
  // The ring's own animations end on this button too, and must not cut the greeting short.
  button.addEventListener('animationend', (event) => { if (!event.pseudoElement) button.classList.remove('is-greeting'); });
  button.addEventListener('click', async () => {
    if (!available) {
      try {
        ({ available, reason } = await check());
      } catch (error) {
        console.warn('hearing could not be checked:', error);
      }
      render();
      if (available) begin();
      else announce(reason ?? NOT_AVAILABLE);
      return;
    }
    if (RUNNING_STATES.has(state)) end();
    else begin();
  });

  render();
  paintLevel();

  return {
    /** True when the person chose to talk to Jet, whether or not the server can hear. */
    get wanted() {
      return wanted;
    },

    get available() {
      return available;
    },

    get state() {
      return state;
    },

    /** True while the mic is on its way or on, for the tint of the pill. */
    get lit() {
      return available && RUNNING_STATES.has(state);
    },

    /** Shows the engine's state. @param {string} next @param {string} [why] the engine's words for a state that needs them */
    setState,

    /** The voice level from 0 to 1; the ring eases toward it, and stays still when motion is reduced. */
    setLevel(next) {
      if (reducedMotion() || state !== 'listening') return;
      level = next;
      if (easing) return;
      easing = true;
      requestFrame(ease);
    },

    /** The ring pulses while any clip still waits for its words. @param {number} count */
    setBusy(count) {
      button.classList.toggle('is-busy', count > 0);
    },

    /** One gentle pulse of the icon, for a mic that started on its own when the page loaded. */
    greet() {
      button.classList.add('is-greeting');
    },
  };
}
