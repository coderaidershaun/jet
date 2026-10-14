// What the replies since the app started have used: tokens, time and spend. A
// reply is counted from the raw stream lines while it runs and closed by the
// cost Claude Code reports at its end. Nothing here is saved between launches.

import { estimateUsd } from './rates.js';

const isObject = (value) => typeof value === 'object' && value !== null;
const TEXT_FIELDS = new Set(['sessionId', 'model', 'stopReason']);

/**
 * Copies the fields a line or event carries; an absent field leaves the old value. The lines come
 * straight from Claude Code, so a field of the wrong type is skipped too, or it would turn a sum into text.
 */
function assign(reply, fields) {
  for (const [key, value] of Object.entries(fields)) {
    const fits = TEXT_FIELDS.has(key) ? typeof value === 'string' : Number.isFinite(value);
    if (fits) reply[key] = value;
  }
}

function emptyReply(carried = {}) {
  return {
    status: 'idle', sessionId: null, model: null, effort: null,
    inputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0, thinkingTokens: 0,
    reportedUsd: null, durationMs: null, apiMs: null, ttftMs: null, numTurns: null, stopReason: null, startedAt: null,
    ...carried,
  };
}

/** Without the 5 minute and 1 hour split, every cache write counts as 5 minute. */
function countsFrom(usage) {
  if (!isObject(usage)) return {};
  const split = usage.cache_creation;
  const total = usage.cache_creation_input_tokens;
  let writes = {};
  if (isObject(split)) writes = { cacheWrite5mTokens: split.ephemeral_5m_input_tokens, cacheWrite1hTokens: split.ephemeral_1h_input_tokens };
  else if (total !== undefined) writes = { cacheWrite5mTokens: total, cacheWrite1hTokens: 0 };
  return {
    inputTokens: usage.input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    ...writes,
    outputTokens: usage.output_tokens,
    thinkingTokens: usage.output_tokens_details?.thinking_tokens,
  };
}

function fromStreamEvent(line) {
  const { event } = line;
  if (event.type === 'message_start' && isObject(event.message)) {
    return { ...countsFrom(event.message.usage), model: event.message.model, ttftMs: line.ttft_ms };
  }
  if (event.type === 'message_delta') {
    return {
      outputTokens: event.usage?.output_tokens,
      thinkingTokens: event.usage?.output_tokens_details?.thinking_tokens ?? 0,
      stopReason: event.delta?.stop_reason,
    };
  }
  return {};
}

/** The fields one raw stream line sets; a line of any other kind sets none. */
function fieldsFrom(line) {
  if (line.type === 'system' && line.subtype === 'init') return { sessionId: line.session_id, model: line.model };
  if (line.type === 'stream_event' && isObject(line.event)) return fromStreamEvent(line);
  if (line.type === 'result') {
    return {
      ...countsFrom(line.usage),
      reportedUsd: line.total_cost_usd,
      durationMs: line.duration_ms,
      apiMs: line.duration_api_ms,
      ttftMs: line.ttft_ms,
      numTurns: line.num_turns,
      stopReason: line.stop_reason,
      sessionId: line.session_id,
    };
  }
  return {};
}

/**
 * Every kind of token in a reply, a total or a breakdown row. The drawer and the settings sheet both show this one sum, so they never disagree.
 * @param {{ inputTokens: number, cacheReadTokens: number, outputTokens: number, cacheWriteTokens?: number, cacheWrite5mTokens?: number, cacheWrite1hTokens?: number }} counts
 */
export function tokenCount(counts) {
  const cacheWrites = counts.cacheWriteTokens ?? counts.cacheWrite5mTokens + counts.cacheWrite1hTokens;
  return counts.inputTokens + counts.cacheReadTokens + cacheWrites + counts.outputTokens;
}

/**
 * @typedef {ReturnType<ReturnType<typeof createUsageTracker>['snapshot']>} UsageSnapshot
 * @typedef {UsageSnapshot['total']} UsageTotals
 */

export function createUsageTracker() {
  let reply = emptyReply();
  const total = { replies: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, thinkingTokens: 0, usd: 0 };
  const rows = new Map();

  const tally = (into, closed, usd) => {
    into.replies += 1;
    into.inputTokens += closed.inputTokens;
    into.cacheReadTokens += closed.cacheReadTokens;
    into.cacheWriteTokens += closed.cacheWrite5mTokens + closed.cacheWrite1hTokens;
    into.outputTokens += closed.outputTokens;
    into.usd += usd;
  };

  function close(status) {
    reply.status = status;
    const usedNothing = tokenCount(reply) === 0 && (reply.reportedUsd ?? 0) <= 0;
    if (usedNothing) return;
    const usd = reply.reportedUsd ?? estimateUsd(reply.model, reply) ?? 0;
    const model = reply.model ?? 'unknown';
    const key = model + '\n' + reply.effort;
    if (!rows.has(key)) {
      rows.set(key, { model, effort: reply.effort, replies: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 });
    }
    tally(rows.get(key), reply, usd);
    tally(total, reply, usd);
    total.thinkingTokens += reply.thinkingTokens;
  }

  return {
    /** Starts a new reply. The session and model stay until the stream names new ones, so the panel does not flash empty. */
    sent({ effort, at }) {
      reply = emptyReply({ status: 'streaming', effort, startedAt: at, sessionId: reply.sessionId, model: reply.model });
    },

    /** @param {unknown} line   one raw stream line, already parsed */
    raw(line) {
      if (reply.status !== 'streaming' || !isObject(line)) return;
      assign(reply, fieldsFrom(line));
    },

    /** @param {{ sessionId: string, model: string }} event */
    started(event) {
      assign(reply, { sessionId: event.sessionId, model: event.model });
    },

    /** @param {{ costUsd: number, usage?: { outputTokens?: number, thinkingTokens?: number, model?: string } }} event */
    finished(event) {
      if (reply.status !== 'streaming') return;
      assign(reply, { outputTokens: event.usage?.outputTokens, thinkingTokens: event.usage?.thinkingTokens, model: event.usage?.model });
      if (reply.reportedUsd === null) assign(reply, { reportedUsd: event.costUsd });
      close('done');
    },

    failed() {
      if (reply.status === 'streaming') close('failed');
    },

    stopped() {
      if (reply.status === 'streaming') close('stopped');
    },

    snapshot() {
      return {
        current: { ...reply, estimateUsd: estimateUsd(reply.model, reply) },
        total: { ...total },
        byModelEffort: [...rows.values()].map((row) => ({ ...row })),
      };
    },
  };
}
