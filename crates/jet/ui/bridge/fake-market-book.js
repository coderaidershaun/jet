// The pretend order book: a best bid and ask that wander, the size at each level, and the two
// quotes the pretend strategy keeps on it, with the ladder and summary sections that show them.
// A book is plain data; the functions here change it or describe it. Chance comes from the caller.

import { midText, priceText } from './fake-market-rows.js';

export const ORDER_QTY = 0.05;
export const ORDER_QTY_TEXT = ORDER_QTY.toFixed(5);

const FAR_EVERY_MS = 10000;
const FAR_FOR_MS = 3000;
const LOST_FOR_MS = 1000;
const MOVES_PER_MS = 2.5 / 1000;
const SPREAD_CHANGES_PER_MS = 0.5 / 1000;
const LOSSES_PER_MS = 1 / 20000;
const SIZE_DRIFT = 0.02;
const EMPTY_LEVEL = 0.15;
const SIZE_MAP_LIMIT = 4000;
const TICKS_PER_STEP = 3;
const QUOTE_OFFSET_TICKS = 2;
const REQUOTE_TICKS = 3;
const MAX_WANDER_TICKS = 200;
const OFF_THE_LADDER_ROWS = 3;

const ORDER_MARKS = {
  want: { order: null, want: ORDER_QTY_TEXT, ring: 'desired' },
  sent: { order: { qty: ORDER_QTY_TEXT, word: 'sent', tone: 'warning' }, want: ORDER_QTY_TEXT, ring: 'inflight' },
  live: { order: { qty: ORDER_QTY_TEXT, word: 'live', tone: 'selected' }, want: null, ring: 'confirmed' },
  lost: { order: { qty: ORDER_QTY_TEXT, word: 'lost', tone: 'invalid' }, want: null, ring: 'lost' },
};
const NO_MARKS = { order: null, want: null, ring: null };
const PILLS = {
  disconnected: { text: 'DISCONNECTED', tone: 'invalid' },
  awaiting: { text: 'AWAITING BOOK', tone: 'warning' },
};
const DASH = { text: '--', tone: 'text2' };
const UNIT_WORDS = { bps: 'basis points', ticks: 'ticks' };
const CHEVRON_DIGITS = { bps: 2, ticks: 0 };
const DELTA_DIGITS = { bps: 5, ticks: 1 };

const newQuote = () => ({ tick: null, state: 'want', age: 0, far: false, lostUntil: 0, id: 0 });

/** A book with the best bid at `startBid`, the best ask one tick above, and no quotes yet. */
export function newBook(startBid, now) {
  return {
    bid: startBid, ask: startBid + 1, startBid, sizes: new Map(), quotes: { ask: newQuote(), bid: newQuote() },
    far: null, farNumber: 0, nextFarAt: now + FAR_EVERY_MS, orderNumber: 0,
  };
}

/** The best bid tick plus the best ask tick, which is twice the mid in ticks. */
export const midHalf = (book) => book.bid + book.ask;

/** How many ticks one ladder row spans under a grouping (`{ unit: 'ticks', perBucket }` or `{ unit: 'bps', numerator, denominator }`). */
export function ticksPerBucket(book, grouping) {
  if (grouping.unit === 'ticks') return grouping.perBucket;
  return Math.max(1, Math.floor((midHalf(book) * grouping.numerator) / (20000 * grouping.denominator)));
}

/** Moves the book for `dt` ms: now and then both sides step one tick, or the spread changes. Returns the change of `midHalf`. */
export function moveBook(book, dt, random) {
  const before = midHalf(book);
  const roll = random();
  if (roll < dt * MOVES_PER_MS) {
    const wander = book.bid - book.startBid;
    const direction = Math.abs(wander) > MAX_WANDER_TICKS ? -Math.sign(wander) : random() < 0.5 ? -1 : 1;
    book.bid += direction;
    book.ask += direction;
  } else if (roll < dt * (MOVES_PER_MS + SPREAD_CHANGES_PER_MS)) {
    book.ask = book.bid + (book.ask - book.bid === 1 ? 2 : 1);
  }
  return midHalf(book) - before;
}

/**
 * Keeps one quote on each side near the touch. A quote that has to move goes want, sent, live over
 * a few frames; now and then a live one is lost for a second, and every ten seconds one side's
 * quote moves off the ladder for three. `onOrder(side, quote, word, tone)` hears each step.
 */
export function moveQuotes(book, { now, dt, rows, ticksEach, random, onOrder }) {
  for (const side of ['ask', 'bid']) {
    const quote = book.quotes[side];
    const far = book.far !== null && book.far.side === side && now < book.far.until;
    const touch = side === 'ask' ? book.ask : book.bid;
    const wanted = touch + (side === 'ask' ? 1 : -1) * (far ? (rows + OFF_THE_LADDER_ROWS) * ticksEach : QUOTE_OFFSET_TICKS);
    if (quote.tick === null || far !== quote.far || Math.abs(wanted - quote.tick) >= REQUOTE_TICKS) {
      book.orderNumber += 1;
      Object.assign(quote, { tick: wanted, state: 'want', age: 0, far, id: book.orderNumber });
      continue;
    }
    quote.age += 1;
    if (quote.state === 'want' && quote.age >= TICKS_PER_STEP) {
      Object.assign(quote, { state: 'sent', age: 0 });
      onOrder(side, quote, 'sent', 'warning');
    } else if (quote.state === 'sent' && quote.age >= TICKS_PER_STEP) {
      Object.assign(quote, { state: 'live', age: 0 });
      onOrder(side, quote, 'resting', 'selected');
    } else if (quote.state === 'live' && random() < dt * LOSSES_PER_MS) {
      Object.assign(quote, { state: 'lost', age: 0, lostUntil: now + LOST_FOR_MS });
      onOrder(side, quote, 'lost', 'invalid');
    } else if (quote.state === 'lost' && now >= quote.lostUntil) {
      Object.assign(quote, { state: 'want', age: 0 });
    }
  }
  if (now >= book.nextFarAt) {
    book.far = { side: book.farNumber % 2 === 0 ? 'ask' : 'bid', until: now + FAR_FOR_MS };
    book.farNumber += 1;
    book.nextFarAt = now + FAR_EVERY_MS;
  }
}

/** Which row of its side a quote sits on: negative inside the spread, past the last row when off the ladder. */
function quoteRow(book, side, ticksEach) {
  const quote = book.quotes[side];
  const away = side === 'ask' ? quote.tick - book.ask : book.bid - quote.tick;
  return Math.floor(away / ticksEach);
}

function publicSize(book, tick, random) {
  const known = book.sizes.get(tick);
  let size = known;
  if (known === undefined) size = random() < EMPTY_LEVEL ? 0 : 0.1 + random() * 2;
  else if (random() < SIZE_DRIFT) size = known === 0 ? 0 : known * (0.8 + random() * 0.4);
  if (book.sizes.size > SIZE_MAP_LIMIT) book.sizes.clear();
  book.sizes.set(tick, size);
  return size === 0 ? null : size.toFixed(5);
}

function distanceText(book, tick, unit, digits) {
  const mid = midHalf(book) / 2;
  const away = Math.abs(tick - mid);
  return (unit === 'bps' ? (away / mid) * 10000 : away).toFixed(digits[unit]);
}

/** How long the engine has been quiet, worded as polysim does: milliseconds under a second, then seconds with a tenth. */
const staleText = (ms) => 'STALE ' + (ms < 1000 ? ms + ' ms' : Math.floor(ms / 1000) + '.' + Math.floor((ms % 1000) / 100) + ' s');

/** The ladder: `rows` levels each side, the quotes marked on their rows, and a chevron for a quote beyond the last row. */
export function ladderSection(book, { status, staleMs, ticksEach, rows, unit, random }) {
  const rowsOf = (side) => Array.from({ length: rows }, (_, index) => {
    const tick = side === 'ask' ? book.ask + index * ticksEach : book.bid - index * ticksEach;
    const marks = quoteRow(book, side, ticksEach) === index ? ORDER_MARKS[book.quotes[side].state] : NO_MARKS;
    return { tick, price: priceText(tick), public: publicSize(book, tick, random), ...marks };
  });
  const chevron = (side) => (quoteRow(book, side, ticksEach) >= rows ? { text: distanceText(book, book.quotes[side].tick, unit, CHEVRON_DIGITS) } : null);
  return {
    status,
    pill: status === 'stale' ? { text: staleText(staleMs), tone: 'stale' } : (PILLS[status] ?? null),
    muted: status !== 'live',
    mid: { text: midText(midHalf(book)), tone: 'text' },
    midHalfTicks: midHalf(book),
    ticksPerBucket: ticksEach,
    rows,
    asks: rowsOf('ask'),
    bids: rowsOf('bid'),
    chevrons: { up: chevron('ask'), down: chevron('bid') },
  };
}

/** The summary band: how far each quote is from the mid, or `--` while the book is not live. */
export function summarySection(book, { unit, live }) {
  const delta = (side) => (live ? { text: distanceText(book, book.quotes[side].tick, unit, DELTA_DIGITS), tone: side } : DASH);
  return {
    captions: { bid: 'BID delta ' + unit, mid: 'MID', ask: 'ASK delta ' + unit },
    bid: delta('bid'),
    mid: { text: midText(midHalf(book)), tone: 'text' },
    ask: delta('ask'),
    hover: 'delta in ' + UNIT_WORDS[unit] + ' from mid, not a price',
  };
}
