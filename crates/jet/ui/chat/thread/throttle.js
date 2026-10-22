// Decides when streamed text is turned into HTML. While a reply streams, the
// text can arrive far faster than it is worth rendering, and the renderer may
// answer out of order. So this renders at most every 50 ms with one trailing
// call, drops answers that were overtaken, and holds the first reveal back
// until Jet has reacted to its mood.

const RENDER_EVERY_MS = 50;

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
  let completion = null;

  function run() {
    cancelTimer = null;
    if (ended) return;
    if (clock.now() < notBefore) { schedule(); return; }
    if (completion) {
      const finish = completion;
      completion = null;
      ended = true;
      issued++;
      finish();
      return;
    }
    if (!dirty) return;
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
    /** Hold text and successful completion until an absolute monotonic deadline. */
    holdUntil(at) {
      notBefore = Math.max(notBefore, at);
      issued++;
      if (latest !== '') dirty = true;
      if (cancelTimer) cancelTimer();
      cancelTimer = null;
      if (dirty || completion) schedule();
    },

    /** Keep the final entry behind the same reveal hold as streamed text. */
    finish(done) {
      issued++;
      completion = done;
      if (cancelTimer) cancelTimer();
      cancelTimer = null;
      schedule();
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
      completion = null;
      issued++;
      if (cancelTimer) cancelTimer();
      cancelTimer = null;
    },
  };
}
