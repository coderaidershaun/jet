// Which engines can hear the user and speak Jet's replies, and which one does each: the one the user chose while it
// can, otherwise the first that can, so the mic or the speaker goes dark only when none of them can.

const LABELS = Object.freeze({ gemini: 'Gemini', browser: 'Browser', phonon2: 'Phonon-2', phonon: 'Phonon' });
const UNREACHED = Object.freeze({ available: false, reason: 'The voice could not be reached' });
const READY = Object.freeze({ available: true, reason: null });

/**
 * @typedef {{ ids: readonly string[], fallback: readonly string[], inBrowser: (scope: object) => boolean, noBrowser: string, verb: string, uses: string, button: string }} Way
 *   `ids` in the order the settings list them, `fallback` in the order they take over, `verb` what an engine does to
 *   the user, `uses` how the settings say which engine does it, and `button` the control that goes dark when none can
 */

/** @type {Way} */
export const HEARING = Object.freeze({
  ids: Object.freeze(['gemini', 'browser', 'phonon2']),
  fallback: Object.freeze(['gemini', 'phonon2', 'browser']),
  inBrowser: (scope) => 'SpeechRecognition' in scope || 'webkitSpeechRecognition' in scope,
  noBrowser: 'This browser has no speech recognition of its own. Try Chrome, Edge or Safari',
  verb: 'hear you',
  uses: 'hears you with',
  button: 'mic',
});

/** @type {Way} */
export const SPEAKING = Object.freeze({
  ids: Object.freeze(['gemini', 'browser', 'phonon']),
  fallback: Object.freeze(['gemini', 'phonon', 'browser']),
  inBrowser: (scope) => 'speechSynthesis' in scope && 'SpeechSynthesisUtterance' in scope,
  noBrowser: 'This browser has no voice of its own. Try Chrome, Edge or Safari',
  verb: 'speak to you',
  uses: 'speaks with',
  button: 'speaker',
});

export const engineLabel = (id) => LABELS[id] ?? id;

/**
 * @param {Way} way
 * @param {Record<string, { available: boolean, reason: string | null }> | undefined} server   what the server said of its
 *   engines, missing when it could not be reached
 * @param {object} [scope]   where the browser keeps its own speech engines
 * @returns {Record<string, { available: boolean, reason: string | null }>}
 */
export function enginesOf(way, server, scope = globalThis) {
  const browser = way.inBrowser(scope) ? READY : { available: false, reason: way.noBrowser };
  return Object.fromEntries(way.ids.map((id) => [id, id === 'browser' ? browser : server?.[id] ?? UNREACHED]));
}

/** The engine at work: the chosen one while it can, else the first of the fallback order that can; null when none can. */
export function engineInUse(way, chosen, engines) {
  return [chosen, ...way.fallback].find((id) => engines[id]?.available === true) ?? null;
}

/** What the mic or the speaker shows: it works while any engine can, and says why each one cannot when none can. */
export function buttonStatus(way, chosen, engines) {
  if (engineInUse(way, chosen, engines) !== null) return READY;
  const reasons = way.ids.map((id) => `${engineLabel(id)}: ${engines[id].reason ?? 'unavailable'}`);
  return { available: false, reason: `No engine can ${way.verb}. ${reasons.join('. ')}` };
}
