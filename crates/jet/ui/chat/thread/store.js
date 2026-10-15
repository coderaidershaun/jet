// What the thread holds: the messages, the notices, the one reply that may be
// running, and the message held back until that reply ends. It turns them into
// rows (bubbles, day pills, notice pills) with the grouping already decided.
// It knows nothing about the DOM, the agent or the clock beyond `now`.

import { dayKey, dayLabel } from '../clock.js';

const GROUP_GAP_MS = 3 * 60 * 1000;

/**
 * @typedef {object} Row
 * @property {string} key             stable while the row lives, so a view can keep its node
 * @property {'day' | 'notice' | 'user' | 'jet' | 'lane'} type
 * @property {string} [label]         day pills
 * @property {string} [message]       notice pills
 * @property {{ id: number | null, role: 'user' | 'jet', text: string, html: string, mood?: string, status: string, error?: string, tools?: import('./cards/model.js').ShownCall[], at: number }} [entry]
 * @property {{ kind: string, message: string }} [failure]
 * @property {boolean} [first]        first bubble of its group
 * @property {boolean} [last]         last bubble of its group, so it carries the tail
 * @property {boolean} [live]         the newest Jet row, where the live Jet stands
 */

/**
 * @param {{ now?: () => number }} [options]
 */
export function createThread({ now = Date.now } = {}) {
  /** @type {{ key: string, type: 'user' | 'jet' | 'notice', at: number, entry?: any, message?: string, failure?: any }[]} */
  let items = [];
  let counter = 0;
  /** @type {typeof items[number] | null} */
  let slot = null;
  /** @type {string | null} */
  let held = null;

  const nextKey = () => 'm' + ++counter;
  const isMessage = (row) => row.type === 'user' || row.type === 'jet';

  function joins(a, b) {
    return isMessage(a) && a.type === b.type && b.entry.at - a.entry.at >= 0 && b.entry.at - a.entry.at < GROUP_GAP_MS;
  }

  function requireSlot(action) {
    if (!slot) throw new Error('cannot ' + action + ': no reply is running');
    return slot;
  }

  // The saved entry wins. A call the page saw that it lacks is kept, and one still running is marked
  // unfinished, so Stop during a search leaves its card on the page.
  function withSeenCalls(patch, seen) {
    const saved = patch.tools ?? [];
    const missing = (seen ?? [])
      .filter((call) => !saved.some((kept) => kept.id === call.id))
      .map((call) => (call.ok === undefined ? { ...call, unfinished: true } : call));
    return missing.length ? { ...patch, tools: [...saved, ...missing] } : patch;
  }

  function endSlot(patch, failure) {
    const open = requireSlot('end the reply');
    open.entry = withSeenCalls(patch, open.entry.tools);
    open.at = patch.at;
    if (failure) open.failure = failure;
    slot = null;
  }

  return {
    /** Replaces everything with saved history. @param {any[]} entries */
    load(entries) {
      items = entries.map((entry) => ({ key: nextKey(), type: entry.role, at: entry.at, entry }));
      slot = null;
      held = null;
    },

    clear() {
      items = [];
      slot = null;
      held = null;
    },

    addUser(text, at = now()) {
      items.push({ key: nextKey(), type: 'user', at, entry: { id: null, role: 'user', text, html: '', status: 'complete', at } });
    },

    /** A notice that arrives while Jet replies belongs above that reply. */
    addNotice(message, at = now()) {
      const notice = { key: 'n' + ++counter, type: 'notice', at, message };
      if (slot) items.splice(items.indexOf(slot), 0, notice);
      else items.push(notice);
    },

    /** Starts the Jet row that the reply will fill. */
    openSlot(at = now()) {
      if (slot) throw new Error('cannot open a reply: one is already running');
      const entry = { id: null, role: 'jet', text: '', html: '', status: 'waiting', at };
      slot = { key: nextKey(), type: 'jet', at, entry };
      items.push(slot);
    },

    get slot() {
      return slot ? slot.entry : null;
    },

    get replying() {
      return slot !== null;
    },

    setMood(word) {
      requireSlot('set the mood').entry.mood = word;
    },

    appendText(delta) {
      const entry = requireSlot('append text').entry;
      entry.text += delta;
      entry.status = 'streaming';
    },

    /** A tool call has started; it shows as running until it finishes. */
    startTool({ id, server, tool, input }) {
      const entry = requireSlot('start a tool call').entry;
      entry.tools = [...(entry.tools ?? []), { id, server, tool, input }];
    },

    /** A call came back; it takes the place of the running one. */
    finishTool({ id, server, tool, ok, result, summary, durationMs }) {
      const entry = requireSlot('finish a tool call').entry;
      const calls = entry.tools ?? [];
      const outcome = { ok, result, summary, durationMs };
      entry.tools = calls.some((call) => call.id === id)
        ? calls.map((call) => (call.id === id ? { ...call, ...outcome } : call))
        : [...calls, { id, server, tool, input: null, ...outcome }];
    },

    /** The rendered HTML of the text so far. */
    reveal(html) {
      requireSlot('show text').entry.html = html;
    },

    finish(entry) {
      endSlot(entry);
    },

    fail(failure, entry) {
      endSlot({ ...entry, error: entry.error ?? failure.message }, failure);
    },

    stop(entry) {
      endSlot(entry);
    },

    get held() {
      return held;
    },

    /** Keeps what the user typed while Jet replies; a second hold adds a paragraph. */
    hold(text) {
      held = held === null ? text : held + '\n\n' + text;
    },

    /** Gives the held text back to the field. */
    cancelHold() {
      const text = held ?? '';
      held = null;
      return text;
    },

    /** The held text once the reply has ended, else null. It leaves once. */
    takeHeld() {
      if (slot || held === null) return null;
      const text = held;
      held = null;
      return text;
    },

    lastUserText() {
      const last = items.findLast((item) => item.type === 'user');
      return last ? last.entry.text : null;
    },

    /** @returns {Row[]} */
    rows() {
      /** @type {Row[]} */
      const rows = [];
      let day = null;
      for (const item of items) {
        const key = dayKey(item.at);
        if (key !== day) {
          rows.push({ key: 'day:' + key, type: 'day', label: dayLabel(item.at, now()) });
          day = key;
        }
        rows.push(item.type === 'notice'
          ? { key: item.key, type: 'notice', message: item.message }
          : { key: item.key, type: item.type, entry: item.entry, failure: item.failure });
      }
      rows.forEach((row, i) => {
        if (!isMessage(row)) return;
        row.first = !(i > 0 && joins(rows[i - 1], row));
        row.last = !(i < rows.length - 1 && isMessage(rows[i + 1]) && joins(row, rows[i + 1]));
      });
      const newest = rows.findLast((row) => row.type === 'jet');
      if (newest) newest.live = true;
      else if (items.length > 0) rows.push({ key: 'lane', type: 'lane', live: true });
      for (const row of rows) if (row.type === 'jet' && !row.live) row.live = false;
      return rows;
    },
  };
}
