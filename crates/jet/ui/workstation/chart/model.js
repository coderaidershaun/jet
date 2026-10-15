// The bridge sends only what changed since the last frame, so something must keep the chart history
// and turn it into what each chart shows. That lives here, away from the page, so tests can check it.

/**
 * @typedef {{ first: number, last: number }} Domain
 * @typedef {{ low: number, high: number }} Bounds
 * @typedef {{ v: number, label: string }} AxisEntry
 * @typedef {{ i: number, o: number, h: number, l: number, c: number, cl: string, gap?: boolean }} Bucket
 * @typedef {{ i: number, ht: number, side: 'buy' | 'sell' }} Fill
 * @typedef {{ isPlottable: boolean, domain: Domain | null, bounds: Bounds, mode: string,
 *   points: Array<{ item: Bucket, isRunStart: boolean }>, fills: Fill[], axis: AxisEntry[] | null,
 *   note: string | null, hasCaption: boolean }} MidScene
 * @typedef {{ isPlottable: boolean, domain: Domain | null, bounds: Bounds | null,
 *   points: Array<{ item: { i: number, v: number }, isRunStart: boolean }>, axis: AxisEntry[] | null,
 *   note: string | null, latest: { text: string, tone: string } | null }} RiskScene
 * @typedef {{ index: number, midClose: number | null, midText: string | null, riskValue: number | null,
 *   riskText: string | null, timeText: string | null }} Crosshair
 */

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/**
 * The window the charts show: `capacity` slots, ending at the newest bucket once the series has
 * filled them. Given a window back it returns the same window.
 * @param {number} oldestIndex
 * @param {number} newestIndex
 * @param {number} capacity
 * @returns {Domain}
 */
export function domainFromRange(oldestIndex, newestIndex, capacity) {
  const slots = Math.max(capacity, 1);
  const isFull = newestIndex - oldestIndex + 1 >= slots;
  const first = isFull ? newestIndex + 1 - slots : oldestIndex;
  return { first, last: first + slots - 1 };
}

/**
 * How far across the window a bucket index sits, 0 to 1.
 * @param {number} index
 * @param {Domain} domain
 */
export function xFraction(index, domain) {
  const span = domain.last - domain.first;
  return span <= 0 ? 0 : clamp((index - domain.first) / span, 0, 1);
}

/**
 * How far up the value range a value sits, 0 to 1; the middle when the range is empty.
 * @param {number} value
 * @param {Bounds} bounds
 */
export function yFraction(value, bounds) {
  const span = bounds.high - bounds.low;
  return span <= 0 ? 0.5 : clamp((value - bounds.low) / span, 0, 1);
}

/**
 * The bucket index nearest to a position 0 to 1 across the window.
 * @param {number} fraction
 * @param {Domain} domain
 */
export function bucketAtFraction(fraction, domain) {
  return domain.first + Math.round(clamp(fraction, 0, 1) * (domain.last - domain.first));
}

export const lerp = (from, to, amount) => from + (to - from) * amount;

const SECONDS_PER_DAY = 86_400;
const pad = (number, digits) => String(number).padStart(digits, '0');

/**
 * The UTC time of day for microseconds since the epoch, as `HH:MM:SS.mmm`. A time before the epoch
 * counts back from midnight.
 * @param {number} micros
 */
export function timeOfDay(micros) {
  const seconds = Math.floor(micros / 1e6);
  const secondOfDay = ((seconds % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const millis = Math.floor((((micros % 1e6) + 1e6) % 1e6) / 1000);
  const hours = Math.floor(secondOfDay / 3600);
  const minutes = Math.floor((secondOfDay % 3600) / 60);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secondOfDay % 60, 2)}.${pad(millis, 3)}`;
}

/**
 * Marks where each run of connected points starts. A line is cut at a missing index, which is a
 * real hole in the data, and before a bucket the bridge flagged as following a break.
 * @template {{ i: number, gap?: boolean }} T
 * @param {T[]} items in index order
 * @returns {Array<{ item: T, isRunStart: boolean }>}
 */
export function segmentPoints(items) {
  return items.map((item, position) => ({
    item,
    isRunStart: position === 0 || item.i !== items[position - 1].i + 1 || item.gap === true,
  }));
}

/** @param {{ o: number, c: number }} bucket @returns {'bid' | 'ask' | 'text2'} */
export function candleColour({ o, c }) {
  if (c > o) return 'bid';
  return c < o ? 'ask' : 'text2';
}

/** The position of the first item whose index is not below `index`. */
function lowerBound(items, index) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (items[middle].i < index) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Folds buckets into a list kept in index order. A bucket with an index already held replaces it:
 * the bridge resends the open bucket until it closes.
 */
function mergeBuckets(held, incoming) {
  for (const bucket of incoming) {
    const newest = held.at(-1);
    if (newest === undefined || bucket.i > newest.i) {
      held.push(bucket);
      continue;
    }
    const at = lowerBound(held, bucket.i);
    if (held[at].i === bucket.i) held[at] = bucket;
    else held.splice(at, 0, bucket);
  }
}

function emptyChart() {
  return {
    generation: null, capacity: null, first: null, last: null, low: null, high: null, axis: null, note: null,
    fillsCaption: null, buckets: [], fills: [],
  };
}

function emptyRisk() {
  return { generation: null, latest: null, bounds: null, axis: null, note: null, buckets: [] };
}

const isInside = (domain) => (item) => item.i >= domain.first && item.i <= domain.last;

/** @param {{ first: number | null, last: number | null, capacity: number | null }} chart */
function domainOf({ first, last, capacity }) {
  return first === null || last === null ? null : domainFromRange(first, last, capacity ?? 1);
}

/** Copies the fields the section carries; one it leaves out keeps its value. */
function copyPresent(target, section, keys) {
  for (const key of keys) if (key in section) target[key] = section[key];
}

function dropBeforeWindow(state) {
  const domain = domainOf(state.chart);
  if (domain === null) return;
  state.chart.buckets.splice(0, lowerBound(state.chart.buckets, domain.first));
  state.chart.fills = state.chart.fills.filter((fill) => fill.i >= domain.first);
  state.risk.buckets.splice(0, lowerBound(state.risk.buckets, domain.first));
}

/** A bucket the bridge could not price is a hole in the data, not a point to draw. */
const hasPrices = ({ o, h, l, c }) => [o, h, l, c].every(Number.isFinite);

function foldChart(state, section) {
  const { chart, risk } = state;
  if ('generation' in section && section.generation !== chart.generation) {
    chart.buckets = [];
    chart.fills = [];
    risk.buckets = [];
    risk.generation = null;
  }
  copyPresent(chart, section, ['generation', 'capacity', 'first', 'last', 'low', 'high', 'axis', 'note', 'fillsCaption']);
  mergeBuckets(chart.buckets, (section.buckets ?? []).filter(hasPrices));
  chart.fills.push(...(section.fills ?? []));
  dropBeforeWindow(state);
}

function foldRisk(state, section) {
  const { risk } = state;
  if ('generation' in section && section.generation !== risk.generation) risk.buckets = [];
  copyPresent(risk, section, ['generation', 'latest', 'bounds', 'axis', 'note']);
  mergeBuckets(risk.buckets, section.buckets ?? []);
  dropBeforeWindow(state);
}

const RISK_KEYS = { exposure: { value: 'e', text: 'el' }, pnl: { value: 'p', text: 'pl' } };

const seriesOf = (state) => (state.riskSeries === 'pnl' ? 'pnl' : 'exposure');
const riskBoundsOf = (state) => state.risk.bounds?.[seriesOf(state)] ?? null;

function isMidPlottable({ chart }) {
  return !chart.note && domainOf(chart) !== null && Number.isFinite(chart.low) && Number.isFinite(chart.high);
}

function isRiskPlottable(state) {
  return !state.risk.note && domainOf(state.chart) !== null && riskBoundsOf(state) !== null;
}

/**
 * Keeps what the bridge has said about the charts and answers what to paint. Feed it each frame
 * section with `apply`; read the result from `mid`, `risk` and `crosshair`.
 */
export function createChartModel() {
  const state = {
    chart: emptyChart(), risk: emptyRisk(), spinIntervalUs: null, chartMode: 'line', riskSeries: 'exposure',
  };
  const inWindow = (items) => {
    const domain = domainOf(state.chart);
    return domain === null ? [] : items.filter(isInside(domain));
  };

  return {
    apply(section, value) {
      if (typeof value !== 'object' || value === null) return;
      if (section === 'hello') {
        state.chart = emptyChart();
        state.risk = emptyRisk();
      } else if (section === 'catalog') copyPresent(state, value, ['spinIntervalUs']);
      else if (section === 'view') copyPresent(state, value, ['chartMode', 'riskSeries']);
      else if (section === 'chart') foldChart(state, value);
      else if (section === 'risk') foldRisk(state, value);
    },

    get riskSeries() {
      return seriesOf(state);
    },

    /** @returns {MidScene} */
    get mid() {
      const { chart } = state;
      const fills = inWindow(chart.fills);
      return {
        isPlottable: isMidPlottable(state),
        domain: domainOf(chart),
        bounds: { low: chart.low, high: chart.high },
        mode: state.chartMode,
        points: segmentPoints(inWindow(chart.buckets)),
        fills,
        axis: chart.axis,
        note: chart.note,
        hasCaption: chart.fillsCaption ?? fills.length > 0,
      };
    },

    /** @returns {RiskScene} */
    get risk() {
      const { risk } = state;
      const series = seriesOf(state);
      const valued = inWindow(risk.buckets)
        .map((bucket) => ({ i: bucket.i, v: bucket[RISK_KEYS[series].value] }))
        .filter((point) => Number.isFinite(point.v));
      return {
        isPlottable: isRiskPlottable(state),
        domain: domainOf(state.chart),
        bounds: riskBoundsOf(state),
        points: segmentPoints(valued),
        axis: risk.axis?.[series] ?? null,
        note: risk.note,
        latest: risk.latest,
      };
    },

    /**
     * What is under a pointer `fraction` of the way across the plots, or null when no chart is drawn.
     * The labels are the bridge's own text; a slot with no bucket in it has none.
     * @param {number | null} fraction
     * @returns {Crosshair | null}
     */
    crosshair(fraction) {
      const hasMid = isMidPlottable(state);
      const hasRisk = isRiskPlottable(state);
      if (!Number.isFinite(fraction) || !(hasMid || hasRisk)) return null;
      const index = bucketAtFraction(fraction, domainOf(state.chart));
      const midBucket = hasMid ? state.chart.buckets.find((bucket) => bucket.i === index) : undefined;
      const riskBucket = hasRisk ? state.risk.buckets.find((bucket) => bucket.i === index) : undefined;
      const keys = RISK_KEYS[seriesOf(state)];
      return {
        index,
        midClose: midBucket?.c ?? null,
        midText: midBucket?.cl ?? null,
        riskValue: riskBucket?.[keys.value] ?? null,
        riskText: riskBucket?.[keys.text] ?? null,
        timeText: state.spinIntervalUs > 0 ? timeOfDay(index * state.spinIntervalUs) : null,
      };
    },
  };
}
