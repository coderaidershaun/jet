// Sends each clip for its words and hands the words back in the order the clips were cut, however
// Google answers. A clip that fails twice, or is not answered in time, comes back without words.

import { realClock } from '../../clock.js';
import { WORDS_LATE_MS } from './endpointer.js';

const MOST_IN_FLIGHT = 2;
const RETRY_AFTER_MS = 400;
const FATAL_KINDS = new Set(['notConfigured', 'rejected']);

/**
 * @param {{
 *   transcribe: (pcm: Int16Array, options: { vocabulary: string[], signal: AbortSignal }) => Promise<{ text: string }>,
 *   vocabulary: () => string[],
 *   onWords: (words: { turnId: string, index: number, text: string, error?: { kind: string, message: string } }) => void,
 *   onFatal: (error: { kind: string, message: string }) => void,
 *   clock?: { after: (fn: () => void, ms: number) => () => void },
 * }} options   `transcribe` rejects with `{ kind, message }`; a refused key or a missing one is fatal, anything else is tried once more
 */
export function createUtterances({ transcribe, vocabulary, onWords, onFatal, clock = realClock }) {
  /** @type {{ pcm: Int16Array, turnId: string, index: number, status: 'queued' | 'fetching' | 'ready' | 'failed' | 'dropped', text: string, error?: object, retried: boolean, controller: AbortController, cancelTimers: Array<() => void> }[]} */
  let items = [];

  function drain() {
    while (items.length > 0 && (items[0].status === 'ready' || items[0].status === 'failed')) {
      const { turnId, index, text, error } = items.shift();
      onWords(error ? { turnId, index, text, error } : { turnId, index, text });
    }
  }

  function startQueued() {
    const fetching = items.filter((item) => item.status === 'fetching').length;
    const queued = items.filter((item) => item.status === 'queued');
    for (const item of queued.slice(0, MOST_IN_FLIGHT - fetching)) request(item);
  }

  function settle(item, status, fields) {
    item.cancelTimers.forEach((cancel) => cancel());
    item.cancelTimers = [];
    Object.assign(item, { status }, fields);
    drain();
    startQueued();
  }

  function request(item) {
    item.status = 'fetching';
    transcribe(item.pcm, { vocabulary: vocabulary(), signal: item.controller.signal }).then(
      ({ text }) => {
        if (item.status === 'fetching') settle(item, 'ready', { text });
      },
      (error) => {
        if (item.status !== 'fetching') return;
        if (FATAL_KINDS.has(error?.kind)) {
          stop();
          onFatal({ kind: error.kind, message: error.message });
        } else if (!item.retried) {
          item.retried = true;
          item.cancelTimers.push(clock.after(() => item.status === 'fetching' && request(item), RETRY_AFTER_MS));
        } else {
          settle(item, 'failed', { text: '', error });
        }
      },
    );
  }

  function stop() {
    for (const item of items) {
      item.status = 'dropped';
      item.cancelTimers.forEach((cancel) => cancel());
      item.controller.abort();
    }
    items = [];
  }

  return {
    /** Sends a clip for its words. `index` counts the turn's clips from zero. */
    enqueue(pcm, { turnId, index }) {
      const item = { pcm, turnId, index, status: 'queued', text: '', retried: false, controller: new AbortController(), cancelTimers: [] };
      item.cancelTimers.push(clock.after(() => {
        if (item.status !== 'queued' && item.status !== 'fetching') return;
        item.controller.abort();
        settle(item, 'failed', { text: '', error: { kind: 'late', message: 'The words took too long to come back.' } });
      }, WORDS_LATE_MS));
      items.push(item);
      startQueued();
    },

    /** Aborts every request and drops every answer still to come. */
    stop,
  };
}
