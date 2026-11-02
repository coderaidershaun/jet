// Puts heard words into the spoken message forming at the end of the thread, one at a time, the way
// Jet's own reply appears, and remembers whether the message may still send itself. While the user
// speaks, the browser's own live words show after the heard ones, and the heard words take their
// place as they land. Once the person takes over, the words go to the message field instead.

const STEP_MS = 35;

const upperFirst = (word) => word.charAt(0).toUpperCase() + word.slice(1);
const wordsOf = (text) => text.split(/\s+/).filter(Boolean);

/** Adds `text` after `current`, with one space between and a capital when it starts the message. */
function joined(current, text) {
  const joiner = current === '' || /\s$/.test(current) ? '' : ' ';
  return current + joiner + (current.trim() === '' ? upperFirst(text) : text);
}

const beforeTyped = (spoken, typed) => (typed === '' || /^\s/.test(typed) ? spoken + typed : spoken + ' ' + typed);

/**
 * @param {{
 *   forming: { text: string, write: (text: string) => void, drop: () => void },
 *   field: { text: string, write: (text: string) => void },
 *   clock: { after: (fn: () => void, ms: number) => () => void },
 *   reducedMotion: () => boolean,
 * }} options   `forming` is the spoken message in the thread, and its `text` is empty when none forms
 */
export function createDictation({ forming, field, clock, reducedMotion }) {
  /** @type {string[]} */
  let queue = [];
  let cancelStep = null;
  let takenOver = false;
  /** The browser's latest live words of this turn. */
  let liveWords = [];
  /** How many heard words this turn has brought, so only the live words past them show. */
  let heardCount = 0;
  /** The live words showing, exactly as they stand at the end of the spoken message with their joiner; empty when none show. */
  let tail = '';
  /** True after the spoken message was taken to be sent: the rest of the turn is dropped, or it would be sent twice. */
  let spent = false;

  const target = () => (takenOver ? field : forming);

  function landOne() {
    const sink = target();
    sink.write(joined(sink.text, queue.shift()));
  }

  function step() {
    cancelStep = null;
    landOne();
    if (queue.length > 0) cancelStep = clock.after(step, STEP_MS);
  }

  function drop() {
    cancelStep?.();
    cancelStep = null;
    queue = [];
  }

  /** Lands every word that is still waiting. */
  function flush() {
    cancelStep?.();
    cancelStep = null;
    while (queue.length > 0) landOne();
  }

  /** The spoken message without the live words, which always stand at its end. */
  const withoutTail = () => forming.text.slice(0, forming.text.length - tail.length);

  /** A bubble never stands empty, so when no words are left the spoken message is dropped instead of written. */
  function show(text) {
    if (text === '') forming.drop();
    else forming.write(text);
  }

  /** Writes `base` followed by the live words that the heard words have not covered yet. */
  function write(base) {
    const unheard = liveWords.slice(heardCount).join(' ');
    const text = unheard === '' ? base : joined(base, unheard);
    tail = text.slice(base.length);
    show(text);
  }

  function withdraw() {
    if (tail === '') return;
    const text = withoutTail();
    tail = '';
    show(text);
  }

  const dictation = {
    /** A spoken turn opens and heard words are counted from zero; its message appears with its first words. */
    open() {
      // A take-over lasts while its words are in the field.
      if (field.text.trim() === '') takenOver = false;
      spent = false;
      liveWords = [];
      heardCount = 0;
    },

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
      } else {
        queue.push(...words);
        if (reducedMotion()) flush();
        else if (cancelStep === null) step();
      }
    },

    /** Shows the browser's live words after the heard ones, in place of the live words shown before. */
    showLive(text) {
      if (takenOver || spent) return;
      liveWords = wordsOf(text);
      if (tail === '' && liveWords.length <= heardCount) return;
      // Heard words still waiting go in first, or they would land after the live words.
      flush();
      write(withoutTail());
    },

    /** The turn ended with words to send: the live words leave and every heard word still waiting lands. */
    end() {
      withdraw();
      flush();
    },

    /** The turn was thrown away: its message and the words still waiting for it go. */
    discard() {
      drop();
      tail = '';
      if (!takenOver) forming.drop();
    },

    /**
     * The person is editing: the heard words move into the field before what they typed, and the message stops sending
     * itself. The live words are left out, since their heard words are still on the way.
     */
    takeOver() {
      if (takenOver) return;
      // SMELL: heard words still waiting to land go after what the person typed, so a key pressed while a burst appears
      // splits that burst around the key. Landing them first would keep the words in order.
      const spoken = withoutTail();
      tail = '';
      takenOver = true;
      forming.drop();
      if (spoken !== '') field.write(beforeTyped(spoken, field.text));
    },

    /** The spoken message was taken to be sent, live words and all, so the rest of the turn is dropped. */
    spend() {
      drop();
      tail = '';
      spent = true;
    },

    /** The field is empty again: the next words form a new message that may send itself, and words for the old one are dropped. */
    reset() {
      if (!takenOver) return;
      takenOver = false;
      drop();
    },

    /** True while the message may still send itself; a taken-over or hand-sent turn never does. */
    get autoSend() {
      return !takenOver && !spent;
    },
  };
  return dictation;
}
