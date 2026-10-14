// Decides when streamed text is turned into HTML. While a reply streams, the
// text can arrive far faster than it is worth rendering, and the renderer may
// answer out of order. So this renders at most every 50 ms with one trailing
// call, drops answers that were overtaken, and holds the first reveal back
// until Jet has reacted to its mood.

const RENDER_EVERY_MS = 50;
const MOOD_HOLD_MS = 300;

const realClock = {
  now: () => performance.now(),
  after(fn, ms) {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

/**
 * @param {{
 *   render: (text: string) => Promise<string>,
 *   paint: (html: string) => void,
 *   clock?: { now: () => number, after: (fn: () => void, ms: number) => () => void },
 * }} options
 */
export function createReveal({ render, paint, clock = realClock }) {
  let latest = '';
  let dirty = false;
  let ended = false;
  let issued = 0;
  let lastRenderAt = -Infinity;
  let notBefore = -Infinity;
  let cancelTimer = null;

  function run() {
    cancelTimer = null;
    if (ended || !dirty) return;
    dirty = false;
    lastRenderAt = clock.now();
    const mine = ++issued;
    render(latest).then(
      (html) => { if (mine === issued && !ended) paint(html); },
      (error) => console.warn('markdown could not be rendered, showing the last version:', error),
    );
  }

  function schedule() {
    if (cancelTimer || ended) return;
    const now = clock.now();
    const wait = Math.max(0, lastRenderAt + RENDER_EVERY_MS - now, notBefore - now);
    cancelTimer = clock.after(run, wait);
  }

  return {
    /** Jet's mood arrived: the first text waits while the clip starts. */
    mood() {
      notBefore = clock.now() + MOOD_HOLD_MS;
    },

    /** @param {string} fullText   everything received so far */
    text(fullText) {
      latest = fullText;
      dirty = true;
      schedule();
    },

    /** The reply is over; the final HTML comes from the finished entry. */
    end() {
      ended = true;
      issued++;
      if (cancelTimer) cancelTimer();
      cancelTimer = null;
    },
  };
}
