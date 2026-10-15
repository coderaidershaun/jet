// A made-up bridge, so every part of the charts can be seen without an engine. It sends the same
// hello, catalog and tick lines as the real one, and only the charts' dev page imports it.

import { timeOfDay } from './model.js';

const SESSION = 3;
const SPIN_INTERVAL_US = 1_000_000;
const CAPACITY = 300;
const TICK_MS = 100;
const BASE_MID = 23_600_000;
const QUOTE_SCALE = 1e8;
const HOLE_LENGTH = 8;
const GAP_SLOT = CAPACITY / 2;
const FILL_EVERY = 20;
const HISTORY_STEPS = 10;
const DEFAULT_CEILINGS = { mid: 10, risk: 4 };

/** A small seeded random generator, so the dev page draws the same history on every load. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// The hole and the gap flag come back once per window length, so every window shows one of each.
const slotOf = (index) => index % CAPACITY;
const isHole = (index) => slotOf(index) < HOLE_LENGTH;
const hasGapBefore = (index) => slotOf(index) === GAP_SLOT;
const priceText = (halfTicks) => (halfTicks * 0.005).toFixed(halfTicks % 2 === 0 ? 2 : 3);
const quoteText = (value, decimals = 2) => (value / QUOTE_SCALE).toFixed(decimals);

/** Air above and below the extremes, so the line never runs along the border. */
function pad(low, high) {
  if (low === high) return { low: low - 1, high: high + 1 };
  const padding = Math.max(1, Math.floor(((high - low) * 5) / 100));
  return { low: low - padding, high: high + padding };
}

/** The first 1, 2 or 5 times a power of ten that gives no more values than `ceiling` allows. */
function niceStep(low, high, ceiling) {
  const limit = Math.max(ceiling, 5);
  for (let decade = 0; decade <= 15; decade += 1) {
    for (const multiple of [1, 2, 5]) {
      const step = multiple * 10 ** decade;
      if (Math.floor(high / step) - Math.ceil(low / step) + 1 <= limit) return step;
    }
  }
  return 0;
}

function niceValues(bounds, ceiling) {
  const step = ceiling === 0 ? 0 : niceStep(bounds.low, bounds.high, ceiling);
  if (step === 0) return { step, values: [] };
  const values = [];
  for (let value = Math.ceil(bounds.low / step) * step; value <= bounds.high; value += step) values.push(value);
  return { step, values };
}

function riskBounds(values) {
  let low = Math.min(0, ...values);
  let high = Math.max(0, ...values);
  if (high - low < QUOTE_SCALE) {
    const deficit = QUOTE_SCALE - (high - low);
    low -= Math.floor(deficit / 2);
    high += deficit - Math.floor(deficit / 2);
  }
  return pad(low, high);
}

/**
 * @param {{ nowMs: () => number, random: () => number, onLine: (line: object) => void,
 *           view: { chartMode: string, riskSeries: string } }} options
 */
export function createDevFeed({ nowMs, random, onLine, view }) {
  let generation = 1;
  let sequence = 0;
  let ceilings = DEFAULT_CEILINGS;
  let chartMode = view.chartMode;
  let riskSeries = view.riskSeries;
  let isViewPending = true;
  let isWholePending = true;
  let previousOpen = -Infinity;
  let mid = BASE_MID;
  let position = 0;
  let pnl = 0;
  let buckets = [];
  let riskBuckets = [];
  let fills = [];
  let newFills = [];

  const wallIndex = () => Math.floor((nowMs() * 1000) / SPIN_INTERVAL_US);

  function priceStep() {
    mid += Math.round((random() - 0.5) * 6);
  }

  function newBucket(index, steps) {
    const bucket = { i: index, o: mid, h: mid, l: mid, c: mid, gap: hasGapBefore(index) };
    for (let step = 0; step < steps; step += 1) {
      priceStep();
      updateBucket(bucket);
    }
    buckets.push(bucket);
    position = Math.max(-0.0004, Math.min(0.0004, position + (random() - 0.5) * 0.0001));
    const risk = { i: index };
    updateRisk(risk);
    riskBuckets.push(risk);
    if (index % FILL_EVERY === 0) {
      const offset = 2 * Math.ceil(random() * 3) * (random() < 0.5 ? -1 : 1);
      const side = (index / FILL_EVERY) % 2 === 0 ? 'buy' : 'sell';
      const fill = { i: index, ht: Math.round(mid / 2) * 2 + offset, side };
      fills.push(fill);
      newFills.push(fill);
    }
  }

  function updateBucket(bucket) {
    bucket.c = mid;
    bucket.h = Math.max(bucket.h, mid);
    bucket.l = Math.min(bucket.l, mid);
  }

  function updateRisk(risk) {
    pnl += (random() - 0.5) * 0.08;
    risk.e = Math.round(position * mid * 0.005 * QUOTE_SCALE);
    risk.p = Math.round(pnl * QUOTE_SCALE);
  }

  function buildHistory() {
    const newest = wallIndex();
    for (let index = newest - CAPACITY + 1; index <= newest; index += 1) {
      if (!isHole(index)) newBucket(index, HISTORY_STEPS);
    }
    newFills = [];
  }

  /** Opens the buckets the clock has moved past, and moves the price within the open one. */
  function advance() {
    const index = wallIndex();
    const open = buckets.at(-1);
    if (open !== undefined && index > open.i) {
      for (let next = open.i + 1; next <= index; next += 1) if (!isHole(next)) newBucket(next, 0);
    } else if (open?.i === index) {
      priceStep();
      updateBucket(open);
      updateRisk(riskBuckets.at(-1));
    }
  }

  const labelled = (bucket) => ({ ...bucket, cl: priceText(bucket.c), t: timeOfDay(bucket.i * SPIN_INTERVAL_US) });
  const riskLabelled = (risk) => ({ ...risk, el: quoteText(risk.e), pl: quoteText(risk.p) });

  function chartSection(span) {
    const visible = buckets.filter((bucket) => bucket.i >= span.first);
    const prices = [...visible.flatMap((bucket) => [bucket.l, bucket.h]), ...fills.map((fill) => fill.ht)];
    const bounds = pad(Math.min(...prices), Math.max(...prices));
    const sent = isWholePending ? visible : visible.filter((bucket) => bucket.i >= previousOpen);
    return {
      generation,
      capacity: CAPACITY,
      first: span.first,
      last: span.last,
      low: bounds.low,
      high: bounds.high,
      axis: niceValues(bounds, ceilings.mid).values.map((value) => ({ v: value, label: priceText(value) })),
      buckets: sent.map(labelled),
      fills: isWholePending ? fills : newFills,
      note: null,
      fillsCaption: fills.length > 0,
    };
  }

  function riskSection(span) {
    const visible = riskBuckets.filter((risk) => risk.i >= span.first);
    const sent = isWholePending ? visible : visible.filter((risk) => risk.i >= previousOpen);
    const series = { exposure: 'e', pnl: 'p' };
    const bounds = {};
    const axis = {};
    for (const [name, key] of Object.entries(series)) {
      bounds[name] = riskBounds(visible.map((risk) => risk[key]));
      const { step, values } = niceValues(bounds[name], ceilings.risk);
      const decimals = step === 0 ? 0 : Math.max(0, Math.ceil(-Math.log10(step / QUOTE_SCALE) - 1e-9));
      axis[name] = values.map((value) => ({ v: value, label: quoteText(value, decimals) }));
    }
    const value = riskBuckets.at(-1)[series[riskSeries]];
    const tone = value > 0 ? 'positive' : value < 0 ? 'negative' : 'text2';
    return {
      generation,
      series: riskSeries,
      latest: { text: quoteText(value), tone },
      bounds,
      axis,
      buckets: sent.map(riskLabelled),
      note: null,
    };
  }

  function emitTick() {
    advance();
    const newest = buckets.at(-1).i;
    const span = { first: newest + 1 - CAPACITY, last: newest };
    buckets = buckets.filter((bucket) => bucket.i >= span.first);
    riskBuckets = riskBuckets.filter((risk) => risk.i >= span.first);
    fills = fills.filter((fill) => fill.i >= span.first);
    sequence += 1;
    const tick = { kind: 'tick', session: SESSION, seq: sequence };
    if (isViewPending) tick.view = { instrument: 0, chartMode, riskSeries };
    tick.chart = chartSection(span);
    tick.risk = riskSection(span);
    onLine(tick);
    isViewPending = false;
    isWholePending = false;
    newFills = [];
    previousOpen = newest;
  }

  return {
    start() {
      onLine({ kind: 'hello', protocol: 1, bridge: 'dev-feed', tickMs: TICK_MS });
      onLine({ kind: 'catalog', session: SESSION, spinIntervalUs: SPIN_INTERVAL_US });
      buildHistory();
      emitTick();
      setInterval(emitTick, TICK_MS);
    },

    /** Answers the commands the charts send, on the next tick like the real bridge. */
    command(command) {
      if (command.cmd === 'chart_mode') {
        chartMode = command.mode;
        isViewPending = true;
      } else if (command.cmd === 'risk_series') {
        riskSeries = command.series;
        isViewPending = true;
      } else if (command.cmd === 'chart_ticks') {
        ceilings = { mid: command.mid, risk: command.risk };
      } else if (command.cmd === 'resync') {
        generation += 1;
        isWholePending = true;
      }
    },
  };
}
