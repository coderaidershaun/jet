// How a job reads from a tool result. A job is long work that a tool starts and later reports on:
// quanty's ingest, insights and dataset builds all answer in one shape, with a state and, while it
// runs, a stage. Older results gave the stage as a plain string, and both are read. Pure, with no DOM.

import { count, isRecord, joined, numberOrNull, orNull, recordOf } from './guard.js';

/** The state of a job still at work. Every other state ends it. */
export const RUNNING = 'running';

/** @typedef {{ id: string, state: string, share: number | null, words: string | null }} JobView */

/** A result that is a job: a `job_id` and a `state`, both text. */
export const isJob = (result) => isRecord(result) && typeof result.job_id === 'string' && typeof result.state === 'string';

/** The words and the share of a stage, from the object of the new shape or the string of the old one. */
function stageOf(stage) {
  if (typeof stage === 'string') return { words: orNull(stage), share: null };
  const record = recordOf(stage);
  const share = numberOrNull(record.share);
  return { words: orNull(record.words) ?? orNull(record.name), share: share === null ? null : Math.min(1, Math.max(0, share)) };
}

/** What the card draws of a job beside its fields, or null when the result is not a job. @returns {JobView | null} */
export function jobOf(result) {
  if (!isJob(result)) return null;
  const { words, share } = stageOf(result.stage);
  return { id: result.job_id, state: result.state, share, words };
}

/**
 * The outcome, tone and fields of a job result. With no state there is no outcome, and the caller
 * words one.
 */
export function readIngest(result) {
  const state = orNull(result.state);
  const { words } = stageOf(result.stage);
  const items = numberOrNull(result.items);
  const cost = numberOrNull(result.cost_usd);
  const entries = [
    ['State', state && state.replace(/_/g, ' ')],
    ['Kind', orNull(result.kind)],
    ['Stage', words],
    ['Media', orNull(result.media)],
    ['File', orNull(result.file) ?? orNull(result.file_name)],
    ['Document', orNull(result.document_id)],
    ['Items', items === null ? null : String(items)],
    ['Cost', cost === null ? null : '$' + cost.toFixed(2)],
  ];
  const fields = entries.filter(([, text]) => text).map(([term, text]) => ({ term, text }));
  const summary = orNull(result.summary);
  if (summary) fields.push({ term: 'Summary', text: summary, pre: true });
  const error = orNull(result.error);
  if (error) fields.push({ term: 'Error', text: error });

  const outcomes = {
    [RUNNING]: joined('running', words),
    done: joined('done', items === null ? '' : count(items, 'item')),
    already_ingested: 'already in the library',
    failed: 'failed',
    stopped: 'stopped',
  };
  const outcome = state ? (Object.hasOwn(outcomes, state) ? outcomes[state] : state) : '';
  // A stopped job was asked to stop, which is not an error, so it stays quiet.
  const tone = state === 'failed' ? 'invalid' : state === 'done' || state === 'already_ingested' ? 'ok' : 'quiet';
  return { outcome, tone, body: { kind: 'fields', fields } };
}
