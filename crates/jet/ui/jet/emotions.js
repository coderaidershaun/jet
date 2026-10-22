/**
 * @typedef {object} Emotion
 * @property {string} clip        a key of the clip catalogue
 * @property {object} [options]   what the clip builder is given
 */

/** @type {Record<string, Emotion | null>} */
export const EMOTIONS = {
  neutral: null,
  hello: { clip: 'hello' },
  insulted: { clip: 'insulted' },
};
