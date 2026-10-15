// What the engine card knows, with no DOM: the rows of a polysim listing and their
// badges, the rule for when Start must ask first, the fleet the card shows and what
// is pending on it, and the lines that tell the thread and Claude what the user did.

import { clockTime } from '../../clock.js';

/**
 * One engine as the card draws it.
 * @typedef {object} EngineRow
 * @property {string} key             stable: strategy and engine id
 * @property {string} strategyId
 * @property {string} teId
 * @property {string} name            `strategy · te`
 * @property {string | null} state    running, stopped or exited
 * @property {string | null} mode     off, sim, live, absent or unreadable
 * @property {number | null} pid
 * @property {number | null} startedAt   milliseconds
 * @property {number | null} exitCode
 * @property {string | null} linkBind    where its link listens, `host:port`
 * @property {string | null} configError
 */

/** @param {unknown} value */
const textOrNull = (value) => (typeof value === 'string' ? value : null);
/** @param {unknown} value */
const numberOrNull = (value) => (typeof value === 'number' ? value : null);

/**
 * The rows of a `list_strategies` result; anything else has none.
 * @param {any} result
 * @returns {EngineRow[]}
 */
export function engineRows(result) {
  const engines = Array.isArray(result?.engines) ? result.engines : [];
  return engines.map((engine) => {
    const strategyId = String(engine.strategy_id);
    const teId = String(engine.te_id);
    const started = Date.parse(engine.started_at);
    return {
      key: strategyId + ' ' + teId,
      strategyId,
      teId,
      name: strategyId + ' · ' + teId,
      state: textOrNull(engine.state),
      mode: textOrNull(engine.mode),
      pid: numberOrNull(engine.pid),
      startedAt: Number.isNaN(started) ? null : started,
      exitCode: numberOrNull(engine.exit_code),
      linkBind: textOrNull(engine.link_bind),
      configError: textOrNull(engine.config_error),
    };
  });
}

/** What a badge or a question says for a state or mode the listing left out. */
const UNKNOWN = 'unknown';
const STATE_TONES = { running: 'positive', stopped: 'muted', exited: 'warning' };
const MODE_TONES = { off: 'muted', sim: 'warning', live: 'negative', absent: 'muted', unreadable: 'invalid' };

/** @param {Pick<EngineRow, 'state'>} row @returns {{ text: string, tone: string }} */
export function stateBadge({ state }) {
  return { text: String(state ?? UNKNOWN).toUpperCase(), tone: STATE_TONES[state] ?? 'muted' };
}

/**
 * A mode the card does not know is drawn in the alarm tone, so nobody takes it for a safe one.
 * @param {Pick<EngineRow, 'mode' | 'configError'>} row
 * @returns {{ text: string, tone: string, title: string | null }}
 */
export function modeBadge({ mode, configError }) {
  return {
    text: String(mode ?? UNKNOWN).toUpperCase(),
    tone: MODE_TONES[mode] ?? 'invalid',
    title: mode === 'unreadable' ? configError : null,
  };
}

/** The small print under an engine's name. @param {Pick<EngineRow, 'state' | 'pid' | 'startedAt' | 'exitCode'>} row */
export function detailLine({ state, pid, startedAt, exitCode }) {
  if (state === 'running') return 'pid ' + pid + (startedAt === null ? '' : ' · since ' + clockTime(startedAt));
  if (state === 'exited' && exitCode !== null) return 'exit code ' + exitCode;
  return '';
}

/** What the row's button does. @param {Pick<EngineRow, 'state'>} row @returns {'start' | 'stop'} */
export const actionFor = ({ state }) => (state === 'running' ? 'stop' : 'start');

/**
 * The question to ask before an action, or null when it needs none. Start asks unless the
 * mode is exactly off or sim, so a live engine, one whose mode cannot be read and one with a
 * mode nobody knows all ask. The caller gives it a row from a fresh listing: a row the card
 * drew earlier may show sim for an engine that has been set to live since.
 * @param {{ kind: 'start' | 'stop' | 'mode', row: Pick<EngineRow, 'mode'>, mode?: string }} action
 * @returns {string | null}
 */
export function confirmText({ kind, row, mode }) {
  if (kind === 'mode') return mode === 'live' ? 'This engine trades real money once it starts. Set it to live?' : null;
  if (kind === 'stop' || row.mode === 'off' || row.mode === 'sim') return null;
  if (row.mode === 'live') return 'This engine trades real money. Start it?';
  return "This engine's mode is " + (row.mode ?? UNKNOWN) + '. Start it?';
}

/**
 * The fleet every engine card in the thread shows: the newest listing, which actions are
 * pending on which engine, and the errors that stay on a row until its next action.
 */
export function createFleet() {
  /** @type {EngineRow[]} */
  let rows = [];
  let stale = false;
  /** @type {string | null} */
  let error = null;
  /** @type {Map<string, 'start' | 'stop' | 'mode'>} */
  const pending = new Map();
  /** @type {Map<string, string>} */
  const errors = new Map();
  const taken = new Set();
  /** @param {string} key */
  const find = (key) => rows.find((row) => row.key === key) ?? null;

  return {
    get rows() {
      return rows;
    },
    /** True while the rows come from an earlier session and have not been listed again. */
    get stale() {
      return stale;
    },
    /** Why the last direct listing failed, or null. */
    get error() {
      return error;
    },

    /**
     * Takes the listing of one tool call, once per call id. Returns whether it did.
     * @param {string} callId
     * @param {any} result
     * @param {{ stale?: boolean }} [options]
     */
    adopt(callId, result, { stale: old = false } = {}) {
      if (taken.has(callId)) return false;
      taken.add(callId);
      rows = engineRows(result);
      stale = old;
      error = null;
      return true;
    },

    /** Marks a call as seen without showing its listing. @param {string} callId */
    know(callId) {
      taken.add(callId);
    },

    /** A listing the card asked for just now. @param {any} result */
    list(result) {
      rows = engineRows(result);
      stale = false;
      error = null;
    },

    row: find,

    /** @param {string} key @param {'start' | 'stop' | 'mode'} kind */
    begin(key, kind) {
      pending.set(key, kind);
      errors.delete(key);
    },

    /** Ends the pending action. A message stays on the row until its next action. @param {string} key @param {string | null} [message] */
    settle(key, message = null) {
      pending.delete(key);
      if (message) errors.set(key, message);
    },

    /** @param {string} message */
    failList(message) {
      error = message;
    },

    /** @param {string} key */
    rowView(key) {
      const busy = pending.has(key);
      return {
        pending: pending.get(key) ?? null,
        error: errors.get(key) ?? null,
        busy,
        modeLocked: busy || find(key)?.state === 'running',
      };
    },
  };
}

/**
 * What the user did on a row, for the thread and for Claude.
 * @typedef {object} EngineAction
 * @property {'start' | 'stop' | 'mode'} kind
 * @property {Pick<EngineRow, 'name'>} row
 * @property {string} [mode]   the mode a mode change sets
 * @property {number} at       milliseconds
 */

/** @param {EngineAction} action */
function whatTheUserDid({ kind, row, mode }) {
  if (kind === 'start') return 'started ' + row.name;
  if (kind === 'stop') return 'stopped ' + row.name;
  return 'set ' + row.name + ' to ' + mode;
}

/** The line the thread shows after an action. @param {EngineAction} action */
export function actionLine(action) {
  return 'You ' + whatTheUserDid(action) + ' · ' + clockTime(action.at);
}

const PREFACE_START = '[Jet: ';

// SMELL: the queue lives only in the page, so a reload before the next message loses it and
// Claude never hears of those actions.
/**
 * The actions the user took since Claude last read a message, as the one bracketed line the
 * next message carries in front of the user's words.
 */
export function createPreface() {
  /** @type {string[]} */
  let parts = [];
  return {
    /** @param {EngineAction} action */
    add(action) {
      parts.push('the user ' + whatTheUserDid(action) + ' at ' + clockTime(action.at));
    },

    /** The line to send, emptying the queue; null when nothing happened. @returns {string | null} */
    take() {
      if (parts.length === 0) return null;
      const line = PREFACE_START + parts.join('; ') + ']';
      parts = [];
      return line;
    },

    /** Puts a line that was taken back in front, for a send that was refused. @param {string} line */
    giveBack(line) {
      parts.unshift(line.slice(PREFACE_START.length, -1));
    },
  };
}
