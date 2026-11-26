// The page's one copy of the task list. A change shows at once and goes to the server in the order it was made;
// a refused change is taken back and the list read again. A read waits for the changes before it and never draws
// over an open edit or a drag, and an answer older than the one drawn is dropped.

import { requestJson } from '../bridge/browser-agent.js';
import { tapEnded } from '../plan/taps.js';
import { isoDay } from '../plan/model.js';
import { applyDelete, applyGoalTitle, applyPatch, keepOlder, readDonePage, readTaskList, withOlder } from './model.js';

const BASE = '/api/task-list';
/** The rows a keep can hold: a task, open or done, or a goal. */
const rowsOf = (list, kind) => (kind === 'goal' ? list.goals : [...list.tasks, ...list.done]);
const DAY_CHECK_MS = 60000;

/**
 * @typedef {ReturnType<typeof readTaskList>} TaskList
 * @typedef {{ status: 'loading' | 'ready' | 'failed', list: TaskList | null, refreshFailed: boolean, alert: string,
 *   older: 'idle' | 'loading', gone: string }} State
 *   `alert` holds the words of the last failed change until a later change works; `gone` the title of a kept task
 *   that a read no longer holds
 */

/**
 * @param {{ request?: typeof requestJson, now?: () => number }} [parts] `now` in Unix seconds
 */
export function createTaskStore({ request = requestJson, now = () => Date.now() / 1000 } = {}) {
  /** @type {TaskList | null} the last list the server answered */
  let server = null;
  /** The changes sent and not yet answered, oldest first, each as it applies to a list. */
  let pending = [];
  /** A read that arrived while a task was kept; it is drawn when the keep ends. */
  let waiting = null;
  let kept = null;
  let status = 'loading', refreshFailed = false, alert = '', older = 'idle', gone = '';
  let ticket = 0, drawnTicket = 0, writes = 0, readWanted = false;
  let queue = Promise.resolve();
  const listeners = new Set();

  const drawn = () => (server === null ? null : pending.reduce((list, change) => change.apply(list), server));
  /** @returns {State} */
  const state = () => Object.freeze({ status, list: drawn(), refreshFailed, alert, older, gone });
  /** `cause` is 'read' for news from elsewhere and 'write' for a change of this page or its answer. */
  const tell = (cause) => { for (const listener of listeners) listener(state(), cause); };

  /** Takes an answered list if it is the newest one, keeping the older done tasks already paged in. */
  function take(raw, number) {
    if (number < drawnTicket) return false;
    drawnTicket = number;
    server = keepOlder(readTaskList(raw), server);
    return true;
  }

  async function read() {
    if (writes > 0) { readWanted = true; return; }
    const number = ++ticket;
    try {
      const raw = await request(BASE);
      if (number < drawnTicket) return;
      const fresh = readTaskList(raw);
      if (kept !== null && server !== null) {
        if (rowsOf(fresh, kept.kind).some((row) => row.id === kept.id)) {
          waiting = { raw, number };
          refreshFailed = false;
          return;
        }
        gone = rowsOf(server, kept.kind).find((row) => row.id === kept.id)?.title ?? '';
        kept = null;
      }
      take(raw, number);
      status = 'ready';
      refreshFailed = false;
    } catch (error) {
      if (number < drawnTicket) return;
      console.warn('the task list could not be read:', error);
      if (status === 'ready') refreshFailed = true; else status = 'failed';
    }
    tell('read');
  }

  /**
   * One change: shown at once through `apply`, sent after every change before it, and taken back if refused. A refusal
   * puts its words in `alert`, or, for a `quiet` change whose caller shows them itself, only in the answer's `notice`.
   */
  function write(failure, apply, call, quiet = false) {
    const change = { apply };
    if (apply) pending.push(change);
    writes += 1;
    if (apply) tell('write');
    const done = queue.then(async () => {
      const number = ++ticket;
      try {
        const raw = await call();
        pending = pending.filter((item) => item !== change);
        if (take(raw, number)) waiting = null;
        status = 'ready';
        alert = '';
        return { ok: true, changed: server.changed };
      } catch (error) {
        pending = pending.filter((item) => item !== change);
        const notice = tapEnded(failure, error).notice;
        if (!quiet) alert = notice;
        readWanted = true;
        return { ok: false, error, notice };
      } finally {
        writes -= 1;
        tell('write');
        if (writes === 0 && readWanted) { readWanted = false; read(); }
      }
    });
    queue = done;
    return done;
  }

  const taskPath = (id) => `${BASE}/tasks/${encodeURIComponent(id)}`;
  /** `failure` names what did not happen, such as 'The task could not be moved'. `at` places a task put back. */
  const change = (id, patch, failure, at = null) => write(failure, (list) => applyPatch(list, id, patch, now(), at), () => request(taskPath(id), patch, 'PATCH'));

  return {
    get state() { return state(); },
    /** @param {(state: State, cause: 'read' | 'write') => void} listener */
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh: read,
    /** A first read that failed is tried again with the loading rows back. */
    retry() {
      if (status === 'failed') { status = 'loading'; tell('read'); }
      return read();
    },
    /** Reads now, again on every change the page hears of, when the window comes back, and when the day turns. */
    start() {
      document.addEventListener('jet:pane-changed', read);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) read(); });
      setInterval(() => { if (server && isoDay(now(), server.timeZone ?? 'UTC') !== server.today) read(); }, DAY_CHECK_MS);
      read();
    },
    /**
     * Keeps the list as it is drawn while the person works on one task or goal (`kind` is 'task' or 'goal'): a read
     * waits until `release`, unless it no longer holds that row, which ends the keep and names it in `gone`.
     */
    keep(kind, id) { kept = { kind, id }; gone = ''; },
    release() {
      kept = null;
      if (waiting === null) return;
      const { raw, number } = waiting;
      waiting = null;
      if (take(raw, number)) tell('read');
    },
    clearGone() { gone = ''; },
    /**
     * Adds a task last in its day, under `goalId` or none. It shows once the server answers, which is why it is not drawn
     * ahead, and a refusal is the caller's to show beside its field.
     */
    add: (title, day, goalId = null) => write('The task could not be added', null, () => request(`${BASE}/tasks`, { title, day, goalId }, 'POST'), true),
    change,
    /** Gives each late task today's date, one change after another, each keeping its place in the one order. */
    moveAllToToday: (ids) => Promise.all(ids.map((id) => change(id, { day: 'today' }, 'Some tasks could not be moved'))),
    remove: (id) => write('The task could not be deleted', (list) => applyDelete(list, id), () => request(taskPath(id), undefined, 'DELETE')),
    renameGoal: (id, title) => write('The goal could not be renamed', (list) => applyGoalTitle(list, id, title), () => request(`${BASE}/goals/${encodeURIComponent(id)}`, { title }, 'PATCH')),
    closeGoal: (id) => write('The goal could not be closed', null, () => request(`${BASE}/goals/${encodeURIComponent(id)}`, { state: 'done' }, 'PATCH')),
    /** Loads the next older page of the done pile. */
    async loadOlder() {
      const last = drawn()?.done.at(-1);
      if (!last || older === 'loading') return;
      older = 'loading';
      tell('write');
      try {
        const page = readDonePage(await request(`${BASE}/done?before=${last.doneAt}&beforeId=${last.id}`));
        server = withOlder(server, page.done);
        if (!page.more) server = Object.freeze({ ...server, doneCount: server.done.length });
        alert = '';
      } catch (error) {
        alert = tapEnded('Older done tasks could not be loaded', error).notice;
      }
      older = 'idle';
      tell('write');
    },
  };
}
