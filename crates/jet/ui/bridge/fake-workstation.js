// A pretend polysim-bridge for the browser. It runs the pretend market on a clock and hands its
// lines to the page one at a time, the way the real feed streams them. With a tape it hands out a
// recording of the real bridge instead, over and over. It stays the feed whenever the page runs
// outside Tauri.

import { createFakeMarket } from './fake-market.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where the recording of the real bridge lives; relative to this file, so a page and a test both find it. */
export const TAPE_URL = new URL('./fixtures/polysim-tape.jsonl', import.meta.url);

/** The average gap between two tick lines in the recording. The bridge writes a tick only when a section changed, so this is slower than its 16 ms clock. */
export const REPLAY_TICK_MS = 84;

/** Fetches the recording's text. A missing file rejects, so the page falls back to the pretend market. */
export async function fetchTape() {
  const response = await fetch(TAPE_URL);
  if (!response.ok) throw new Error('fetching the recorded tape at ' + TAPE_URL.href + ' failed: HTTP ' + response.status);
  return response.text();
}

/** True for one whole JSON object with a string `kind`, the only lines the real feed hands to the page. */
function isBridgeLine(text) {
  try {
    return typeof JSON.parse(text)?.kind === 'string';
  } catch {
    return false;
  }
}

const isTick = (text) => JSON.parse(text).kind === 'tick';

/**
 * @param {{ now?: () => number, wait?: (ms: number) => Promise<void>, random?: () => number, tickMs?: number,
 *   loadTape?: (() => Promise<string>) | null }} [options]   `loadTape` gives the text of a recording to replay instead of the pretend market
 * @returns {import('./workstation.js').WorkstationFeed}
 */
export function createFakeWorkstation({ now = Date.now, wait = sleep, random = Math.random, tickMs = 16, loadTape = null } = {}) {
  /** The run that is going; a run that is no longer this one says nothing more. */
  let current = null;

  const emit = (run, line) => {
    try {
      run.onLine(line);
    } catch (error) {
      console.error('the listener for the "' + line.kind + '" line threw:', error);
    }
  };

  async function loop(run) {
    try {
      while (current === run) {
        await wait(tickMs);
        if (current !== run) return;
        for (const line of run.market.tick()) emit(run, line);
      }
    } catch (error) {
      console.error('the pretend feed stopped:', error);
      if (current === run) current = null;
    }
  }

  /** The recording's lines as text, or the problem when it cannot load or has no tick to pace it. */
  async function readTape() {
    let text;
    try {
      text = await loadTape();
    } catch (error) {
      return { problem: error };
    }
    const lines = text.split('\n').filter(isBridgeLine);
    return lines.some(isTick) ? { lines } : { problem: 'it has no tick line' };
  }

  /** Plays the recording again and again; each pass parses its lines afresh, so no pass shares an object with another. */
  async function replay(run, lines) {
    let detail = 'the recorded tape';
    while (current === run) {
      emit(run, { kind: 'bridge', status: 'starting', detail });
      detail = 'the recorded tape, from the start';
      for (const text of lines) {
        const line = JSON.parse(text);
        if (line.kind === 'tick') {
          await wait(REPLAY_TICK_MS);
          if (current !== run) return;
        }
        emit(run, line);
      }
    }
  }

  return {
    async start(workstation, onLine) {
      const run = { market: null, onLine };
      if (loadTape) {
        // The run is claimed before the tape loads, so a stop or a newer start during the load wins.
        current = run;
        const tape = await readTape();
        if (current !== run) return;
        if (tape.lines) {
          replay(run, tape.lines);
          return;
        }
        console.warn('the recorded tape cannot be replayed, so the pretend market runs:', tape.problem);
      }
      run.market = createFakeMarket({ now, random, workstation });
      // The run counts as started, and its market is open, before any line goes out, so the page
      // can answer any of these lines with commands.
      const opening = run.market.open();
      current = run;
      emit(run, { kind: 'bridge', status: 'starting', detail: 'the pretend feed' });
      for (const line of opening) emit(run, line);
      loop(run);
    },

    async command(command) {
      const run = current;
      if (!run) throw { kind: 'io', message: 'the pretend feed is not running' };
      // A run with no market is loading a tape or replaying one, and a recording cannot answer.
      if (!run.market) return;
      const lines = run.market.apply(command);
      // The real feed answers later too, never inside the caller's own call.
      queueMicrotask(() => {
        if (current === run) for (const line of lines) emit(run, line);
      });
    },

    async stop() {
      current = null;
    },
  };
}
