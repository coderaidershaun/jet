// The pretend market behind the pretend workstation feed: a book that wanders, a strategy that
// quotes on it, and every line and section polysim-bridge would send about them. It is pure and
// synchronous: it reads time and chance only from what it is given, so the same inputs make the
// same lines. Whoever runs the market decides when `tick` happens.

import { ORDER_QTY, ORDER_QTY_TEXT, ladderSection, midHalf, moveBook, moveQuotes, newBook, summarySection, ticksPerBucket } from './fake-market-book.js';
import { createChartBook } from './fake-market-chart.js';
import { BPS_GROUPINGS, INSTRUMENTS, LEVELS, SPIN_US, TICK_GROUPINGS, catalogLine, helloLine, lifecycleLine, linkLine } from './fake-market-lines.js';
import {
  FEATURE_NAMES, accountSection, createChannels, createFeatures, fillRow, latencySection, orderRow, priceText, systemRow, tradeRow,
} from './fake-market-rows.js';

const PRETEND_PEER = '127.0.0.1:9311';
const SYSTEM_BACKFILL = ['bridge started', 'engine link opened', 'handshake done', 'catalog received', 'book snapshot loaded', 'risk gate armed', 'strategy loaded', 'feeds subscribed', 'clock in sync'];
const BACKFILL_ROWS = 10;

const CONNECTING_MS = 300;
const STARTING_MS = 1000;
const AWAITING_MS = 500;
const STALE_STARTS_AT_MS = 850;
const LATENCY_EVERY_MS = 250;
const FILL_EVERY_MS = 8000;
const TRADES_PER_MS = 5 / 1000;
const ASSERT_TICKS = 10;
const FILL_QTY = 0.01;
const PRICE_PER_HALF_TICK = 0.005;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const withUnit = (grouping, unit) => ({ unit, ...grouping });

/**
 * @param {{ now: () => number, random: () => number, workstation: import('./workstation.js').WorkstationSettings }} options
 *   `now` is ms since the Unix epoch and `random` is in [0, 1)
 * @returns {{ open: () => object[], tick: () => object[], apply: (command: object) => object[] }}
 *   `open` must run first; each call returns the lines to send, in order
 */
export function createFakeMarket({ now, random, workstation }) {
  const peers = [...workstation.links, PRETEND_PEER];
  /** Everything one run knows. `open` replaces it. */
  let s = null;

  const instrument = () => INSTRUMENTS[s.view.instrument];
  const midPrice = () => midHalf(s.book) * PRICE_PER_HALF_TICK;
  const onPretendPeer = () => peers[s.peerIndex] === PRETEND_PEER;
  const connection = (t) => (t - s.sessionAt < CONNECTING_MS ? 'connecting' : onPretendPeer() ? 'stale' : 'live');
  const phase = (t) => (t - s.sessionAt < STARTING_MS ? 'starting' : 'ready');
  const grouping = () => s.groupings[s.view.domUnit];
  const rowCount = () => Math.max(1, Math.min(s.view.domLevels, s.fit ?? s.view.domLevels));
  const remember = (line) => {
    s.sent[line.kind] = JSON.stringify(line);
    return line;
  };

  const link = (t) => linkLine({ peers, peerIndex: s.peerIndex, session: s.session, connection: connection(t), phase: phase(t), running: s.running, control: s.control });
  const lifecycle = (t) => lifecycleLine({ session: s.session, phase: phase(t) });
  const catalog = () => catalogLine({ session: s.session, strategyId: workstation.strategyId, peer: peers[s.peerIndex] });

  function ladderStatus(t) {
    if (connection(t) === 'connecting') return 'disconnected';
    if (t < s.awaitingUntil) return 'awaiting';
    return onPretendPeer() ? 'stale' : 'live';
  }

  function ladderNow(t) {
    return ladderSection(s.book, {
      status: ladderStatus(t),
      staleMs: Math.round(STALE_STARTS_AT_MS + t - s.awaitingUntil),
      ticksEach: ticksPerBucket(s.book, grouping()),
      rows: rowCount(),
      unit: s.view.domUnit,
      random,
    });
  }

  function accountNow(t) {
    const word = (side) => (s.book.quotes[side].state === 'want' ? null : s.book.quotes[side].state);
    return accountSection({
      base: instrument().base, quote: instrument().quote, position: s.position, cash: s.cash, midPrice: midPrice(), orderQty: ORDER_QTY,
      orders: { bid: word('bid'), ask: word('ask') }, elapsedMs: t - s.openedAt,
    });
  }

  const viewSection = () => ({
    instrument: s.view.instrument,
    chartMode: s.view.chartMode,
    domUnit: s.view.domUnit,
    domGrouping: grouping(),
    domLevels: s.view.domLevels,
    riskSeries: s.view.riskSeries,
  });

  function recordFill(at, side, tick) {
    s.channels.add('fills', fillRow(at, side, priceText(tick), FILL_QTY.toFixed(5)));
    s.chart.addFill(at, tick * 2, side.toLowerCase());
  }

  /** The book, the quotes, the chart and the rows start over, as when an engine is attached. */
  function rebuild(t) {
    const { startBid, position, cash, base } = instrument();
    s.book = newBook(startBid, t);
    s.position = position;
    s.cash = cash;
    s.pnl = s.chart.backfill({ nowMs: t, midHalf: midHalf(s.book), position, random });
    s.channels.clear();
    SYSTEM_BACKFILL.forEach((text, n) => s.channels.add('system', systemRow(t - (SYSTEM_BACKFILL.length + 1 - n) * 1500, text)));
    s.channels.add('system', systemRow(t, 'engine ready', 'positive', 'engine ready for ' + base));
    for (let n = 0; n < BACKFILL_ROWS; n += 1) {
      const ago = BACKFILL_ROWS - n;
      const side = random() < 0.5 ? 'BUY' : 'SELL';
      const tick = s.book.bid - (side === 'BUY' ? 1 : -2) + Math.round((random() - 0.5) * 6);
      s.channels.add('orders', orderRow(t - ago * 1100, side, 'resting #' + (1000 + n).toString(16) + '  ' + ORDER_QTY_TEXT + ' @ ' + priceText(tick)));
      s.channels.add('trades', tradeRow(t - ago * 700, side, priceText(tick), (FILL_QTY * (1 + Math.floor(random() * 5))).toFixed(5)));
      recordFill(t - ago * 11000, side, tick);
    }
  }

  function newRun(t) {
    return {
      openedAt: t, sessionAt: t, session: 1, generation: 1, seq: 0, peerIndex: 0, awaitingUntil: t + AWAITING_MS,
      view: { instrument: 0, chartMode: 'line', domUnit: 'bps', domLevels: LEVELS.default, riskSeries: 'exposure' },
      groupings: { bps: withUnit(BPS_GROUPINGS[1], 'bps'), ticks: withUnit(TICK_GROUPINGS[0], 'ticks') },
      fit: null, axisCount: { mid: 0, risk: 0 }, paused: false, everything: true, running: true, control: null,
      book: null, position: 0, cash: 0, pnl: 0, fillNumber: 0, nextFillAt: t + FILL_EVERY_MS,
      lastTickAt: t, lastSpin: Math.floor((t * 1000) / SPIN_US), latency: null, lastLatencyAt: -Infinity,
      channels: createChannels(), features: createFeatures(FEATURE_NAMES, t, random), chart: createChartBook(SPIN_US), sent: {},
    };
  }

  function orderEvent(t) {
    return (side, quote, word, tone) => {
      const text = word + ' #' + quote.id.toString(16).padStart(4, '0') + '  ' + ORDER_QTY_TEXT + ' @ ' + priceText(quote.tick);
      s.channels.add('orders', orderRow(t, side === 'bid' ? 'BUY' : 'SELL', text, tone));
    };
  }

  function trade(t, dt) {
    if (random() < dt * TRADES_PER_MS) {
      const side = random() < 0.5 ? 'BUY' : 'SELL';
      const tick = side === 'BUY' ? s.book.ask : s.book.bid;
      s.channels.add('trades', tradeRow(t, side, priceText(tick), (FILL_QTY * (1 + Math.floor(random() * 9))).toFixed(5)));
    }
    if (t >= s.nextFillAt) {
      const side = s.fillNumber % 2 === 0 ? 'BUY' : 'SELL';
      const tick = s.book.quotes[side === 'BUY' ? 'bid' : 'ask'].tick;
      s.fillNumber += 1;
      s.nextFillAt = t + FILL_EVERY_MS;
      s.position += side === 'BUY' ? FILL_QTY : -FILL_QTY;
      s.cash += (side === 'BUY' ? -FILL_QTY : FILL_QTY) * tick * 0.01;
      recordFill(t, side, tick);
    }
  }

  /** A full snapshot goes out only when it differs from the last one sent, or when everything is resent. */
  function snapshot(name, value) {
    const key = JSON.stringify(value);
    if (!s.everything && s.sent[name] === key) return undefined;
    s.sent[name] = key;
    return value;
  }

  function stepWorld(t) {
    const dt = t - s.lastTickAt;
    s.lastTickAt = t;
    if (s.control && !s.control.applied && (s.control.ticksLeft -= 1) <= 0) {
      s.control.applied = true;
      s.running = s.control.state === 'running';
    }
    s.pnl += s.position * moveBook(s.book, dt, random) * PRICE_PER_HALF_TICK;
    moveQuotes(s.book, { now: t, dt, rows: rowCount(), ticksEach: ticksPerBucket(s.book, grouping()), random, onOrder: orderEvent(t) });
    if (ladderStatus(t) === 'live') trade(t, dt);
    const spin = Math.floor((t * 1000) / SPIN_US);
    if (spin !== s.lastSpin) {
      s.lastSpin = spin;
      s.features.spin(t);
    }
    if (t - s.lastLatencyAt >= LATENCY_EVERY_MS) {
      s.lastLatencyAt = t;
      s.latency = latencySection(random);
    }
    s.chart.advance({ nowMs: t, midHalf: midHalf(s.book), exposure: s.position * midPrice(), pnl: s.pnl, gap: ladderStatus(t) === 'stale' });
  }

  function tickLines(t) {
    const lines = [];
    for (const line of [link(t), lifecycle(t)]) if (JSON.stringify(line) !== s.sent[line.kind]) lines.push(remember(line));
    const everything = s.everything;
    const sections = {
      view: snapshot('view', viewSection()),
      ladder: snapshot('ladder', ladderNow(t)),
      summary: snapshot('summary', summarySection(s.book, { unit: s.view.domUnit, live: ladderStatus(t) === 'live' })),
      account: snapshot('account', accountNow(t)),
      features: snapshot('features', s.features.section(t)),
      channels: s.channels.section(everything),
      latency: snapshot('latency', s.latency),
      chart: s.chart.chart({ generation: s.generation, full: everything, axisCount: s.axisCount.mid }),
      risk: s.chart.risk({ generation: s.generation, full: everything, series: s.view.riskSeries, axisCount: s.axisCount.risk }),
      gaps: snapshot('gaps', { books: 0, events: 0 }),
    };
    const present = Object.entries(sections).filter(([, section]) => section !== undefined);
    if (present.length > 0) {
      s.seq += 1;
      s.everything = false;
      lines.push({ kind: 'tick', session: s.session, seq: s.seq, ...Object.fromEntries(present) });
    }
    return lines;
  }

  const bump = () => {
    s.generation += 1;
    s.everything = true;
  };

  /** Each command returns the lines to send at once, or null when the bridge would ignore it. */
  const commands = {
    select({ instrument: id }, t) {
      if (!INSTRUMENTS[id]) return null;
      s.view.instrument = id;
      s.awaitingUntil = t + AWAITING_MS;
      rebuild(t);
      bump();
      return [];
    },
    chart_mode({ mode }) {
      if (mode !== 'line' && mode !== 'candles') return null;
      s.view.chartMode = mode;
      return [];
    },
    dom_unit({ unit }) {
      if (unit !== 'ticks' && unit !== 'bps') return null;
      s.view.domUnit = unit;
      return [];
    },
    dom_grouping(command) {
      const found = command.unit === 'bps'
        ? BPS_GROUPINGS.find((g) => g.numerator === command.numerator && g.denominator === command.denominator)
        : command.unit === 'ticks' && TICK_GROUPINGS.find((g) => g.perBucket === command.perBucket);
      if (!found) return null;
      s.groupings[command.unit] = withUnit(found, command.unit);
      s.view.domUnit = command.unit;
      return [];
    },
    dom_levels({ levels }) {
      if (!Number.isFinite(levels)) return null;
      s.view.domLevels = clamp(Math.round(levels), LEVELS.min, LEVELS.max);
      return [];
    },
    dom_fit({ rows }) {
      if (!Number.isFinite(rows)) return null;
      s.fit = Math.max(1, Math.round(rows));
      return [];
    },
    chart_ticks({ mid, risk }) {
      if (!Number.isFinite(mid) || !Number.isFinite(risk)) return null;
      s.axisCount = { mid: Math.max(0, Math.floor(mid)), risk: Math.max(0, Math.floor(risk)) };
      return [];
    },
    risk_series({ series }) {
      if (series !== 'exposure' && series !== 'pnl') return null;
      s.view.riskSeries = series;
      s.chart.resendRisk();
      return [];
    },
    assert({ state }, t) {
      if (state !== 'running' && state !== 'idle') return null;
      s.control = { state, ticksLeft: ASSERT_TICKS, applied: false };
      return [remember(link(t))];
    },
    next_peer(_, t) {
      s.peerIndex = (s.peerIndex + 1) % peers.length;
      s.session += 1;
      s.sessionAt = t;
      s.awaitingUntil = t + AWAITING_MS;
      s.control = null;
      rebuild(t);
      bump();
      return [remember(link(t)), remember(lifecycle(t)), catalog()];
    },
    resync() {
      bump();
      return [catalog()];
    },
    pause() {
      s.paused = true;
      return [];
    },
    resume() {
      s.paused = false;
      bump();
      return [catalog()];
    },
  };

  return {
    open() {
      const t = now();
      s = newRun(t);
      rebuild(t);
      return [helloLine(), remember(link(t)), remember(lifecycle(t)), catalog()];
    },

    tick() {
      if (s.paused) return [];
      const t = now();
      stepWorld(t);
      return tickLines(t);
    },

    apply(command) {
      const t = now();
      const lines = Object.hasOwn(commands, command?.cmd) ? commands[command.cmd](command, t) : null;
      if (lines === null) return [];
      const { cmd, ...rest } = command;
      const detail = Object.entries(rest).map(([key, value]) => key + '=' + value).join(' ');
      s.channels.add('system', systemRow(t, (cmd + ' ' + detail).trim(), 'text', JSON.stringify(command)));
      return lines;
    },
  };
}
