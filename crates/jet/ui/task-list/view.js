// The task list page in the main column: four counts that filter, one add bar, Overdue, Today with its done tasks,
// Tomorrow, Later, the done pile, and the goals as a rail of cards or a band of meters. It is drawn over the page's own
// state, so that a re-read never takes away an open edit, a drag, a done row still in place, a menu, or the focus.

import { h } from '../dom.js';
import { CONFIRM_MS } from '../plan/taps.js';
import { DAY_NAMES, STATE_NAMES, agendaGroups, keyboardMove, matches, nextState, oneLine, putBackState, summaryCounts } from './model.js';
import { textButton } from './rows.js';
import { createDrag } from './drag.js';
import { createKeys } from './keys.js';
import { createParts } from './parts.js';
import { LATE_ROWS, drawFilterLine, drawGoalOptions, drawGoals, drawLists, drawPile, drawSkeleton, drawSummary, showParts } from './draw.js';

const LEAVE_MS = 150;
const SAY_MS = 100;
const HEAD_PX = 52;
const WIDE_PX = 920;

const sameFilter = (a, b) => a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && a.goalId === b.goalId);

/**
 * @param {{ store: ReturnType<typeof import('./store.js').createTaskStore>, openChat: (chatId: number) => void,
 *   announce: (message: string) => void }} parts
 */
export function createTaskList({ store, openChat, announce }) {
  const coarse = matchMedia('(pointer: coarse)');
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduced');
  let shown = false, focusOnLoad = false, painting = false, pileOpen = false, goneWords = '';
  /** The open row or goal: `{ kind: 'task' | 'goal', id, field, before, armed, armTimer, finished }`, or null. */
  let open = null;
  /** What shows: null for all, 'late', 'today', 'progress', 'done', or `{ goalId }`. It is the page's own and never sent. */
  let filter = null;
  /** The task whose move menu is open, or null. */
  let menuId = null;
  let lateOpen = false, doneTodayOpen = false, goalsOpen = false, wide = false;
  let moveAllTimer = 0, moveAllArmed = false;
  /** Done rows that stay in their place, green, until the boxes have been left alone for a while. */
  const lingering = new Map();
  let lingerTimer = 0;
  const countListeners = new Set();
  let sayTimer = 0;
  const say = (words) => { clearTimeout(sayTimer); sayTimer = setTimeout(() => announce(words), SAY_MS); };

  const parts = createParts({
    add: () => add(),
    moveAll: () => moveAll(),
    toggleLate: () => { lateOpen = !lateOpen; paint(); },
    toggleDoneToday: () => { doneTodayOpen = !doneTodayOpen; paint(); },
    toggleGoals: () => { goalsOpen = !goalsOpen; paint(); },
    toggleFold: () => { pileOpen = !pileOpen; paint(); },
  });
  const { title, alert, notice, stateBlock, loading, addField, addDay, addGoal, syncActive, showAddError, goalsEl, filterLine, column, rail, el } = parts;

  // The goals are one block: the rail's cards from 920 px, else the band's meters under the add bar, so the Tab
  // order follows what is seen.
  new ResizeObserver(() => {
    const next = el.clientWidth >= WIDE_PX;
    if (next === wide || el.hidden) return;
    wide = next;
    if (wide) rail.append(goalsEl); else column.insertBefore(goalsEl, filterLine);
    paint();
  }).observe(el);

  const drag = createDrag({
    root: column, scroller: el, top: () => HEAD_PX,
    onStart(id) { if (open) closeRow(true); closeMenu(false); store.keep('task', id); },
    onDrop(id, place, fromTop) {
      store.release();
      if (place === null || !move(id, place)) { paint(); return; }
      settle(id, fromTop);
    },
  });

  const focusKey = (key) => el.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  const keys = createKeys({
    el, summary: parts.summary, addField,
    view: {
      store, get act() { return act; }, filter: () => filter, setFilter: (next) => setFilter(next), cancelOpen: (target) => cancelOpen(target),
      openMenu: (task) => openMenu(task), closeMenu: (refocus) => closeMenu(refocus), openRow: (...args) => openRow(...args),
      move: (id, place) => move(id, place), focusKey, say,
    },
  });

  // ---- What the person does.

  async function add() {
    const words = addField.value.trim();
    if (!words) return;
    const list = store.state.list;
    const day = addDay.value, goalId = addGoal.value === '' ? null : Number(addGoal.value);
    const goal = list?.goals.find((item) => item.id === goalId) ?? null;
    addField.value = '';
    showAddError('');
    const result = await store.add(words, day, goalId);
    if (result.ok) {
      // An add that the filter would hide clears it, so the new row is always in sight.
      const hidden = filter !== null && !matches({ day, goalId, late: false, state: 'not_started', doneAt: null }, filter, list);
      if (hidden) { filter = null; paint(); }
      say(`Added ${words} to ${DAY_NAMES[day]}${goal ? `, under ${goal.title}` : ''}.${hidden ? ' Showing all tasks.' : ''}`);
    } else {
      if (addField.value === '') addField.value = words;
      showAddError(result.notice.replace(/Try again\.$/, 'Press Add to try again.'));
    }
    syncActive();
  }


  /** @returns {boolean} whether the task was there to move */
  function move(id, place) {
    const task = store.state.list?.tasks.find((item) => item.id === id);
    if (!task) return false;
    store.change(id, place, 'The task could not be moved');
    const group = agendaGroups(store.state.list)[place.day];
    const at = group.findIndex((item) => item.id === id);
    say(`${task.title} moved to ${DAY_NAMES[place.day]}${at < 0 ? '' : `, ${at + 1} of ${group.length}`}.`);
    return true;
  }

  /** A dropped row slides the last few pixels from where it was let go into its place. */
  function settle(id, fromTop) {
    const row = el.querySelector(`.tl-task[data-id="${id}"]`);
    if (!row || reduced()) return;
    row.style.transform = `translateY(${fromTop - row.getBoundingClientRect().top}px)`;
    row.getBoundingClientRect();
    row.classList.add('is-settling');
    row.style.transform = '';
  }

  /** Keeps a task about to be done in its place, with what it was before, so a tap can put it back where it was. */
  function linger(task) {
    const list = store.state.list;
    const group = task.late ? 'late' : task.day;
    lingering.set(task.id, { before: task, group, at: agendaGroups(list)[group].findIndex((item) => item.id === task.id), index: list.tasks.findIndex((item) => item.id === task.id) });
    restartLinger();
  }

  const sayState = (task, state) => say(`${task.title} is ${STATE_NAMES[state].toLowerCase()}.`);

  function restartLinger() {
    clearTimeout(lingerTimer);
    if (lingering.size) lingerTimer = setTimeout(endLinger, CONFIRM_MS);
  }

  /** The done rows leave for Done today together, folding away; the focus goes to the row after the one it was on. */
  function endLinger() {
    const rows = [...el.querySelectorAll('.tl-task[data-lingering="true"]')];
    const focused = document.activeElement?.closest?.('.tl-task[data-lingering="true"]');
    let nextKey = null;
    if (focused) {
      const items = [...focused.closest('ul').children];
      const index = items.indexOf(focused);
      const stay = items.filter((row) => row.dataset.lingering !== 'true' && row.matches('.tl-task'));
      const after = stay.find((row) => items.indexOf(row) > index) ?? stay.filter((row) => items.indexOf(row) < index).at(-1);
      nextKey = after ? `mark-${after.dataset.id}` : 'add';
    }
    const finish = () => {
      lingering.clear();
      paint();
      if (nextKey) focusKey(nextKey);
    };
    if (reduced() || rows.length === 0) { finish(); return; }
    for (const row of rows) { row.style.height = `${row.offsetHeight}px`; row.classList.add('is-leaving'); }
    requestAnimationFrame(() => { for (const row of rows) row.style.height = '0px'; });
    setTimeout(finish, LEAVE_MS);
  }

  function setFilter(next) {
    const was = filter;
    filter = sameFilter(next, filter) ? null : next;
    if (filter !== null && typeof filter === 'object') addGoal.value = String(filter.goalId);
    else if (was !== null && typeof was === 'object') addGoal.value = '';
    if (open) closeRow(true);
    closeMenu(false);
    paint();
    say(filter === null ? 'Showing all tasks.' : filterLine.firstChild.textContent);
  }

  function moveAll() {
    const ids = agendaGroups(store.state.list).late.filter((task) => matches(task, filter, store.state.list)).map((task) => task.id);
    if (!moveAllArmed) {
      moveAllArmed = true;
      clearTimeout(moveAllTimer);
      moveAllTimer = setTimeout(() => { moveAllArmed = false; paint(); }, CONFIRM_MS);
      paint();
      return;
    }
    clearTimeout(moveAllTimer);
    moveAllArmed = false;
    store.moveAllToToday(ids);
    say(`Moved ${ids.length} to Today.`);
    focusKey(`chip-${ids[0]}`);
  }

  function openMenu(task) {
    menuId = task.id;
    paint();
    focusKey(`menu-${task.late ? 'today' : task.day}-${task.id}`);
  }

  function closeMenu(refocus) {
    if (menuId === null) return;
    const id = menuId;
    menuId = null;
    paint();
    if (refocus) focusKey(`chip-${id}`);
  }

  const act = {
    mark(task, button) {
      const lingered = lingering.get(task.id);
      if (lingered) {
        lingering.delete(task.id);
        const state = putBackState(lingered.before);
        store.change(task.id, { state }, 'The task could not be changed', lingered.index);
        sayState(task, state);
      } else {
        const state = nextState(task);
        if (state === 'done' && task.doneAt === null) linger(task);
        store.change(task.id, { state }, 'The task could not be changed');
        sayState(task, state);
      }
      restartLinger();
      button.focus({ preventScroll: true });
    },
    open: (task, how) => openRow('task', task, how),
    openGoal(goal, how) {
      if (open?.kind === 'goal' && open.id === goal.id) closeRow(true, true);
      else openRow('goal', goal, how);
    },
    pickGoal: (goal) => setFilter({ goalId: goal.id }),
    toggleMenu: (task) => (menuId === task.id ? closeMenu(true) : openMenu(task)),
    setState(task, state) {
      if (state === task.state) return;
      if (state === 'done') { closeRow(true); linger(task); }
      store.change(task.id, { state }, 'The task could not be changed');
      sayState(task, state);
      if (state === 'done') focusKey(`mark-${task.id}`);
    },
    setGoal(task, goalId) { store.change(task.id, { goalId }, 'The task could not be changed'); },
    /** A day chosen in the move menu or the open row. Today for a late task gives it today's date. */
    setDay(task, day, from) {
      if (from === 'menu') menuId = null; else closeRow(true);
      if (task.late || day !== task.day) move(task.id, { day });
      else paint();
      focusKey(from === 'menu' ? `chip-${task.id}` : `title-${task.id}`);
    },
    step(task, direction) {
      const place = keyboardMove(store.state.list, task.id, direction, filter !== null);
      if (place) move(task.id, place);
      else if (task.late) say('Move it with its chip.');
      else if (filter !== null) say('Show all to reorder.');
    },
    openChat(task) {
      const chat = task.chatId ?? store.state.list?.mainChatId;
      closeRow(true);
      if (chat != null) openChat(chat);
    },
    remove(task) {
      if (!open?.armed) { arm(); return; }
      deleteTask(task);
    },
    openGoalChat(goal) { closeRow(true); if (goal.chatId != null) openChat(goal.chatId); },
    async closeGoal(goal) {
      if (!open?.armed) { arm(); return; }
      const goals = store.state.list.goals;
      const next = goals[goals.findIndex((item) => item.id === goal.id) + 1] ?? goals.find((item) => item.id !== goal.id);
      closeRow(false);
      if (sameFilter(filter, { goalId: goal.id })) filter = null;
      const result = await store.closeGoal(goal.id);
      if (result.ok) say(`${goal.title} is done.`);
      if (next) focusKey(`goal-${next.id}`); else addField.focus({ preventScroll: true });
    },
  };

  function deleteTask(task) {
    const row = el.querySelector(`.tl-task[data-id="${task.id}"]`);
    const list = row?.closest('ul');
    const siblings = list ? [...list.children].filter((item) => item.matches('.tl-row')) : [];
    const index = siblings.indexOf(row);
    const next = siblings[index + 1] ?? siblings[index - 1];
    closeRow(false);
    lingering.delete(task.id);
    store.remove(task.id);
    say(`Deleted ${task.title}.`);
    focusKey(next ? `mark-${next.dataset.id}` : list?.dataset.list === 'done' ? 'fold-done' : 'add');
  }

  function arm() {
    clearTimeout(open.armTimer);
    open.armed = true;
    open.armTimer = setTimeout(() => { if (open) { open.armed = false; paint(); } }, CONFIRM_MS);
    paint();
  }

  /** The title field of an open task: one line, Enter saves, and it grows with its words. */
  function taskField(item) {
    const field = h('textarea', { class: 'tl-field', rows: '1', 'aria-label': 'Task title', maxlength: '300', enterkeyhint: 'done', autocomplete: 'off', 'data-key': `field-task-${item.id}` });
    field.value = item.title;
    const grow = () => { if (!CSS.supports('field-sizing', 'content')) { field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px`; } };
    field.addEventListener('input', () => {
      if (/[\r\n\t]/.test(field.value)) {
        const caret = oneLine(field.value.slice(0, field.selectionStart)).length;
        field.value = oneLine(field.value);
        field.setSelectionRange(caret, caret);
      }
      grow();
    });
    requestAnimationFrame(grow);
    return field;
  }

  function openRow(kind, item, how, armed = false) {
    if (open?.kind === kind && open.id === item.id) return;
    if (open) closeRow(true);
    closeMenu(false);
    const field = kind === 'goal'
      ? h('input', { class: 'tl-goal-field', type: 'text', value: item.title, 'aria-label': 'Goal title', maxlength: '200', enterkeyhint: 'done', autocomplete: 'off', 'data-key': `field-goal-${item.id}` })
      : taskField(item);
    field.value = item.title;
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); closeRow(true, true); }
    });
    const finished = kind === 'task' && item.doneAt !== null;
    open = { kind, id: item.id, field, before: item.title, armed, armTimer: 0, finished };
    if (armed) open.armTimer = setTimeout(() => { if (open) { open.armed = false; paint(); } }, CONFIRM_MS);
    store.keep(kind, item.id);
    paint();
    const row = openRowEl();
    if (kind === 'goal' && wide) row?.querySelector('.tl-goal-details')?.scrollIntoView({ block: 'nearest' });
    if (armed || finished) row?.querySelector('.tl-delete')?.focus({ preventScroll: true });
    else if (how === 'pointer' && coarse.matches) (kind === 'goal' ? row?.querySelector('.tl-goal-more') : row?.querySelector('.tl-mark'))?.focus({ preventScroll: true });
    else { field.focus({ preventScroll: true }); field.setSelectionRange(field.value.length, field.value.length); }
  }

  const openRowEl = () => (open === null ? null : open.kind === 'goal' ? el.querySelector(`[data-goal="${open.id}"][data-open="true"]`) : el.querySelector(`.tl-task[data-id="${open.id}"][data-open="true"]`));

  /** Closes the open row. `save` keeps a changed title; an empty one is a cancel. `refocus` puts the focus back on it. */
  function closeRow(save, refocus = false) {
    if (!open) return;
    const { kind, id, field, before, armTimer, finished } = open;
    clearTimeout(armTimer);
    const words = field.value.trim();
    open = null;
    store.release();
    if (save && !finished && words && words !== before) {
      if (kind === 'goal') store.renameGoal(id, words);
      else store.change(id, { title: words }, 'The task could not be renamed');
    }
    paint();
    if (refocus) focusKey(`${kind === 'goal' ? 'goal-more' : 'title'}-${id}`);
  }

  // A click or a focus anywhere outside the open row saves it and closes it; a click outside the menu closes it.
  document.addEventListener('click', (event) => {
    if (painting) return;
    if (menuId !== null && !event.target.closest?.(`.tl-menu, [data-key="chip-${menuId}"]`)) closeMenu(false);
    if (!open) return;
    const row = openRowEl();
    if (row && !row.contains(event.target)) closeRow(true);
  }, true);
  /** Esc in the open row or goal puts its title back and closes it. */
  function cancelOpen(target) {
    if (!open || !openRowEl()?.contains(target)) return false;
    open.field.value = open.before;
    closeRow(false, true);
    return true;
  }

  el.addEventListener('focusout', (event) => {
    if (!open || painting) return;
    const row = openRowEl();
    if (row && event.relatedTarget && !row.contains(event.relatedTarget)) closeRow(true);
  });





  // ---- Drawing.


  const openFor = (kind, id) => (open && open.kind === kind && open.id === id ? { field: open.field, armed: open.armed } : null);

  /** The shown tasks of a part, with the done rows that still linger in their old places. */
  function partRows(list, group, tasks) {
    const rows = tasks.map((task) => ({ task, lingering: false }));
    const mine = [...lingering.entries()].filter(([, l]) => l.group === group).sort((a, b) => a[1].at - b[1].at);
    for (const [id, l] of mine) {
      const now = list.done.find((task) => task.id === id);
      if (!now) { lingering.delete(id); continue; }
      rows.splice(Math.min(l.at, rows.length), 0, { task: now, lingering: true });
    }
    return rows;
  }


  /** `cause` is the store's 'read' or 'write', or 'view' for a change of this page alone, such as the pile's fold. */
  function paint(cause = 'view') {
    const list = store.state.list;
    const counts = list ? summaryCounts(list) : null;
    for (const listener of countListeners) listener({ overdue: counts?.overdue ?? 0, dueToday: counts?.dueToday ?? 0 });
    if (!shown) return;
    if (drag.dragging) return;
    const state = store.state;
    if (state.gone) {
      goneWords = `That ${open?.kind === 'goal' ? 'goal' : 'task'} is no longer in your list.`;
      store.clearGone();
      if (open) { clearTimeout(open.armTimer); open = null; }
    }
    if (cause === 'write' && state.alert === '') goneWords = '';
    painting = true;
    const focused = el.contains(document.activeElement) ? document.activeElement : null;
    const focusedKey = focused?.dataset.key ?? null;
    const caret = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd] : null;
    const scroll = el.scrollTop;
    const words = state.alert || goneWords;
    if (alert.textContent !== words) alert.textContent = words;
    notice.replaceChildren(...(state.refreshFailed ? ['The task list could not be refreshed. ', textButton('Try again', () => store.retry(), { 'data-key': 'refresh-again' })] : []));
    el.setAttribute('aria-busy', String(state.status === 'loading'));
    loading.textContent = state.status === 'loading' ? 'Loading the task list' : '';
    if (state.status === 'failed') stateBlock.replaceChildren(h('p', { text: 'The task list could not be loaded.' }), h('button', { type: 'button', class: 'tl-primary', 'data-key': 'load-again', onClick: () => store.retry(), text: 'Try again' }));
    const ready = state.status === 'ready' && list !== null;
    const empty = ready && list.tasks.length === 0 && list.done.length === 0;
    showParts(parts, { wide, filter }, state.status, ready, empty);
    if (ready) {
      if (filter !== null && typeof filter === 'object' && !list.goals.some((goal) => goal.id === filter.goalId)) filter = null;
      if (menuId !== null && !list.tasks.some((task) => task.id === menuId)) menuId = null;
      const year = new Date().getFullYear(), now = Date.now() / 1000;
      if (!empty && agendaGroups(list).late.length <= LATE_ROWS) lateOpen = false;
      const look = { filter, menuId, lateOpen, doneTodayOpen, goalsOpen, wide, moveAllArmed, pileOpen, act, store, lingering, setFilter, openFor, partRows, tabFor: keys.tabFor, settleTabs: keys.settleTabs };
      drawSummary(parts, look, counts);
      drawGoalOptions(parts, list);
      drawFilterLine(parts, look, list, counts);
      if (!empty) drawLists(parts, look, list, year, now);
      drawGoals(parts, look, list, year);
      drawPile(parts, look, list, year, now);
    } else if (state.status === 'loading') drawSkeleton(parts, { wide });
    el.scrollTop = scroll;
    const again = focusedKey ? el.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`) : null;
    if (again && again !== document.activeElement) {
      again.focus({ preventScroll: true });
      if (caret && (again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement)) again.setSelectionRange(caret[0], caret[1]);
    } else if (!again && focused && !focused.isConnected) title.focus({ preventScroll: true });
    painting = false;
  }

  /** A desktop starts on the first task, or on the add field when there is none. A phone keeps the title. */
  function focusFirst() {
    if (!focusOnLoad || document.activeElement !== title) return;
    focusOnLoad = false;
    const list = store.state.list;
    const target = list.tasks.length === 0 ? addField : el.querySelector('.tl-list .tl-title[tabindex="0"]') ?? addField;
    target.focus({ preventScroll: true });
  }

  store.subscribe((state, cause) => { paint(cause); if (shown && state.list) focusFirst(); });

  return {
    el,
    /** Shows the list. A phone gets the focus on the title, so its keyboard does not cover the list. */
    show({ narrow }) {
      shown = true;
      el.hidden = false;
      paint();
      title.focus({ preventScroll: true });
      // While the list loads the focus waits on the title, and moves into the list once it is there.
      focusOnLoad = !narrow;
      if (store.state.list) focusFirst();
    },
    hide() {
      if (open) closeRow(true);
      if (lingering.size) { clearTimeout(lingerTimer); lingering.clear(); }
      menuId = null;
      lateOpen = false;
      shown = false;
      el.hidden = true;
    },
    /** @param {(counts: { overdue: number, dueToday: number }) => void} listener told the drawer's two counts whenever they may have changed */
    onCount(listener) {
      countListeners.add(listener);
      const counts = store.state.list ? summaryCounts(store.state.list) : null;
      listener({ overdue: counts?.overdue ?? 0, dueToday: counts?.dueToday ?? 0 });
    },
  };
}
