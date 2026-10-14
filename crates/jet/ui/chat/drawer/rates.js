// The published list prices behind the live cost estimate, in US dollars for
// every million tokens, and the names the drawer shows for each model.

export const RATES_DATE = '2026-10-14';

const PER_MILLION = 1e6;
const LONG_PROMPT_TOKENS = 100000;

// Each tier applies from its prompt size up; a model with no long-prompt price has one tier.
const RATES = {
  'claude-fable-5-1': {
    label: 'Fable 5.1',
    tiers: [{ from: 0, input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 }],
  },
  'claude-opus-5-5': {
    label: 'Opus 5.5',
    tiers: [{ from: 0, input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 }],
  },
  'claude-sonnet-5-5': {
    label: 'Sonnet 5.5',
    tiers: [{ from: 0, input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 }],
  },
  'claude-haiku-5-5': {
    label: 'Haiku 5.5',
    tiers: [
      { from: 0, input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01, output: 0.5 },
      { from: LONG_PROMPT_TOKENS, input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 },
    ],
  },
};

/**
 * @param {string} modelId   the id the stream reports, such as "claude-sonnet-5-5"
 * @param {number} promptTokens   input plus cache reads plus cache writes
 * @returns {{ input: number, write5m: number, write1h: number, read: number, output: number } | null} null for a model with no published price
 */
export function rateFor(modelId, promptTokens) {
  const entry = RATES[modelId];
  if (!entry) return null;
  return entry.tiers.findLast((tier) => promptTokens >= tier.from);
}

/**
 * Thinking tokens are already inside `outputTokens`, so they are not added again.
 * @param {string} modelId
 * @param {{ inputTokens: number, cacheReadTokens: number, cacheWrite5mTokens: number, cacheWrite1hTokens: number, outputTokens: number }} counts
 * @returns {number | null} US dollars, or null for a model with no published price
 */
export function estimateUsd(modelId, counts) {
  const promptTokens = counts.inputTokens + counts.cacheReadTokens + counts.cacheWrite5mTokens + counts.cacheWrite1hTokens;
  const rate = rateFor(modelId, promptTokens);
  if (!rate) return null;
  const dollars = counts.inputTokens * rate.input
    + counts.cacheReadTokens * rate.read
    + counts.cacheWrite5mTokens * rate.write5m
    + counts.cacheWrite1hTokens * rate.write1h
    + counts.outputTokens * rate.output;
  return dollars / PER_MILLION;
}

/** The short name for a model id; an id with no published price is returned as it came. */
export function modelLabel(modelId) {
  return RATES[modelId]?.label ?? modelId;
}
