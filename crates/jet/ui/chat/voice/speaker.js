// Jet's voice from the browser's own speech synthesis, for a server with no voice of its own. It gives the spoken
// reveal the two parts that the server's voice gives it: a clip for each piece of a reply, and a player that sounds
// each clip at its time. The browser never says how long it will talk, so a clip's length is guessed from its letters.

import { realClock } from '../clock.js';
import { withoutCues } from './segment.js';

const LETTERS_PER_SECOND = 15;

/** The words of a piece of Markdown, without the marks that a voice would read out. */
function plainWords(markdown) {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-+*]|\d+\.)\s+/gm, '')
    .replace(/[*_`~#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {{ synth?: SpeechSynthesis, Utterance?: typeof SpeechSynthesisUtterance, cues?: import('./segment.js').Cue[], clock?: { now: () => number, after: (fn: () => void, ms: number) => () => void } }} [options]
 */
export function createBrowserSpeaker({ synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance, cues = [], clock = realClock } = {}) {
  /** The clips waiting for their time. */
  const waiting = new Set();
  let unlocked = false;
  const now = () => clock.now() / 1000;

  const player = {
    /** Some browsers speak only once a click or a key press has spoken first, so an empty phrase is said then. */
    unlock() {
      if (unlocked || !synth) return;
      unlocked = true;
      synth.speak(new Utterance(''));
    },
    ready: () => Boolean(synth),
    now,
    outputLatency: () => 0,

    /** @param {{ words: string }} clip @param {number} at   seconds on `now`'s clock */
    play(clip, at) {
      const cancel = clock.after(() => {
        waiting.delete(cancel);
        synth.speak(new Utterance(clip.words));
      }, Math.max(0, (at - now()) * 1000));
      waiting.add(cancel);
      return { start: at, end: at + clip.words.length / LETTERS_PER_SECOND };
    },
    audible: () => synth?.speaking === true,
    // The browser cannot turn its voice down while it talks, so a person who speaks over Jet is not ducked.
    duck() {},
    unduck() {},
    silence() {
      for (const cancel of waiting) cancel();
      waiting.clear();
      synth?.cancel();
    },
  };

  return {
    player,
    /** A clip of the words; its `byteLength` is 0 when there is nothing to say, as an empty sound is. */
    speak: async (markdown) => {
      const words = plainWords(withoutCues(markdown, cues));
      return { byteLength: words.length, words };
    },
  };
}
