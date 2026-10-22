// The mood words a reply may start with and the clip each one plays. A word
// with no clip only closes the spinner: an emotion exists only when it has an
// animation, and the others stay listed so the reply's words are all known.

/**
 * @typedef {object} Emotion
 * @property {string} clip        a key of the clip catalogue
 * @property {object} [options]   what the clip builder is given
 */

/** @type {Record<string, Emotion | null>} */
export const EMOTIONS = {
  neutral: null,
  happy: null,
  excited: null,
  thinking: null,
  curious: null,
  sorry: null,
  alert: null,
  annoyed: null,
  hello: { clip: 'hello' },
};
