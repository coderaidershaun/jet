// The browser's own speech recognition, used only to show the user's words while they speak.
// Gemini's heard words take their place as they land.
// Browser only: there is no test for it, so it is kept short.

const FIRST_RETRY_MS = 300;
const LONGEST_RETRY_MS = 5000;
/** Errors that will not go away by trying again. */
const REFUSALS = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported']);
/** An error that only means nobody is talking, so there is nothing to wait for. */
const RESTART_AT_ONCE = new Set(['no-speech']);

/**
 * @param {{ onWords: (text: string) => void }} options   `onWords` gets the words since the last drop each time they change
 * @returns {{ supported: boolean, start: () => void, stop: () => void, dropFinished: () => void, dropAll: () => void }}
 *   `supported` is false when the browser has no recognizer; `start` and `stop` say whether the recognizer is wanted;
 *   `dropFinished` forgets the words already final, and `dropAll` all of them
 */
export function createLiveWords({ onWords }) {
  const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
  if (!Recognition) return { supported: false, start() {}, stop() {}, dropFinished() {}, dropAll() {} };

  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.lang = navigator.language;

  let wanted = false;
  let running = false;
  let refused = false;
  let retryMs = 0;
  let retryTimer = null;
  let results = [];
  let droppedCount = 0;

  function begin() {
    retryTimer = null;
    if (!wanted || running || refused) return;
    // A new session numbers its results from zero again.
    results = [];
    droppedCount = 0;
    try {
      recognition.start();
      running = true;
    } catch {
      // Live words are only an extra, so a recognizer that cannot start is given up on quietly.
      refused = true;
    }
  }

  recognition.onresult = (event) => {
    retryMs = 0;
    results = event.results;
    onWords(Array.from(results).slice(droppedCount).map((result) => result[0].transcript).join(' '));
  };

  recognition.onerror = (event) => {
    // Stopping the recognizer on purpose also ends in an 'aborted' error, which is no reason to wait longer.
    if (!wanted) return;
    if (REFUSALS.has(event.error)) {
      refused = true;
    } else if (RESTART_AT_ONCE.has(event.error)) {
      // Chrome ends a quiet session with 'no-speech' every few seconds. Waiting longer each time
      // would leave the recognizer off when the person starts to speak.
      retryMs = 0;
    } else {
      retryMs = Math.min(LONGEST_RETRY_MS, Math.max(FIRST_RETRY_MS, retryMs * 2));
    }
  };

  // Chrome ends a session by itself now and then, so a recognizer that is still wanted starts again.
  recognition.onend = () => {
    running = false;
    if (wanted && !refused) retryTimer = setTimeout(begin, retryMs);
  };

  return {
    supported: true,

    start() {
      wanted = true;
      if (retryTimer === null) begin();
    },

    stop() {
      wanted = false;
      clearTimeout(retryTimer);
      retryTimer = null;
      if (running) recognition.abort();
    },

    dropFinished() {
      while (droppedCount < results.length && results[droppedCount].isFinal) droppedCount++;
    },

    dropAll() {
      droppedCount = results.length;
    },
  };
}
