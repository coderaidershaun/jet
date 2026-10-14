// How the usage panel writes its numbers and words, so a count, a price or a
// time reads the same wherever it shows. A value not known yet is a dash.

import { modelLabel } from './rates.js';

export const NOTHING = '—';
// The no-break space keeps each dot with the words before it, so a wrapped line never starts with a dot.
const DOT = '\u00A0· ';

const COMPACT_FROM = 10000;
// This uses US English because British English writes 36.1k in some engines and 36.1K in others.
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const count = (number) => number.toLocaleString('en-GB');

/** Full below 10 000, then shortened (41.6K, 2.3M), so a long day's tokens still fit a narrow tile. */
export const compactCount = (number) => (number < COMPACT_FROM ? count(number) : compact.format(number));

export const dollars = (usd) => '$' + usd.toFixed(4);

export const seconds = (ms) => (ms === null ? NOTHING : (ms / 1000).toFixed(2) + ' s');

export const turnsText = (numTurns) => (numTurns === null ? NOTHING : count(numTurns));

/**
 * Before the first reply there is nothing to cost. Once Claude Code reports the cost, it replaces the estimate.
 * @param {{ status: string, model: string | null, reportedUsd: number | null, estimateUsd: number | null }} reply
 */
export function spendText({ status, model, reportedUsd, estimateUsd }) {
  if (status === 'idle') return NOTHING;
  if (reportedUsd !== null) return dollars(reportedUsd) + ' reported';
  if (estimateUsd !== null) return 'est. ' + dollars(estimateUsd);
  return model === null ? NOTHING : 'no rate';
}

/** @param {{ model: string | null, effort: string | null }} reply */
export function modelAndThinking({ model, effort }) {
  if (model === null) return NOTHING;
  return effort === null ? modelLabel(model) : modelLabel(model) + DOT + effort;
}
