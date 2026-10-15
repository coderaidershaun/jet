// The pretend market behind the pretend workstation feed: a book that wanders, a strategy that
// quotes on it, and every line and section polysim-bridge would send about them. It is pure and
// synchronous: it reads time and chance only from what it is given, so the same inputs make the
// same lines. Whoever runs the market decides when `tick` happens.

import { ORDER_QTY, ORDER_QTY_TEXT, ladderSection, midHalf, moveBook, moveQuotes, newBook, summarySection, ticksPerBucket } from './fake-market-book.js';
import { createChartBook } from './fake-market-chart.js';
import { BPS_GROUPINGS, INSTRUMENTS, LEVELS, SPIN_US, TICK_GROUPINGS, catalogLine, helloLine, lifecycleLine, linkLine } from './fake-market-lines.js';
import {
  FEATURE_NAMES, PRICE_PER_HALF_TICK, PRICE_PER_TICK, accountSection, createChannels, createFeatures, fillRow, latencySection, orderRow, priceText, systemRow, tradeRow,
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
const GAP_EVERY_MS = 45_000;
const ASSERT_TICKS = 10;
const FILL_QTY = 0.01;

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
  let run = null;

  const instrument = () => INSTRUMENTS[run.view.instrument];
  const midPrice = () => midHalf(run.book) * PRICE_PER_HALF_TICK;
  const onPretendPeer = () => peers[run.peerIndex] === PRETEND_PEER;
  const connection = (t) => (t - run.sessionAt < CONNECTING_MS ? 'connecting' : onPretendPeer() ? 'stale' : 'live');
  const phase = (t) => (t - run.sessionAt < STARTING_MS ? 'starting' : 'ready');
  const grouping = () => run.groupings[run.view.domUnit];
  const rowCount = () => Math.max(1, Math.min(run.view.domLevels, run.fit ?? run.view.domLevels));
  const remember = (line) => {
    run.sent[line.kind] = JSON.stringify(line);
    return line;
  };

  const link = (t) => linkLine({ peers, peerIndex: run.peerIndex, session: run.session, connection: connection(t), phase: phase(t), running: run.running, control: run.control });
  const lifecycle = (t) => lifecycleLine({ session: run.session, phase: phase(t) });
  const catalog = () => catalogLine({ session: run.session, strategyId: workstation.strategyId, peer: peers[run.peerIndex] });

  function ladderStatus(t) {
    if (connection(t) === 'connecting') return 'disconnected';
    if (t < run.awaitingUntil) return 'awaiting';
    return onPretendPeer() ? 'stale' : 'live';
  }

  function ladderNow(t) {
    return ladderSection(run.book, {
      status: ladderStatus(t),
      staleMs: Math.round(STALE_STARTS_AT_MS + t - run.awaitingUntil),
      ticksEach: ticksPerBucket(run.book, grouping()),
      rows: rowCount(),
      unit: run.view.domUnit,
      random,
    });
  }

  function accountNow(t) {
    const word = (side) => (run.book.quotes[side].state === 'want' ? null : run.book.quotes[side].state);
    return accountSection({
      base: instrument().base, quote: instrument().quote, position: run.position, cash: run.cash, midPrice: midPrice(), orderQty: ORDER_QTY,
      orders: { bid: word('bid'), ask: word('ask') }, elapsedMs: t - run.openedAt,
    });
  }

  const viewSection = () => ({
    instrument: run.view.instrument,
    chartMode: run.view.chartMode,
    domUnit: run.view.domUnit,
    domGrouping: grouping(),
    domLevels: run.view.domLevels,
    riskSeries: run.view.riskSeries,
  });

  function recordFill(at, side, tick) {
    run.channels.add('fills', fillRow(at, side, priceText(tick), FILL_QTY.toFixed(5)));
    run.chart.addFill(at, tick * 2, side.toLowerCase());
  }

  /** The book, the quotes, the chart and the rows start over, as when an engine is attached. */
  function rebuild(t) {
    const { startBid, position, cash, base } = instrument();
    run.book = newBook(startBid, t);
    run.position = position;
    run.cash = cash;
    run.pnl = run.chart.backfill({ nowMs: t, midHalf: midHalf(run.book), position, random });
    run.channels.clear();
    SYSTEM_BACKFILL.forEach((text, n) => run.channels.add('system', systemRow(t - (SYSTEM_BACKFILL.length + 1 - n) * 1500, text)));
    run.channels.add('system', systemRow(t, 'engine ready', 'positive', 'engine ready for ' + base));
    for (let n = 0; n < BACKFILL_ROWS; n += 1) {
      const ago = BACKFILL_ROWS - n;
      const side = random() < 0.5 ? 'BUY' : 'SELL';
      const tick = run.book.bid - (side === 'BUY' ? 1 : -2) + Math.round((random() - 0.5) * 6);
      run.channels.add('orders', orderRow(t - ago * 1100, side, 'resting #' + (1000 + n).toString(16) + '  ' + ORDER_QTY_TEXT + ' @ ' + priceText(tick)));
      run.channels.add('trades', tradeRow(t - ago * 700, side, priceText(tick), (FILL_QTY * (1 + Math.floor(random() * 5))).toFixed(5)));
      recordFill(t - ago * 11000, side, tick);
    }
  }

  function newRun(t) {
    return {
      openedAt: t, sessionAt: t, session: 1, generation: 1, seq: 0, peerIndex: 0, awaitingUntil: t + AWAITING_MS,
      view: { instrument: 0, chartMode: 'line', domUnit: 'bps', domLevels: LEVELS.default, riskSeries: 'exposure' },
      groupings: { bps: withUnit(BPS_GROUPINGS[1], 'bps'), ticks: withUnit(TICK_GROUPINGS[0], 'ticks') },
      fit: null, axisCount: { mid: 0, risk: 0 }, paused: false, everything: true, running: true, control: null, nextGapAt: t + GAP_EVERY_MS,
      book: null, position: 0, cash: 0, pnl: 0, fillNumber: 0, nextFillAt: t + FILL_EVERY_MS,
      lastTickAt: t, lastSpin: Math.floor((t * 1000) / SPIN_US), latency: null, lastLatencyAt: -Infinity,
      channels: createChannels(), features: createFeatures(FEATURE_NAMES, t, random), chart: createChartBook(SPIN_US), sent: {},
    };
  }

  function orderEvent(t) {
    return (side, quote, word, tone) => {
      const text = word + ' #' + quote.id.toString(16).padStart(4, '0') + '  ' + ORDER_QTY_TEXT + ' @ ' + priceText(quote.tick);
      run.channels.add('orders', orderRow(t, side === 'bid' ? 'BUY' : 'SELL', text, tone));
    };
  }

  function trade(t, dt) {
    if (random() < dt * TRADES_PER_MS) {
      const side = random() < 0.5 ? 'BUY' : 'SELL';
      const tick = side === 'BUY' ? run.book.ask : run.book.bid;
      run.channels.add('trades', tradeRow(t, side, priceText(tick), (FILL_QTY * (1 + Math.floor(random() * 9))).toFixed(5)));
    }
    if (t >= run.nextFillAt) {
      const side = run.fillNumber % 2 === 0 ? 'BUY' : 'SELL';
      const tick = run.book.quotes[side === 'BUY' ? 'bid' : 'ask'].tick;
      run.fillNumber += 1;
      run.nextFillAt = t + FILL_EVERY_MS;
      run.position += side === 'BUY' ? FILL_QTY : -FILL_QTY;
      run.cash += (side === 'BUY' ? -FILL_QTY : FILL_QTY) * tick * PRICE_PER_TICK;
      recordFill(t, side, tick);
    }
  }

  /** A full snapshot goes out only when it differs from the last one sent, or when everything is resent. */
  function snapshot(name, value) {
    const key = JSON.stringify(value);
    if (!run.everything && run.sent[name] === key) return undefined;
    run.sent[name] = key;
    return value;
  }

  function advanceChart(t) {
    if (t >= run.nextGapAt) {
      run.nextGapAt = t + GAP_EVERY_MS;
      run.chart.markGap();
    }
    run.chart.advance({ nowMs: t, midHalf: midHalf(run.book), exposure: run.position * midPrice(), pnl: run.pnl });
  }

  function stepWorld(t) {
    const dt = t - run.lastTickAt;
    run.lastTickAt = t;
    if (run.control && !run.control.applied && (run.control.ticksLeft -= 1) <= 0) {
      run.control.applied = true;
      run.running = run.control.state === 'running';
    }
    run.pnl += run.position * moveBook(run.book, dt, random) * PRICE_PER_HALF_TICK;
    moveQuotes(run.book, { now: t, dt, rows: rowCount(), ticksEach: ticksPerBucket(run.book, grouping()), random, onOrder: orderEvent(t) });
    if (ladderStatus(t) === 'live') trade(t, dt);
    const spin = Math.floor((t * 1000) / SPIN_US);
    if (spin !== run.lastSpin) {
      run.lastSpin = spin;
      run.features.spin(t);
    }
    if (t - run.lastLatencyAt >= LATENCY_EVERY_MS) {
      run.lastLatencyAt = t;
      run.latency = latencySection(random);
    }
    // A stale engine sends nothing new, so the chart holds still until the next engine.
    if (ladderStatus(t) !== 'stale') advanceChart(t);
  }

  function tickLines(t) {
    const lines = [];
    for (const line of [link(t), lifecycle(t)]) if (JSON.stringify(line) !== run.sent[line.kind]) lines.push(remember(line));
    const everything = run.everything;
    const sections = {
      view: snapshot('view', viewSection()),
      ladder: snapshot('ladder', ladderNow(t)),
      summary: snapshot('summary', summarySection(run.book, { unit: run.view.domUnit, live: ladderStatus(t) === 'live' })),
      account: snapshot('account', accountNow(t)),
      features: snapshot('features', run.features.section(t)),
      channels: run.channels.section(everything),
      latency: snapshot('latency', run.latency),
      chart: run.chart.chart({ generation: run.generation, full: everything, axisCount: run.axisCount.mid }),
      risk: run.chart.risk({ generation: run.generation, full: everything, series: run.view.riskSeries, axisCount: run.axisCount.risk }),
      gaps: snapshot('gaps', { books: 0, events: 0 }),
    };
    const present = Object.entries(sections).filter(([, section]) => section !== undefined);
    if (present.length > 0) {
      run.seq += 1;
      run.everything = false;
      lines.push({ kind: 'tick', session: run.session, seq: run.seq, ...Object.fromEntries(present) });
    }
    return lines;
  }

  const bump = () => {
    run.generation += 1;
    run.everything = true;
  };

  /** Each command returns the lines to send at once, or null when the bridge would ignore it. */
  const commands = {
    select({ instrument: id }, t) {
      if (!INSTRUMENTS[id]) return null;
      run.view.instrument = id;
      run.awaitingUntil = t + AWAITING_MS;
      rebuild(t);
      bump();
      return [];
    },
    chart_mode({ mode }) {
      if (mode !== 'line' && mode !== 'candles') return null;
      run.view.chartMode = mode;
      return [];
    },
    dom_unit({ unit }) {
      if (unit !== 'ticks' && unit !== 'bps') return null;
      run.view.domUnit = unit;
      return [];
    },
    dom_grouping(command) {
      const found = command.unit === 'bps'
        ? BPS_GROUPINGS.find((g) => g.numerator === command.numerator && g.denominator === command.denominator)
        : command.unit === 'ticks' && TICK_GROUPINGS.find((g) => g.perBucket === command.perBucket);
      if (!found) return null;
      run.groupings[command.unit] = withUnit(found, command.unit);
      run.view.domUnit = command.unit;
      return [];
    },
    dom_levels({ levels }) {
      if (!Number.isFinite(levels)) return null;
      run.view.domLevels = clamp(Math.round(levels), LEVELS.min, LEVELS.max);
      return [];
    },
    dom_fit({ rows }) {
      if (!Number.isFinite(rows)) return null;
      run.fit = Math.max(1, Math.round(rows));
      return [];
    },
    chart_ticks({ mid, risk }) {
      if (!Number.isFinite(mid) || !Number.isFinite(risk)) return null;
      run.axisCount = { mid: Math.max(0, Math.floor(mid)), risk: Math.max(0, Math.floor(risk)) };
      return [];
    },
    risk_series({ series }) {
      if (series !== 'exposure' && series !== 'pnl') return null;
      run.view.riskSeries = series;
      run.chart.resendRisk();
      return [];
    },
    assert({ state }, t) {
      if (state !== 'running' && state !== 'idle') return null;
      run.control = { state, ticksLeft: ASSERT_TICKS, applied: false };
      return [remember(link(t))];
    },
    next_peer(_, t) {
      run.peerIndex = (run.peerIndex + 1) % peers.length;
      run.session += 1;
      run.sessionAt = t;
      run.awaitingUntil = t + AWAITING_MS;
      run.control = null;
      rebuild(t);
      bump();
      return [remember(link(t)), remember(lifecycle(t)), catalog()];
    },
    resync() {
      bump();
      return [catalog()];
    },
    pause() {
      run.paused = true;
      return [];
    },
    resume() {
      run.paused = false;
      bump();
      return [catalog()];
    },
  };

  return {
    open() {
      const t = now();
      run = newRun(t);
      rebuild(t);
      return [helloLine(), remember(link(t)), remember(lifecycle(t)), catalog()];
    },

    tick() {
      if (run.paused) return [];
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
      run.channels.add('system', systemRow(t, (cmd + ' ' + detail).trim(), 'text', JSON.stringify(command)));
      return lines;
    },
  };
}
