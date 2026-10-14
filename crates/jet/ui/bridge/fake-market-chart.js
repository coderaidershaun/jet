// Pure helpers for the chart and risk sections of the pretend market: the bucket clock, the
// backfilled history, what is sent when (append-only), and the axis labels. One list of buckets
// feeds both sections, since the chart and the risk chart share their clock and their window.

import { midText, priceText, timeText } from './fake-market-rows.js';

export const CAPACITY = 300;
const HISTORY = 120;
const MANTISSA = 1e8;
const MIN_RISK_SPAN = MANTISSA;
const MIN_PAD = 2;
const PRICE_PER_HALF_TICK = 0.005;

/** Nice tick values (1, 2 or 5 times a power of ten) between `low` and `high`, at most about `count` of them. */
function niceTicks(low, high, count, smallestStep) {
  if (count < 2 || !(high > low)) return [];
  const raw = (high - low) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(smallestStep, [1, 2, 5, 10].map((multiple) => multiple * power).find((candidate) => candidate >= raw));
  const ticks = [];
  for (let n = Math.ceil(low / step); n * step <= high; n += 1) ticks.push(Math.round(n * step * 1e8) / 1e8);
  return ticks;
}

const riskText = (mantissa) => (Math.abs(mantissa) < MANTISSA / 200 ? 0 : mantissa / MANTISSA).toFixed(2);

/**
 * @param {number} spinUs   the length of one bucket in microseconds
 */
export function createChartBook(spinUs) {
  const bucketAt = (ms) => Math.floor((ms * 1000) / spinUs);
  /** @type {{ i: number, o: number | null, h: number | null, l: number | null, c: number | null, gap: boolean, e: number, p: number }[]} */
  let buckets = [];
  let fills = [];
  let sentFills = 0;
  // What each section has already sent: the newest closed bucket, and the last body (to skip a repeat).
  const tracks = { chart: { closed: -1, key: '' }, risk: { closed: -1, key: '' } };

  const first = () => buckets[0].i;
  const chartBucket = (b) => ({ i: b.i, o: b.o, h: b.h, l: b.l, c: b.c, cl: b.gap ? null : midText(b.c), t: timeText((b.i * spinUs) / 1000), gap: b.gap });
  const riskBucket = (b) => ({ i: b.i, e: b.e, p: b.p, el: riskText(b.e), pl: riskText(b.p) });

  /** The buckets a section has not sent yet, plus the open one; all of them when `full`. */
  function unsent(track, full) {
    const open = buckets.length - 1;
    const wanted = full ? buckets : buckets.filter((b, n) => n === open || b.i > track.closed);
    track.closed = buckets.length > 1 ? buckets[open - 1].i : -1;
    return wanted;
  }

  /** Sends the body unless it repeats the last one; a full send always goes. */
  function send(track, full, body) {
    const key = JSON.stringify(body);
    if (!full && key === track.key) return undefined;
    track.key = key;
    return body;
  }

  function range() {
    const solid = buckets.filter((b) => !b.gap);
    if (solid.length === 0) return null;
    return { low: Math.min(...solid.map((b) => b.l)), high: Math.max(...solid.map((b) => b.h)) };
  }

  function riskBounds(field) {
    let low = Math.min(0, ...buckets.map((b) => b[field]));
    let high = Math.max(0, ...buckets.map((b) => b[field]));
    if (high - low < MIN_RISK_SPAN) {
      const extra = (MIN_RISK_SPAN - (high - low)) / 2;
      low = Math.floor(low - extra);
      high = Math.ceil(high + extra);
    }
    return { low, high };
  }

  const riskAxis = (bounds, count) => niceTicks(bounds.low / MANTISSA, bounds.high / MANTISSA, count, 0.01)
    .map((value) => ({ v: Math.round(value * MANTISSA), label: value.toFixed(2) }));

  return {
    /** Starts over with 120 closed buckets that end at the current mid, and the open one. Returns the pnl it ends on. */
    backfill({ nowMs, midHalf, position, random }) {
      const current = bucketAt(nowMs);
      const closes = new Array(HISTORY);
      let close = midHalf;
      for (let n = HISTORY - 1; n >= 0; n -= 1) {
        closes[n] = close;
        close += Math.round((random() - 0.5) * 6);
      }
      buckets = [];
      fills = [];
      sentFills = 0;
      tracks.chart = { closed: -1, key: '' };
      tracks.risk = { closed: -1, key: '' };
      let open = close;
      let pnl = 0;
      closes.forEach((c, n) => {
        const h = Math.max(open, c) + Math.floor(random() * 3);
        const l = Math.min(open, c) - Math.floor(random() * 3);
        buckets.push({ i: current - HISTORY + n, o: open, h, l, c, gap: false, e: Math.round(position * c * PRICE_PER_HALF_TICK * MANTISSA), p: Math.round(pnl * MANTISSA) });
        pnl += position * (c - open) * PRICE_PER_HALF_TICK + (random() - 0.5) * 0.02;
        open = c;
      });
      buckets.push({ i: current, o: midHalf, h: midHalf, l: midHalf, c: midHalf, gap: false, e: Math.round(position * midHalf * PRICE_PER_HALF_TICK * MANTISSA), p: Math.round(pnl * MANTISSA) });
      return pnl;
    },

    /** Moves the clock: closes the old bucket when a new one starts, and lets the open bucket follow the mid. */
    advance({ nowMs, midHalf, exposure, pnl, gap }) {
      const current = bucketAt(nowMs);
      const newest = buckets[buckets.length - 1];
      for (let i = Math.max(newest.i + 1, current - CAPACITY + 1); i <= current; i += 1) {
        const previous = buckets[buckets.length - 1];
        const start = previous.gap ? midHalf : previous.c;
        buckets.push({ i, o: gap ? null : start, h: gap ? null : start, l: gap ? null : start, c: gap ? null : start, gap, e: previous.e, p: previous.p });
      }
      const open = buckets[buckets.length - 1];
      if (!open.gap) {
        open.h = Math.max(open.h, midHalf);
        open.l = Math.min(open.l, midHalf);
        open.c = midHalf;
      }
      open.e = Math.round(exposure * MANTISSA);
      open.p = Math.round(pnl * MANTISSA);
      if (buckets.length > CAPACITY) {
        buckets.splice(0, buckets.length - CAPACITY);
        const kept = fills.filter((fill) => fill.i >= first());
        sentFills = Math.max(0, sentFills - (fills.length - kept.length));
        fills = kept;
      }
    },

    addFill(nowMs, halfTick, side) {
      fills.push({ i: bucketAt(nowMs), ht: halfTick, side });
    },

    /** Marks the risk section to be sent whole next time. */
    resendRisk() {
      tracks.risk.key = '';
      tracks.risk.closed = -1;
    },

    /** The chart section, or undefined when it would repeat the last one. */
    chart({ generation, full, axisCount }) {
      const track = tracks.chart;
      const wanted = unsent(track, full);
      const seen = range() ?? { low: buckets[buckets.length - 1].c ?? 0, high: buckets[buckets.length - 1].c ?? 0 };
      const pad = Math.max(MIN_PAD, Math.round((seen.high - seen.low) * 0.1));
      const low = seen.low - pad;
      const high = seen.high + pad;
      const newFills = full ? fills : fills.slice(sentFills);
      sentFills = fills.length;
      const axis = niceTicks(low / 2, high / 2, axisCount, 1).map((tick) => ({ v: tick * 2, label: priceText(tick) }));
      return send(track, full, {
        generation,
        capacity: CAPACITY,
        first: first(),
        last: first() + CAPACITY - 1,
        low,
        high,
        axis,
        buckets: wanted.map(chartBucket),
        fills: newFills,
        note: null,
        fillsCaption: fills.length > 0,
      });
    },

    /** The risk section for `series`, or undefined when it would repeat the last one. */
    risk({ generation, full, series, axisCount }) {
      const track = tracks.risk;
      const wanted = unsent(track, full);
      const bounds = { exposure: riskBounds('e'), pnl: riskBounds('p') };
      const latestMantissa = buckets[buckets.length - 1][series === 'exposure' ? 'e' : 'p'];
      const sign = Math.sign(latestMantissa);
      return send(track, full, {
        generation,
        series,
        latest: { text: riskText(latestMantissa), tone: sign > 0 ? 'positive' : sign < 0 ? 'negative' : 'text2' },
        bounds,
        axis: { exposure: riskAxis(bounds.exposure, axisCount), pnl: riskAxis(bounds.pnl, axisCount) },
        buckets: wanted.map(riskBucket),
        note: null,
      });
    },
  };
}
