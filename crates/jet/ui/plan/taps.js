// What the pane's one-tap controls remember between taps: which Cancel waits for its second tap, and the
// words of the last tap that failed, which stay on screen through every re-read until a later tap works.
// It also runs taps one after the other. Pure, with no DOM, so each rule is tested.

/** How long a first tap on Cancel waits for the second. */
export const CONFIRM_MS = 4000;

/** @typedef {{ armed: number | null, notice: string }} Taps */
export const idleTaps = Object.freeze({ armed: null, notice: '' });

/** A tap on Cancel: the first one only arms it, the second on the same check sends. */
export function pressCancel(taps, taskId) {
  if (taps.armed !== taskId) return { taps: Object.freeze({ ...taps, armed: taskId }), send: false };
  return { taps: Object.freeze({ ...taps, armed: null }), send: true };
}

export const disarm = (taps) => (taps.armed === null ? taps : Object.freeze({ ...taps, armed: null }));

/** A refusal or a lost connection, in one plain sentence. */
function reasonWords(error) {
  if (error?.kind === 'network') return 'Jet could not be reached.';
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  if (!message) return 'Jet did not say why.';
  return message.charAt(0).toUpperCase() + message.slice(1) + (/[.!?]$/.test(message) ? '' : '.');
}

/** How a tap ended. `error` is null when it worked, which clears an earlier failure. */
export function tapEnded(failure, error) {
  const notice = error === null ? '' : `${failure}. ${reasonWords(error)} Try again.`;
  return Object.freeze({ armed: null, notice });
}

/** Runs each job after the one before it has ended, so a tap made while another call runs waits its turn and is not lost. */
export function inOrder() {
  let last = Promise.resolve();
  return (job) => {
    const run = last.then(job);
    last = run.catch(() => {});
    return run;
  };
}
