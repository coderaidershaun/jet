// The task list page in the main column: Today, Tomorrow, the goals, Later and the done pile, drawn over the page's
// own state so that a re-read never takes away an open edit, a drag, a done row still in place, or the focus.
// It owns which row is open, the armed delete, the done rows that linger and the roving focus of each list.

import { h, icon } from '../dom.js';
import { svgIcon } from '../plan/icons.js';
import { dueDayWords } from '../plan/model.js';
import { CONFIRM_MS } from '../plan/taps.js';
import { DAYS, DAY_NAMES, STATE_NAMES, dayGroups, doneGroups, keyboardMove, nextState, putBackState, todayCount } from './model.js';
import { goalRow, skeletonRow, taskRow, textButton } from './rows.js';
import { createDrag } from './drag.js';

const LEAVE_MS = 150;
const SAY_MS = 100;
const HEAD_PX = 52;
const EXAMPLE = 'I need to ship the kite page by Friday.';

/**
 * @param {{ store: ReturnType<typeof import('./store.js').createTaskStore>, openChat: (chatId: number) => void,
 *   announce: (message: string) => void }} parts
 */
export function createTaskList({ store, openChat, announce }) {
  const coarse = matchMedia('(pointer: coarse)');
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduced');
  let shown = false, focusOnLoad = false, painting = false, pileOpen = false, goneWords = '';
  /** The open row: `{ kind: 'task' | 'goal', id, field, before, armed, armTimer }`, or null. */
  let open = null;
  /** Done rows that stay in their place, green, until the boxes have been left alone for a while. */
  const lingering = new Map();
  let lingerTimer = 0;
  /** The control of each list that takes the Tab stop. */
  const roving = new Map();
  const countListeners = new Set();
  let sayTimer = 0;
  const say = (words) => { clearTimeout(sayTimer); sayTimer = setTimeout(() => announce(words), SAY_MS); };

  const title = h('h1', { class: 'tl-title-head', id: 'tasks-title', tabindex: '-1', text: 'Task list' });
  const alert = h('p', { class: 'tl-alert', role: 'alert' });
  const notice = h('p', { class: 'tl-notice' });
  const stateBlock = h('div', { class: 'tl-state', hidden: true });
  const loading = h('p', { class: 'sr-only', role: 'status' });

  const addField = (day) => {
    const field = h('input', { class: 'tl-add-field', type: 'text', placeholder: 'Add a task', 'aria-label': `Add a task to ${DAY_NAMES[day]}`, enterkeyhint: 'done', autocomplete: 'off', maxlength: '300', 'data-key': `add-${day}` });
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); add(day, field); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); field.value = ''; field.blur(); }
    });
    return field;
  };
  const sections = Object.fromEntries(DAYS.map((day) => {
    const date = h('span', { class: 'tl-date' });
    const list = h('ul', { class: 'tl-list', 'aria-label': DAY_NAMES[day], 'data-list': day });
    const field = addField(day);
    const el = h('section', { class: 'tl-section', 'data-drop-day': day, 'aria-labelledby': `tl-h-${day}` },
      h('div', { class: 'tl-heading' }, h('h2', { id: `tl-h-${day}`, text: DAY_NAMES[day] }), date), list,
      h('div', { class: 'tl-add' }, h('span', { class: 'tl-slot' }, icon('plus')), field));
    return [day, { el, date, list, field }];
  }));
  const goalsList = h('ul', { class: 'tl-list', 'aria-label': 'Goals', 'data-list': 'goals' });
  const invite = h('p', { class: 'tl-invite' }, 'Tell Jet what you are working on, for example ',
    h('button', { type: 'button', class: 'tl-invite-example', 'data-key': 'example', onClick: (event) => event.currentTarget.dispatchEvent(new CustomEvent('jet:draft', { bubbles: true, detail: { text: EXAMPLE } })) }, `“${EXAMPLE}”`));
  const goals = h('section', { class: 'tl-section', 'aria-labelledby': 'tl-h-goals' }, h('div', { class: 'tl-heading' }, h('h2', { id: 'tl-h-goals', text: 'Goals' })), goalsList, invite);
  const foldCount = h('span', { class: 'heading-count' });
  const fold = h('button', { type: 'button', class: 'fold-line tl-fold', 'aria-expanded': 'false', 'aria-controls': 'tl-pile', 'data-key': 'fold-done', onClick: () => { pileOpen = !pileOpen; paint(); } }, h('span', { text: 'Done' }), foldCount, svgIcon('chevron'));
  const pile = h('div', { class: 'tl-pile', id: 'tl-pile', hidden: true });
  const done = h('section', { class: 'tl-done', 'aria-label': 'Done' }, fold, pile);
  const column = h('div', { class: 'tl-column' }, alert, notice, stateBlock, loading, sections.today.el, sections.tomorrow.el, goals, sections.later.el, done);
  const el = h('section', { class: 'tasklist', id: 'tasks-content', 'aria-labelledby': 'tasks-title', hidden: true }, h('header', { class: 'tl-head' }, title), column);

  const drag = createDrag({
    root: column, scroller: el, top: () => HEAD_PX,
    onStart(id) { if (open) closeRow(true); store.keep('task', id); },
    onDrop(id, place, fromTop) {
      store.release();
      if (place === null || !move(id, place)) { paint(); return; }
      settle(id, fromTop);
    },
  });

  const tabFor = (listKey) => (key) => (roving.get(listKey) === key ? '0' : '-1');
  const findTask = (list, id) => list.tasks.find((task) => task.id === id) ?? list.done.find((task) => task.id === id) ?? null;

  // ---- What the person does.

  async function add(day, field) {
    const words = field.value.trim();
    if (!words) return;
    field.value = '';
    const result = await store.add(words, day);
    if (result.ok) say(`Added ${words} to ${DAY_NAMES[day]}.`);
    else if (field.value === '') field.value = words;
  }

  /** @returns {boolean} whether the task was there to move */
  function move(id, place) {
    const task = store.state.list?.tasks.find((item) => item.id === id);
    if (!task) return false;
    store.change(id, place, 'The task could not be moved');
    const groups = dayGroups(store.state.list);
    const at = groups[place.day].findIndex((item) => item.id === id);
    say(`${task.title} moved to ${DAY_NAMES[place.day]}, ${at + 1} of ${groups[place.day].length}.`);
    return true;
  }

  /** A dropped row slides the last few pixels from where it was let go into its place. */
  function settle(id, fromTop) {
    const row = column.querySelector(`.tl-task[data-id="${id}"]`);
    if (!row || reduced()) return;
    row.style.transform = `translateY(${fromTop - row.getBoundingClientRect().top}px)`;
    row.getBoundingClientRect();
    row.classList.add('is-settling');
    row.style.transform = '';
  }

  /** Keeps a task about to be done in its place, with what it was before, so a tap can put it back where it was. */
  function linger(task) {
    const list = store.state.list;
    lingering.set(task.id, { before: task, day: task.day, at: dayGroups(list)[task.day].findIndex((item) => item.id === task.id), index: list.tasks.findIndex((item) => item.id === task.id) });
    restartLinger();
  }

  const sayState = (task, state) => say(`${task.title} is ${STATE_NAMES[state].toLowerCase()}.`);

  function restartLinger() {
    clearTimeout(lingerTimer);
    if (lingering.size) lingerTimer = setTimeout(endLinger, CONFIRM_MS);
  }

  /** The done rows leave for the pile together, folding away; the focus goes to the row after the one it was on. */
  function endLinger() {
    const rows = [...column.querySelectorAll('.tl-task[data-lingering="true"]')];
    const focused = document.activeElement?.closest?.('.tl-task[data-lingering="true"]');
    let nextKey = null;
    if (focused) {
      const list = focused.closest('ul');
      const stay = [...list.children].filter((row) => row.dataset.lingering !== 'true');
      const index = [...list.children].indexOf(focused);
      const after = stay.find((row) => [...list.children].indexOf(row) > index) ?? stay.filter((row) => [...list.children].indexOf(row) < index).at(-1);
      nextKey = after ? `mark-${after.dataset.id}` : `add-${list.dataset.list}`;
    }
    const finish = () => {
      lingering.clear();
      paint();
      if (nextKey) column.querySelector(`[data-key="${CSS.escape(nextKey)}"]`)?.focus({ preventScroll: true });
    };
    if (reduced() || rows.length === 0) { finish(); return; }
    for (const row of rows) { row.style.height = `${row.offsetHeight}px`; row.classList.add('is-leaving'); }
    requestAnimationFrame(() => { for (const row of rows) row.style.height = '0px'; });
    setTimeout(finish, LEAVE_MS);
  }

  const act = {
    mark(task, el) {
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
      el.focus({ preventScroll: true });
    },
    open: (task, how) => openRow('task', task, how),
    openGoal: (goal, how) => openRow('goal', goal, how),
    setState(task, state) {
      if (state === task.state) return;
      if (state === 'done') { closeRow(true); linger(task); }
      store.change(task.id, { state }, 'The task could not be changed');
      sayState(task, state);
      if (state === 'done') column.querySelector(`[data-key="mark-${task.id}"]`)?.focus({ preventScroll: true });
    },
    setGoal(task, goalId) { store.change(task.id, { goalId }, 'The task could not be changed'); },
    moveTo(task, day) {
      closeRow(true);
      move(task.id, { day });
      column.querySelector(`[data-key="title-${task.id}"]`)?.focus({ preventScroll: true });
    },
    step(task, direction) {
      const place = keyboardMove(store.state.list, task.id, direction);
      if (place) move(task.id, place);
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
      closeRow(false);
      const result = await store.closeGoal(goal.id);
      if (result.ok) say(`${goal.title} is done.`);
      column.querySelector('[data-list="goals"] .tl-title, [data-key="example"]')?.focus({ preventScroll: true });
    },
  };

  function deleteTask(task) {
    const row = column.querySelector(`.tl-task[data-id="${task.id}"]`);
    const list = row?.closest('ul');
    const siblings = list ? [...list.children].filter((item) => item.matches('.tl-row')) : [];
    const index = siblings.indexOf(row);
    const next = siblings[index + 1] ?? siblings[index - 1];
    closeRow(false);
    lingering.delete(task.id);
    store.remove(task.id);
    say(`Deleted ${task.title}.`);
    const key = next ? `mark-${next.dataset.id}` : list?.dataset.list && DAYS.includes(list.dataset.list) ? `add-${list.dataset.list}` : 'fold-done';
    column.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  }

  function arm() {
    clearTimeout(open.armTimer);
    open.armed = true;
    open.armTimer = setTimeout(() => { if (open) { open.armed = false; paint(); } }, CONFIRM_MS);
    paint();
  }

  function openRow(kind, item, how, armed = false) {
    if (open?.kind === kind && open.id === item.id) return;
    if (open) closeRow(true);
    const field = h('input', { class: 'tl-field', type: 'text', value: item.title, 'aria-label': kind === 'goal' ? 'Goal title' : 'Task title', maxlength: kind === 'goal' ? '200' : '300', enterkeyhint: 'done', autocomplete: 'off', 'data-key': `field-${kind}-${item.id}` });
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
    if (armed || finished) row?.querySelector('.tl-delete')?.focus({ preventScroll: true });
    else if (how === 'pointer' && coarse.matches) row?.querySelector('.tl-mark, .tl-slot')?.focus?.({ preventScroll: true });
    else { field.focus({ preventScroll: true }); field.setSelectionRange(field.value.length, field.value.length); }
  }

  const openRowEl = () => (open ? column.querySelector(`.tl-${open.kind}[data-id="${open.id}"][data-open="true"]`) : null);

  /** Closes the open row. `save` keeps a changed title; an empty one is a cancel. `refocus` puts the focus on its title. */
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
    if (refocus) column.querySelector(`[data-key="${kind === 'goal' ? 'goal' : 'title'}-${id}"]`)?.focus({ preventScroll: true });
  }

  // A click or a focus anywhere outside the open row saves it and closes it.
  document.addEventListener('click', (event) => {
    if (!open || painting) return;
    const row = openRowEl();
    if (row && !row.contains(event.target)) closeRow(true);
  }, true);
  column.addEventListener('focusout', (event) => {
    if (!open || painting) return;
    const row = openRowEl();
    if (row && event.relatedTarget && !row.contains(event.relatedTarget)) closeRow(true);
  });

  column.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open && openRowEl()?.contains(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      open.field.value = open.before;
      closeRow(false, true);
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && event.target.matches?.('.tl-delete')) {
      event.preventDefault();
      event.target.click();
      return;
    }
    const control = event.target.closest?.('.tl-mark, .tl-title');
    const row = control?.closest('.tl-row');
    if (!control || !row || row.dataset.open === 'true') return;
    const list = row.closest('ul');
    const rows = [...list.children].filter((item) => item.matches('.tl-row'));
    const kind = control.classList.contains('tl-mark') ? '.tl-mark' : '.tl-title';
    const go = (target) => { const next = target?.querySelector(kind); if (next) { next.focus(); event.preventDefault(); } };
    const at = rows.indexOf(row);
    const id = Number(row.dataset.id);
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      if (!row.matches('.tl-task') || row.dataset.lingering === 'true' || list.dataset.list === 'done') return;
      const place = keyboardMove(store.state.list, id, event.key === 'ArrowUp' ? -1 : 1);
      if (!place) return;
      roving.set(place.day, `title-${id}`);
      move(id, place);
      column.querySelector(`[data-key="title-${id}"]`)?.focus({ preventScroll: true });
      column.querySelector(`[data-key="title-${id}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'ArrowUp') go(rows[at - 1]);
    else if (event.key === 'ArrowDown') go(rows[at + 1]);
    else if (event.key === 'Home') go(rows[0]);
    else if (event.key === 'End') go(rows.at(-1));
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const other = row.querySelector(kind === '.tl-mark' ? '.tl-title' : '.tl-mark');
      if (other) { other.focus(); event.preventDefault(); }
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && row.matches('.tl-task')) {
      const task = findTask(store.state.list, id);
      if (task) { event.preventDefault(); openRow('task', task, 'keyboard', true); }
    }
  });
  column.addEventListener('focusin', (event) => {
    const control = event.target.closest?.('.tl-mark, .tl-title');
    const list = control?.closest('ul[data-list]');
    if (!control || !list || !control.dataset.key) return;
    roving.set(list.dataset.list, control.dataset.key);
    for (const other of list.querySelectorAll('.tl-mark, .tl-title')) other.tabIndex = other === control ? 0 : -1;
  });

  // ---- Drawing.

  /** Makes sure each list has one Tab stop: the one used last if it is still drawn, else the first row's title. */
  function settleTabs(list) {
    const key = roving.get(list.dataset.list);
    const controls = [...list.querySelectorAll('.tl-mark, .tl-title')];
    const chosen = controls.find((item) => item.dataset.key === key) ?? list.querySelector('.tl-title') ?? controls[0];
    for (const item of controls) item.tabIndex = item === chosen ? 0 : -1;
  }

  function openFor(kind, id) {
    return open && open.kind === kind && open.id === id ? { field: open.field, armed: open.armed } : null;
  }

  /** The open tasks of a day, with the done rows that still linger in their old places. */
  function dayRows(list, day, groups) {
    const rows = groups[day].map((task) => ({ task, lingering: false }));
    const mine = [...lingering.entries()].filter(([, l]) => l.day === day).sort((a, b) => a[1].at - b[1].at);
    for (const [id, l] of mine) {
      const now = list.done.find((task) => task.id === id);
      if (!now) { lingering.delete(id); continue; }
      rows.splice(Math.min(l.at, rows.length), 0, { task: now, lingering: true });
    }
    return rows;
  }

  function drawLists(list) {
    const year = new Date().getFullYear();
    const groups = dayGroups(list);
    for (const day of DAYS) {
      const { list: ul, date } = sections[day];
      date.textContent = day === 'later' ? '' : dueDayWords(day === 'today' ? list.today : list.tomorrow, year);
      const tab = tabFor(day);
      ul.replaceChildren(...dayRows(list, day, groups).map(({ task, lingering: isLingering }) => taskRow(task, { list, year, act, tab, open: openFor('task', task.id), draggable: !isLingering, lingering: isLingering })));
      settleTabs(ul);
    }
    goalsList.replaceChildren(...list.goals.map((goal) => goalRow(goal, { year, act, tab: tabFor('goals'), open: openFor('goal', goal.id) })));
    settleTabs(goalsList);
    invite.hidden = list.goals.length > 0;
    drawPile(list, year);
  }

  function drawPile(list, year) {
    const shownDone = list.done.filter((task) => !lingering.has(task.id));
    foldCount.textContent = list.doneCount ? String(list.doneCount) : '';
    fold.setAttribute('aria-expanded', String(pileOpen));
    fold.setAttribute('aria-label', list.doneCount ? `Done, ${list.doneCount}` : 'Done');
    pile.hidden = !pileOpen;
    if (!pileOpen) { pile.replaceChildren(); return; }
    if (shownDone.length === 0) { pile.replaceChildren(h('p', { class: 'tl-quiet', text: 'Tasks you finish land here.' })); return; }
    const tab = tabFor('done');
    const ul = h('ul', { class: 'tl-list tl-pile-list', 'aria-label': 'Done tasks', 'data-list': 'done' });
    for (const group of doneGroups(shownDone, list.timeZone ?? 'UTC', Date.now() / 1000, year)) {
      ul.append(h('li', { class: 'tl-day-label', 'aria-hidden': 'true', text: group.label }), ...group.tasks.map((task) => taskRow(task, { list, year, act, tab, open: openFor('task', task.id), draggable: false, lingering: false })));
    }
    settleTabs(ul);
    const olderLoading = store.state.older === 'loading';
    const more = list.done.length < list.doneCount;
    pile.replaceChildren(...[ul,
      more ? textButton(olderLoading ? 'Loading older…' : 'Show older', () => store.loadOlder(), { class: 'text-button tl-older', 'data-key': 'older', 'aria-disabled': olderLoading ? 'true' : null }) : null,
      h('p', { class: 'tl-quiet', text: `Done tasks are kept for ${list.doneKeptDays} days.` })].filter(Boolean));
  }

  function drawSkeleton() {
    sections.today.date.textContent = '';
    sections.today.list.replaceChildren(skeletonRow(), skeletonRow(), skeletonRow());
  }

  /** `cause` is the store's 'read' or 'write', or 'view' for a change of this page alone, such as the pile's fold. */
  function paint(cause = 'view') {
    for (const listener of countListeners) listener(store.state.list ? todayCount(store.state.list) : 0);
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
    const focusKey = focused?.dataset.key ?? null;
    const caret = focused instanceof HTMLInputElement ? [focused.selectionStart, focused.selectionEnd] : null;
    const scroll = el.scrollTop;
    const words = state.alert || goneWords;
    if (alert.textContent !== words) alert.textContent = words;
    notice.replaceChildren(...(state.refreshFailed ? ['The task list could not be refreshed. ', textButton('Try again', () => store.retry(), { 'data-key': 'refresh-again' })] : []));
    const ready = state.list !== null && state.status !== 'failed';
    el.setAttribute('aria-busy', String(state.status === 'loading'));
    loading.textContent = state.status === 'loading' ? 'Loading the task list' : '';
    stateBlock.hidden = state.status !== 'failed';
    if (state.status === 'failed') stateBlock.replaceChildren(h('p', { class: 'tl-state-head', text: 'The task list could not be loaded.' }), textButton('Try again', () => store.retry(), { 'data-key': 'load-again' }));
    for (const day of DAYS) sections[day].el.hidden = state.status === 'failed' || (state.status === 'loading' && day !== 'today');
    for (const part of [goals, done]) part.hidden = !ready;
    for (const day of DAYS) sections[day].el.querySelector('.tl-add').hidden = !ready;
    if (state.status === 'loading' || state.list === null) drawSkeleton();
    else if (ready) drawLists(state.list);
    el.scrollTop = scroll;
    const again = focusKey ? column.querySelector(`[data-key="${CSS.escape(focusKey)}"]`) : null;
    if (again && again !== document.activeElement) {
      again.focus({ preventScroll: true });
      if (caret && again instanceof HTMLInputElement) again.setSelectionRange(caret[0], caret[1]);
    } else if (!again && focused && !focused.isConnected) title.focus({ preventScroll: true });
    painting = false;
  }

  /** A desktop starts on the first task, or on Today's add line when there is none. A phone keeps the title. */
  function focusFirst() {
    if (!focusOnLoad || document.activeElement !== title) return;
    focusOnLoad = false;
    const list = store.state.list;
    const target = list.tasks.length === 0 ? sections.today.field : column.querySelector('.tl-title[tabindex="0"]') ?? sections.today.field;
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
      shown = false;
      el.hidden = true;
    },
    /** @param {(count: number) => void} listener told the number of today's open tasks whenever it may have changed */
    onCount(listener) { countListeners.add(listener); listener(store.state.list ? todayCount(store.state.list) : 0); },
  };
}
