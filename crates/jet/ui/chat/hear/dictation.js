// Puts heard words into the message field one at a time, the way Jet's own reply appears, and
// remembers whether the message may still send itself. While the user speaks, the browser's own
// live words show after the heard ones, and the heard words take their place as they land.

const STEP_MS = 35;

const upperFirst = (word) => word.charAt(0).toUpperCase() + word.slice(1);
const wordsOf = (text) => text.split(/\s+/).filter(Boolean);

/** Adds `text` after `current`, with one space between and a capital when it starts the message. */
function joined(current, text) {
  const joiner = current === '' || /\s$/.test(current) ? '' : ' ';
  return current + joiner + (current.trim() === '' ? upperFirst(text) : text);
}

/**
 * @param {{
 *   field: { value: string },
 *   composerView: { dictate: (text: string) => void, dictated: () => void },
 *   clock: { after: (fn: () => void, ms: number) => () => void },
 *   reducedMotion: () => boolean,
 * }} options   words always go after what the field holds; `dictated` is called once each time a burst of heard words has landed
 */
export function createDictation({ field, composerView, clock, reducedMotion }) {
  /** @type {string[]} */
  let queue = [];
  let cancelStep = null;
  let takenOver = false;
  /** The browser's latest live words of this turn. */
  let liveWords = [];
  /** How many heard words this turn has brought, so only the live words past them show. */
  let heardCount = 0;
  /** The live words showing, exactly as they stand at the end of the field with their joiner; empty when none show. */
  let tail = '';
  /** True after the live words left the field by hand (sent or cleared): the rest of the turn is dropped, or it would be sent twice. */
  let spent = false;

  function landOne() {
    composerView.dictate(joined(field.value, queue.shift()));
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

  /** The field without the live words. They are searched from the end, since the user may have typed after them. */
  function withoutTail() {
    const at = tail === '' ? -1 : field.value.lastIndexOf(tail);
    return at < 0 ? field.value : field.value.slice(0, at) + field.value.slice(at + tail.length);
  }

  /** Writes `base` followed by the live words that the heard words have not covered yet. */
  function write(base) {
    const unheard = liveWords.slice(heardCount).join(' ');
    const text = unheard === '' ? base : joined(base, unheard);
    tail = text.slice(base.length);
    composerView.dictate(text);
  }

  function withdraw() {
    if (tail === '') return;
    const text = withoutTail();
    tail = '';
    composerView.dictate(text);
  }

  const dictation = {
    /**
     * Takes the words of one heard utterance. With live words showing they take the place of those in one update;
     * otherwise the first lands at once and the rest follow, or all land at once when motion is reduced.
     */
    append(text) {
      if (spent) return;
      const words = wordsOf(text);
      if (words.length === 0) return;
      heardCount += words.length;
      if (tail !== '') {
        write(joined(withoutTail(), words.join(' ')));
        composerView.dictated();
      } else {
        queue.push(...words);
        if (reducedMotion()) dictation.flush();
        else if (cancelStep === null) step();
      }
    },

    /** Lands every word that is still waiting. */
    flush() {
      const waiting = queue.length > 0;
      cancelStep?.();
      cancelStep = null;
      while (queue.length > 0) landOne();
      if (waiting) composerView.dictated();
    },

    /** Shows the browser's live words after the heard ones, in place of the live words shown before. */
    showLive(text) {
      if (takenOver || spent) return;
      liveWords = wordsOf(text);
      if (tail === '' && liveWords.length <= heardCount) return;
      // Heard words still waiting go in first, or they would land after the live words.
      dictation.flush();
      write(withoutTail());
    },

    /** A turn starts or ends: its live words leave the field, and the next turn's heard words are counted from zero. */
    clearLive() {
      liveWords = [];
      heardCount = 0;
      spent = false;
      withdraw();
    },

    /** The person is editing the message: it keeps its heard words but will not send itself, and the live words leave. */
    takeOver() {
      takenOver = true;
      withdraw();
    },

    /** The field is empty again: the next message may send itself, and words for the old one are dropped. */
    reset() {
      // A message that sends itself loses its live words before it goes,
      // so live words still here were sent or cleared by hand.
      spent = tail !== '';
      takenOver = false;
      tail = '';
      drop();
    },

    /** True while the message may still send itself; a turn whose live words were sent or cleared by hand never does. */
    get autoSend() {
      return !takenOver && !spent;
    },

    /** True while words are still waiting to land. */
    get landing() {
      return queue.length > 0;
    },
  };
  return dictation;
}
