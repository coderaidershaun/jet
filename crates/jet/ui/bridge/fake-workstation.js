// A pretend polysim-bridge for the browser. It runs the pretend market on a clock and hands its
// lines to the page one at a time, the way the real feed streams them. It stays the feed
// whenever the page runs outside Tauri.

import { createFakeMarket } from './fake-market.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ now?: () => number, wait?: (ms: number) => Promise<void>, random?: () => number, tickMs?: number }} [options]
 * @returns {import('./workstation.js').WorkstationFeed}
 */
export function createFakeWorkstation({ now = Date.now, wait = sleep, random = Math.random, tickMs = 16 } = {}) {
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

  return {
    async start(workstation, onLine) {
      const run = { market: createFakeMarket({ now, random, workstation }), onLine };
      // The run counts as started before any line goes out, so the page can answer the hello with commands.
      current = run;
      emit(run, { kind: 'bridge', status: 'starting', detail: 'the pretend feed' });
      for (const line of run.market.open()) emit(run, line);
      loop(run);
    },

    async command(command) {
      const run = current;
      if (!run) throw { kind: 'io', message: 'the pretend feed is not running' };
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
