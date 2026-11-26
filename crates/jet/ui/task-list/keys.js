// The task list's keyboard: one Tab stop for each list with arrows inside it, the counts' toolbar, the move menu, N to
// add, 1 2 3 for status, Alt and an arrow to move one place, Delete, and Esc to cancel an edit or clear a filter.

import { STATES, keyboardMove } from './model.js';

const CONTROLS = '.tl-mark, .tl-title, .tl-chip, .tl-goal-name, .tl-pick, .tl-goal-more';
const ROWS = '.tl-row, .tl-goal, .tl-meter';
const ROVING = `${CONTROLS}, .tl-sum`;
const KEY_STATES = Object.freeze({ 1: STATES[0], 2: STATES[1], 3: STATES[2] });

const isField = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
const findTask = (list, id) => list.tasks.find((task) => task.id === id) ?? list.done.find((task) => task.id === id) ?? null;

/**
 * Listens on the page for its keys, and keeps which control of each list takes the Tab stop.
 * @param {{ el: HTMLElement, summary: HTMLElement, addField: HTMLInputElement, view: { store: any, act: any, filter: () => any,
 *   setFilter: (next: any) => void, cancelOpen: (target: EventTarget) => boolean, openMenu: (task: any) => void,
 *   closeMenu: (refocus: boolean) => void, openRow: (kind: string, task: any, how: string, armed: boolean) => void,
 *   move: (id: number, place: any) => boolean, focusKey: (key: string) => void, say: (words: string) => void } }} parts
 */
export function createKeys({ el, summary, addField, view }) {
  /** The control of each list that takes the Tab stop. */
  const roving = new Map();

  /** Arrows, Enter and Esc inside the move menu. */
  function menuKey(event) {
    const items = [...event.target.closest('.tl-menu').querySelectorAll('[role="menuitemradio"]')];
    const at = items.indexOf(event.target);
    const go = (index) => { event.preventDefault(); items[(index + items.length) % items.length].focus(); };
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(items.length - 1);
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); view.closeMenu(true); }
    // Tab closes the menu onto its chip, and the browser's own Tab then moves on from there.
    else if (event.key === 'Tab') view.closeMenu(true);
  }

  el.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && view.cancelOpen(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.target.closest?.('.tl-menu')) { menuKey(event); return; }
    if (event.key === 'Escape' && view.filter() !== null && event.target.closest?.('.tl-summary, .tl-filter-line')) {
      event.preventDefault();
      event.stopPropagation();
      view.setFilter(null);
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && event.target.matches?.('.tl-delete')) {
      event.preventDefault();
      event.target.click();
      return;
    }
    if (isField(event.target) || event.metaKey || event.ctrlKey) return;
    if ((event.key === 'n' || event.key === 'N') && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      addField.focus();
      return;
    }
    if (event.target.matches?.('.tl-sum') && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const buttons = [...summary.querySelectorAll('.tl-sum')];
      const next = buttons[(buttons.indexOf(event.target) + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
      event.preventDefault();
      next.focus();
      return;
    }
    rowKey(event);
  });

  /** The keys of a row: arrows between rows and controls, Alt and an arrow to move, 1 2 3 for status, Delete. */
  function rowKey(event) {
    const control = event.target.closest?.(CONTROLS);
    const row = control?.closest(ROWS);
    if (!control || !row || row.closest('[data-open="true"]')) return;
    const holder = row.closest('[data-list]');
    const rows = [...holder.querySelectorAll(ROWS)];
    const controlsOf = (item) => [...item.querySelectorAll(CONTROLS)].filter((other) => other.closest(ROWS) === item);
    const index = controlsOf(row).indexOf(control);
    const go = (target) => {
      const choices = target ? controlsOf(target) : [];
      const next = choices[Math.min(index, choices.length - 1)];
      if (next) { next.focus(); event.preventDefault(); }
    };
    const at = rows.indexOf(row);
    const id = Number(row.dataset.id);
    const task = row.matches('.tl-task') ? findTask(view.store.state.list, id) : null;
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      if (!task || task.doneAt !== null) return;
      if (task.late) { view.say('Move it with its chip.'); return; }
      if (view.filter() !== null) { view.say('Show all to reorder.'); return; }
      const place = keyboardMove(view.store.state.list, id, event.key === 'ArrowUp' ? -1 : 1);
      if (!place) return;
      roving.set(place.day, `title-${id}`);
      view.move(id, place);
      view.focusKey(`title-${id}`);
      el.querySelector(`[data-key="title-${id}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'ArrowDown' && control.matches('.tl-chip')) { event.preventDefault(); view.openMenu(task); }
    else if (event.key === 'ArrowUp') go(rows[at - 1]);
    else if (event.key === 'ArrowDown') go(rows[at + 1]);
    else if (event.key === 'Home') go(rows[0]);
    else if (event.key === 'End') go(rows.at(-1));
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const next = controlsOf(row)[index + (event.key === 'ArrowRight' ? 1 : -1)];
      if (next) { next.focus(); event.preventDefault(); }
    } else if (task && KEY_STATES[event.key] && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      view.act.setState(task, KEY_STATES[event.key]);
    } else if (task && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      view.openRow('task', task, 'keyboard', true);
    }
  }

  el.addEventListener('focusin', (event) => {
    const control = event.target.closest?.(ROVING);
    const list = control?.closest('[data-list]');
    if (!control || !list || !control.dataset.key) return;
    roving.set(list.dataset.list, control.dataset.key);
    for (const other of list.querySelectorAll(ROVING)) other.tabIndex = other === control ? 0 : -1;
  });

  /** Makes sure each list has one Tab stop: the one used last if it is still drawn, else the first title. */
  function settleTabs(list) {
    const key = roving.get(list.dataset.list);
    const controls = [...list.querySelectorAll(ROVING)];
    const chosen = controls.find((item) => item.dataset.key === key) ?? list.querySelector('.tl-title, .tl-goal-name, .tl-pick') ?? controls[0];
    for (const item of controls) item.tabIndex = item === chosen ? 0 : -1;
  }

  return {
    settleTabs,
    /** Whether `key` is the Tab stop of the list `listKey`, as a `tabindex`. */
    tabFor: (listKey) => (key) => (roving.get(listKey) === key ? '0' : '-1'),
  };
}
