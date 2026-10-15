// The engine card in the thread: one row for each polysim engine with its state, its
// mode, Start or Stop and a mode choice. Every card shows the same newest fleet, and a row
// is patched in place, so a focused button keeps its focus while the card repaints.

import { h } from '../../../dom.js';
import { actionFor, actionLine, confirmText, createFleet, createPreface, detailLine, modeBadge, stateBadge } from './engines.js';

const MODES = ['off', 'sim', 'live'];
const MODE_LABELS = { off: 'Off', sim: 'Sim', live: 'Live' };
const TOOLS = { start: 'start_strategy', stop: 'stop_strategy', mode: 'set_execution_mode' };

const messageOf = (error) => (error && error.message ? error.message : String(error));

/**
 * @param {{
 *   call: (tool: string, args: object) => Promise<any>,
 *   onAction: (line: string) => void,
 *   openWorkstation: (row: import('./engines.js').EngineRow) => void,
 * }} options
 *   `call` runs one polysim tool; `onAction` puts a line in the thread; `openWorkstation`
 *   shows the workstation for an engine.
 */
export function createEngineCards({ call, onAction, openWorkstation }) {
  const fleet = createFleet();
  const preface = createPreface();
  /** Every card made, with the parts of it that are patched. @type {Map<HTMLElement, ReturnType<typeof skeleton>>} */
  const cards = new Map();
  /** Cards that have been in the page at least once, so one that left it can be dropped. */
  const attached = new WeakSet();
  let refreshing = false;
  /** @type {HTMLDialogElement | null} */
  let dialog = null;

  function skeleton(el) {
    const refresh = h('button', { class: 'text-button engine-refresh', type: 'button', text: 'Refresh' });
    const note = h('p', { class: 'engine-note', text: 'From an earlier reply. Refresh to see what runs now.' });
    const error = h('p', { class: 'engine-error', role: 'alert', 'data-tone': 'invalid' });
    const empty = h('p', { class: 'engine-note', text: 'polysim lists no engines.' });
    const list = h('ul', { class: 'engine-rows' });
    el.append(h('div', { class: 'engine-head' }, h('h3', { text: 'Engines' }), refresh), note, error, empty, list);
    return { refresh, note, error, empty, list, rows: new Map() };
  }

  function buildRow(row) {
    const label = row.strategyId + ' ' + row.teId;
    const name = h('span', { class: 'engine-name', text: row.name });
    const state = h('span', { class: 'badge' });
    const mode = h('span', { class: 'badge' });
    const detail = h('span', { class: 'engine-detail' });
    const toggle = h('button', { class: 'action engine-toggle', type: 'button' });
    const select = h('select', { class: 'engine-mode', 'aria-label': 'Mode of ' + label },
      ...MODES.map((value) => h('option', { value, text: MODE_LABELS[value] })),
      h('option', { value: '', text: '—', disabled: true, hidden: true }));
    const open = h('button', { class: 'text-button engine-open', type: 'button', text: 'Open in workstation' });
    const spinner = h('span', { class: 'engine-spinner', 'aria-hidden': 'true' });
    const error = h('p', { class: 'engine-error', role: 'alert', 'data-tone': 'invalid' });
    const el = h('li', { class: 'engine-row', 'data-key': row.key },
      h('div', { class: 'engine-title' }, name, state, mode),
      detail,
      h('div', { class: 'engine-actions' }, toggle, select, open, spinner),
      error);
    return { el, state, mode, detail, toggle, select, open, spinner, error, label };
  }

  function paintRow(parts, row) {
    const view = fleet.rowView(row.key);
    const state = stateBadge(row);
    const mode = modeBadge(row);
    const action = actionFor(row);
    const known = MODES.includes(row.mode);
    if (view.busy) parts.el.setAttribute('aria-busy', 'true');
    else parts.el.removeAttribute('aria-busy');
    parts.state.textContent = state.text;
    parts.state.dataset.tone = state.tone;
    parts.mode.textContent = mode.text;
    parts.mode.dataset.tone = mode.tone;
    if (mode.title) parts.mode.title = mode.title;
    else parts.mode.removeAttribute('title');
    const detail = detailLine(row);
    parts.detail.textContent = detail;
    parts.detail.hidden = detail === '';
    parts.toggle.textContent = action === 'stop' ? 'Stop' : 'Start';
    parts.toggle.dataset.action = action;
    parts.toggle.setAttribute('aria-label', parts.toggle.textContent + ' ' + parts.label);
    parts.toggle.disabled = view.busy;
    parts.select.value = known ? row.mode : '';
    parts.select.options[MODES.length].hidden = known;
    parts.select.disabled = view.modeLocked;
    parts.open.hidden = !row.linkBind;
    parts.spinner.hidden = !view.busy;
    parts.error.textContent = view.error ?? '';
    parts.error.hidden = view.error === null;
  }

  function paint(el, parts) {
    parts.note.hidden = !fleet.stale;
    parts.error.textContent = fleet.error ?? '';
    parts.error.hidden = fleet.error === null;
    parts.empty.hidden = fleet.rows.length > 0;
    parts.refresh.disabled = refreshing;
    fleet.rows.forEach((row, i) => {
      let rowParts = parts.rows.get(row.key);
      if (!rowParts) {
        rowParts = buildRow(row);
        parts.rows.set(row.key, rowParts);
      }
      paintRow(rowParts, row);
      if (parts.list.children[i] !== rowParts.el) parts.list.insertBefore(rowParts.el, parts.list.children[i] ?? null);
    });
    for (const [key, rowParts] of parts.rows) {
      if (fleet.row(key)) continue;
      rowParts.el.remove();
      parts.rows.delete(key);
    }
  }

  /** Repaints every card in the page; a card that has left the page is let go. */
  function paintAll() {
    for (const [el, parts] of cards) {
      if (el.isConnected) attached.add(el);
      else if (attached.has(el)) {
        cards.delete(el);
        continue;
      }
      paint(el, parts);
    }
  }

  /** Asks the user a yes or no question in a dialog of its own. Escape answers no. */
  function ask(sentence, label) {
    if (!dialog) {
      const text = h('p', { class: 'engine-confirm-text', id: 'engine-confirm-text' });
      const cancel = h('button', { class: 'action', type: 'submit', value: 'cancel', text: 'Cancel' });
      const ok = h('button', { class: 'action danger', type: 'submit', value: 'ok' });
      dialog = h('dialog', { class: 'engine-confirm', 'aria-labelledby': 'engine-confirm-text' }, h('form', { method: 'dialog' }, text, h('div', { class: 'engine-confirm-actions' }, cancel, ok)));
      // The page's Escape key can stop a reply; here it only closes the question.
      dialog.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') event.stopPropagation();
      });
      document.body.append(dialog);
    }
    const shown = dialog;
    shown.querySelector('.engine-confirm-text').textContent = sentence;
    shown.querySelector('button[value="ok"]').textContent = label;
    shown.returnValue = '';
    return new Promise((resolve) => {
      shown.addEventListener('close', () => resolve(shown.returnValue === 'ok'), { once: true });
      shown.showModal();
      shown.querySelector('button[value="cancel"]').focus();
    });
  }

  // Two questions can come at once from two rows; the second waits until the first is answered.
  let asking = Promise.resolve();
  function confirm(sentence, label) {
    const answer = asking.then(() => ask(sentence, label));
    asking = answer.then(() => {}, () => {});
    return answer;
  }

  async function list() {
    fleet.list(await call('list_strategies', {}));
  }

  /** Runs one action on one engine: ask first when the rule says so, call, then list again. */
  async function act(key, kind, mode) {
    if (fleet.rowView(key).busy) return paintAll();
    const shown = fleet.row(key);
    fleet.begin(key, kind);
    paintAll();
    try {
      let row = shown;
      if (kind === 'start') {
        await list();
        row = fleet.row(key);
        if (!row) return fleet.settle(key, shown.name + ' is no longer listed.');
        if (row.state === 'running') return fleet.settle(key);
      }
      const sentence = confirmText({ kind, row, mode });
      if (sentence && !(await confirm(sentence, kind === 'mode' ? 'Set to live' : 'Start'))) return fleet.settle(key);
      await call(TOOLS[kind], { strategy_id: row.strategyId, te_id: row.teId, ...(kind === 'mode' ? { mode } : {}) });
      const action = { kind, row, mode, at: Date.now() };
      onAction(actionLine(action));
      preface.add(action);
      try {
        await list();
      } catch (error) {
        fleet.failList(messageOf(error));
      }
      fleet.settle(key);
    } catch (error) {
      fleet.settle(key, messageOf(error));
    } finally {
      paintAll();
    }
  }

  async function refresh() {
    refreshing = true;
    paintAll();
    try {
      await list();
    } catch (error) {
      fleet.failList(messageOf(error));
    }
    refreshing = false;
    paintAll();
  }

  function onClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    const row = fleet.row(target.closest('li')?.dataset.key);
    if (target.closest('.engine-refresh')) refresh();
    else if (row && target.closest('.engine-toggle')) act(row.key, actionFor(row));
    else if (row && target.closest('.engine-open')) openWorkstation(row);
  }

  function onChange(event) {
    const select = /** @type {HTMLSelectElement} */ (event.target);
    const key = select.closest('li')?.dataset.key;
    if (key && select.matches('.engine-mode')) act(key, 'mode', select.value);
  }

  return {
    /** The card for one `list_strategies` call. It shows the newest listing, which this call is unless a newer one was taken. @param {{ id: string, result: any }} toolCall */
    card(toolCall) {
      const el = h('section', { class: 'engine-card', 'aria-label': 'Engines', 'data-call': toolCall.id });
      el.addEventListener('click', onClick);
      el.addEventListener('change', onChange);
      cards.set(el, skeleton(el));
      fleet.adopt(toolCall.id, toolCall.result);
      paintAll();
      return el;
    },

    /** Claude started or stopped an engine: look again, quietly. @param {{ server: string, tool: string, ok: boolean }} toolCall */
    toolFinished({ server, tool, ok }) {
      if (server !== 'polysim' || tool === 'list_strategies' || !ok || fleet.rows.length === 0) return;
      list().then(paintAll, (error) => console.warn('the engines could not be listed again:', error));
    },

    /** The saved thread's listings: the newest shows, marked old, and none of them is taken again. @param {{ tools?: any[] }[]} history */
    restore(history) {
      const listings = history
        .flatMap((entry) => entry.tools ?? [])
        .filter((tool) => tool.server === 'polysim' && tool.tool === 'list_strategies' && tool.ok === true);
      listings.slice(0, -1).forEach((tool) => fleet.know(tool.id));
      const newest = listings.at(-1);
      if (newest) fleet.adopt(newest.id, newest.result, { stale: true });
    },

    /** The line for the next message, or null. */
    takePreface: () => preface.take(),

    /** Puts a line back that was taken for a send that was refused. @param {string} text */
    giveBackPreface: (text) => preface.giveBack(text),
  };
}
