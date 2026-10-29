// The speaker button at the right end of the message box: whether Jet speaks its replies. The
// choice belongs to the device, so it is kept in the browser and not on the server.

import { icon } from '../../dom.js';

const KEY = 'jet.voice';
const NOT_AVAILABLE = 'Jet cannot speak right now';

/**
 * @param {{
 *   button: HTMLButtonElement,
 *   storage?: Storage | null,
 *   status: { available: boolean, reason: string | null },
 *   check: () => Promise<{ available: boolean, reason: string | null }>,
 *   replying: () => boolean,
 *   announce: (message: string) => void,
 *   onChange: (on: boolean) => void,
 * }} options   `status` is what the server said at the start; `check` asks again when the button is pressed while Jet cannot speak, so an edited `.env` needs no reload
 */
export function createVoiceToggle({ button, storage, status, check, replying, announce, onChange }) {
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
  let speaking = false;
  let problem = null;
  const speaker = icon('speaker');
  const speakerWaves = icon('speakerWaves');

  const on = () => wanted && available;

  function tooltip() {
    if (!available) return reason ?? NOT_AVAILABLE;
    return problem ?? 'Speak replies: ' + (on() ? 'on' : 'off');
  }

  function render() {
    button.replaceChildren(on() ? speakerWaves : speaker);
    button.setAttribute('aria-pressed', String(on()));
    if (available) button.removeAttribute('aria-disabled');
    else button.setAttribute('aria-disabled', 'true');
    button.classList.toggle('is-speaking', on() && speaking);
    button.classList.toggle('has-problem', problem !== null);
    button.title = tooltip();
  }

  function turnOn() {
    wanted = true;
    write(true);
    render();
    onChange(true);
    announce(replying() ? 'Jet will speak from the next reply' : 'Jet will speak replies');
  }

  button.addEventListener('click', async () => {
    if (!available) {
      try {
        ({ available, reason } = await check());
      } catch (error) {
        console.warn('the voice could not be checked:', error);
      }
      render();
      if (available) turnOn();
      else announce(reason ?? NOT_AVAILABLE);
      return;
    }
    if (!wanted) {
      turnOn();
      return;
    }
    wanted = false;
    write(false);
    speaking = false;
    render();
    onChange(false);
    announce('Jet will stay quiet');
  });

  render();

  return {
    /** True when the person wants Jet to speak and the server can. */
    get on() {
      return on();
    },

    setSpeaking(isSpeaking) {
      speaking = isSpeaking;
      render();
    },

    /** The last voice request failed, with the reason to show; null once a clip plays again. @param {string | null} message */
    setProblem(message) {
      problem = message;
      render();
    },
  };
}
