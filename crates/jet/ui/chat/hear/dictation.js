// Puts heard words into the message field one at a time, the way Jet's own reply appears, and
// remembers whether the message may still send itself.

const STEP_MS = 35;

const upperFirst = (word) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * @param {{
 *   field: { value: string },
 *   composerView: { dictate: (text: string) => void, dictated: () => void },
 *   clock: { after: (fn: () => void, ms: number) => () => void },
 *   reducedMotion: () => boolean,
 * }} options   words always go after what the field holds; `dictated` is called once each time a burst of words has landed
 */
export function createDictation({ field, composerView, clock, reducedMotion }) {
  /** @type {string[]} */
  let queue = [];
  let cancelStep = null;
  let autoSend = true;

  function landOne() {
    const word = queue.shift();
    const current = field.value;
    const joiner = current === '' || /\s$/.test(current) ? '' : ' ';
    composerView.dictate(current + joiner + (current.trim() === '' ? upperFirst(word) : word));
  }

  function step() {
    cancelStep = null;
    landOne();
    if (queue.length > 0) cancelStep = clock.after(step, STEP_MS);
    else composerView.dictated();
  }

  function drop() {
    cancelStep?.();
    cancelStep = null;
    queue = [];
  }

  const dictation = {
    /** Queues the words of one heard utterance; the first lands at once and the rest follow, or all land at once when motion is reduced. */
    append(text) {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length === 0) return;
      queue.push(...words);
      if (reducedMotion()) dictation.flush();
      else if (cancelStep === null) step();
    },

    /** Lands every word that is still waiting. */
    flush() {
      const waiting = queue.length > 0;
      cancelStep?.();
      cancelStep = null;
      while (queue.length > 0) landOne();
      if (waiting) composerView.dictated();
    },

    /** The person is editing the message: it keeps its words but will not send itself. */
    takeOver() {
      autoSend = false;
    },

    /** The field is empty again: the next message may send itself, and words for the old one are dropped. */
    reset() {
      autoSend = true;
      drop();
    },

    get autoSend() {
      return autoSend;
    },

    /** True while words are still waiting to land. */
    get landing() {
      return queue.length > 0;
    },
  };
  return dictation;
}
