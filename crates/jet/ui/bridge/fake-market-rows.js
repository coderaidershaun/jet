// Pure helpers for the monitor sections of the pretend market: text formats, the four channels
// of rows, the account, the features and the latency table. Nothing here reads a clock or
// a random source of its own; the market hands them in.

export const FEATURE_NAMES = [
  'obi_half_bp', 'microprice_bp', 'spread_bp', 'imbalance_l5', 'trade_flow_1s', 'vol_1m_bp', 'depth_ratio_l3', 'signed_volume_5s',
  'ofi_l1', 'ofi_l5', 'quote_age_ms', 'cancel_rate_1s', 'queue_pos_bid', 'queue_pos_ask', 'realised_vol_10s', 'tick_rate_1s',
  'fair_edge_bp', 'inventory_skew', 'funding_bp', 'basis_bp',
];

const RING_ROWS = 256;
const FEATURES_THAT_NEVER_CHANGE = 3;
const FEATURE_CHANGED_MS = 2000;
const FEATURE_STALE_MS = 5000;
const NOTE_PERIOD_MS = 15000;
const REJECT_PERIOD_MS = 25000;
const REJECT_FROM_MS = 12000;
const REJECT_FOR_MS = 3000;

const two = (n) => String(n).padStart(2, '0');

/** `HH:MM:SS.mmm` in UTC, for a time in ms since the Unix epoch. */
export function timeText(ms) {
  const at = new Date(ms);
  return two(at.getUTCHours()) + ':' + two(at.getUTCMinutes()) + ':' + two(at.getUTCSeconds()) + '.' + String(at.getUTCMilliseconds()).padStart(3, '0');
}

/** A price on the 0.01 grid from its tick index: 11800001 is "118000.01". */
export function priceText(tick) {
  const sign = tick < 0 ? '-' : '';
  const magnitude = Math.abs(tick);
  return sign + Math.floor(magnitude / 100) + '.' + two(magnitude % 100);
}

/** The price between two ticks, from best bid + best ask: 23600001 is "118000.005". */
export function midText(halfTicks) {
  const thousandths = halfTicks * 5;
  return Math.floor(thousandths / 1000) + '.' + String(thousandths % 1000).padStart(3, '0');
}

/** Thousands apart with a space: 12345 is "12 345". */
export function groupDigits(number) {
  return String(Math.round(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

const sideTag = (side) => ({ side, tone: side === 'BUY' ? 'bid' : 'ask' });

export function systemRow(ms, text, textTone = 'text', detail = text) {
  return { time: timeText(ms), text, textTone, detail };
}

export function orderRow(ms, side, text, textTone = 'text') {
  return { time: timeText(ms), tag: sideTag(side), text, textTone, detail: side + ' ' + text };
}

export function tradeRow(ms, side, price, qty) {
  return { time: timeText(ms), tag: sideTag(side), price, qty, detail: 'trade ' + side + ' ' + qty + ' at ' + price };
}

export function fillRow(ms, side, price, qty) {
  return { time: timeText(ms), tag: { liq: 'mkr', ...sideTag(side) }, price, qty, detail: 'fee 0.000012 ' + side + ' ' + qty + ' at ' + price };
}

/**
 * The four channels of rows. Each remembers its newest 256 rows and how many it has made, and
 * hands out only what was not sent yet.
 */
export function createChannels() {
  const channels = Object.fromEntries(['system', 'orders', 'trades', 'fills'].map((name) => [name, { appended: 0, sent: 0, ring: [] }]));
  return {
    add(name, row) {
      const channel = channels[name];
      channel.appended += 1;
      channel.ring.unshift(row);
      if (channel.ring.length > RING_ROWS) channel.ring.pop();
    },
    /** Forgets the rows of an old instrument or session; the counts keep climbing. */
    clear() {
      for (const channel of Object.values(channels)) {
        channel.ring = [];
        channel.sent = channel.appended;
      }
    },
    /** The channels with new rows, or with any rows when `everything` is set; undefined when there are none. */
    section(everything) {
      const section = {};
      for (const [name, channel] of Object.entries(channels)) {
        const fresh = everything ? channel.ring.length : Math.min(channel.appended - channel.sent, channel.ring.length);
        if (fresh > 0) section[name] = { appended: channel.appended, rows: channel.ring.slice(0, fresh) };
        channel.sent = channel.appended;
      }
      return Object.keys(section).length > 0 ? section : undefined;
    },
  };
}

// Rounds a tiny negative to zero, so the page never shows "-0.00".
const amountText = (amount, digits) => (Math.abs(amount) < 0.5 * 10 ** -digits ? 0 : amount).toFixed(digits);

/**
 * The account block. `orders` holds the word of each side's order, or null; `elapsedMs` is the
 * time since the market opened, which decides when the notes and the reject text show.
 */
export function accountSection({ base, quote, position, cash, midPrice, orderQty, orders, elapsedMs }) {
  const sideCounts = (side) => ({
    open: orders[side] === 'live' ? 1 : 0,
    inflight: orders[side] === 'sent' ? 1 : 0,
    lost: orders[side] === 'lost' ? 1 : 0,
    leaked: 0,
  });
  const asking = orders.ask === 'live' || orders.ask === 'sent';
  const bidding = orders.bid === 'live' || orders.bid === 'sent';
  const lockedBase = asking ? orderQty : 0;
  const lockedQuote = bidding ? orderQty * midPrice : 0;
  const freeBase = Math.max(0, position - lockedBase);
  const freeQuote = Math.max(0, cash - lockedQuote);
  const rejectShows = elapsedMs % REJECT_PERIOD_MS >= REJECT_FROM_MS && elapsedMs % REJECT_PERIOD_MS < REJECT_FROM_MS + REJECT_FOR_MS;
  return {
    notes: Math.floor(elapsedMs / NOTE_PERIOD_MS) % 3 === 2 ? [{ text: '+2 untracked', tone: 'text2' }] : [],
    captions: { free: 'free', locked: 'locked', value: 'value ' + quote },
    base: { label: base, free: amountText(freeBase, 5), locked: amountText(lockedBase, 5), value: amountText(position * midPrice, 2) },
    quote: { label: quote, free: amountText(freeQuote, 2), locked: amountText(lockedQuote, 2), value: amountText(cash, 2) },
    sides: { bid: sideCounts('bid'), ask: sideCounts('ask') },
    gate: 'armed',
    haltReason: null,
    reject: rejectShows ? { text: 'gate underfunded', tone: 'warning' } : { text: '--', tone: 'text2' },
  };
}

/**
 * The feature table. Once per spin a few names change; the last three never do, so a stale name
 * always shows. A name reads "changed" for two spins after a change and "stale" after five seconds.
 */
export function createFeatures(names, startMs, random) {
  const items = names.map((name) => ({ name, value: random() * 2 - 1, changedAt: startMs, everChanged: false }));
  const movable = items.length - FEATURES_THAT_NEVER_CHANGE;
  return {
    spin(nowMs) {
      const count = 3 + Math.floor(random() * 4);
      const chosen = new Set();
      while (chosen.size < count) chosen.add(Math.floor(random() * movable));
      for (const index of chosen) {
        const item = items[index];
        item.value += (random() - 0.5) * 0.2;
        item.changedAt = nowMs;
        item.everChanged = true;
      }
    },
    section(nowMs) {
      return items.map((item) => {
        const value = item.value.toFixed(4);
        return {
          name: item.name,
          value,
          changed: item.everChanged && nowMs - item.changedAt < FEATURE_CHANGED_MS,
          stale: nowMs - item.changedAt >= FEATURE_STALE_MS,
          hover: item.name + '  =  ' + value,
        };
      });
    },
  };
}

const LATENCY_COLUMNS = ['EXCH>RECV', 'RECV>QUEUE', 'QUEUE WAIT', 'PROCESS', 'END-TO-END', 'RND TRIP', 'SLOTS'];
const LATENCY_ROWS = [
  { label: 'MARKET DATA', typical: [900, 120, 30, 80, 1200, 0, 4] },
  { label: 'ORDER TRIP', typical: [0, 200, 60, 150, 2400, 3100, 2] },
  { label: 'HOT PATH', typical: [400, 90, 15, 60, 700, 1500, 1] },
];
const LATENCY_DASH_CHANCE = 0.1;

/** The latency table: numbers that drift around a typical value, now and then `--`. */
export function latencySection(random) {
  return {
    header: 'LATENCY  us',
    columns: LATENCY_COLUMNS,
    rows: LATENCY_ROWS.map(({ label, typical }) => ({
      label,
      cells: typical.map((value) => (value === 0 || random() < LATENCY_DASH_CHANCE
        ? { text: '--', tone: 'text2' }
        : { text: groupDigits(value * (0.7 + random() * 0.7)), tone: 'text' })),
    })),
  };
}
