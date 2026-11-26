// Drawing the task list from the read and the page's own state: the counts, the filter line, the four parts of the
// agenda with Done today, the goals, the add bar's goals, the done pile, and which parts show for the state of the read.

import { h } from '../dom.js';
import { svgIcon } from '../plan/icons.js';
import { dueDayWords } from '../plan/model.js';
import { DAYS, agendaGroups, doneGroups, doneToday, matches } from './model.js';
import { goalCard, goalMeter, skeletonCount, skeletonGoal, summaryButton, taskRow, textButton } from './rows.js';

export const LATE_ROWS = 3;
const DONE_ROWS = 5;
const BAND_GOALS = 3;
/** Each status filter: its count in the summary, its word there, and how the filter line names what shows. */
const FILTERS = Object.freeze([
  Object.freeze({ kind: 'late', count: 'overdue', word: 'Overdue', shows: 'overdue' }),
  Object.freeze({ kind: 'today', count: 'dueToday', word: 'Due today', shows: 'due today' }),
  Object.freeze({ kind: 'progress', count: 'inProgress', word: 'In progress', shows: 'in progress' }),
  Object.freeze({ kind: 'done', count: 'doneToday', word: 'Done today', shows: 'done today' }),
]);

export function drawSummary(parts, view, counts) {
  const { summary } = parts;
  const { filter, tabFor, settleTabs, setFilter } = view;
  summary.replaceChildren(...FILTERS.map(({ kind, count, word }) => summaryButton({ kind, count: counts[count], word, pressed: filter === kind, tab: tabFor('summary')(`sum-${kind}`), onClick: () => setFilter(kind) })));
  settleTabs(summary);
}

export function drawFilterLine(parts, view, list, counts) {
  const { filterLine } = parts;
  const { filter, setFilter } = view;
  if (filter === null) { filterLine.replaceChildren(); return; }
  const showAll = textButton('Show all', () => setFilter(null), { 'data-key': 'show-all' });
  if (typeof filter === 'object') {
    const goal = list.goals.find((item) => item.id === filter.goalId);
    const openCount = list.tasks.filter((task) => task.goalId === goal.id).length;
    filterLine.replaceChildren(h('span', {}, 'Showing ', h('b', { text: goal.title }), `: ${openCount} open, ${goal.done} done.`), ' ', showAll);
    return;
  }
  const { count, shows } = FILTERS.find((item) => item.kind === filter);
  const n = counts[count];
  filterLine.replaceChildren(h('span', {}, ...(n ? ['Showing ', h('b', { text: `${n} ${shows}` }), '.'] : [`No tasks ${shows}.`])), ' ', showAll);
}

export function drawLists(parts, view, list, year, now) {
  const { sections, doneTodayList, doneTodayHead, doneTodayMore, moveAllButton } = parts;
  const { filter, act, tabFor, settleTabs, openFor, menuId, partRows, lateOpen, moveAllArmed, lingering, doneTodayOpen } = view;
  const groups = agendaGroups(list);
  const filtered = filter !== null;
  const shownOf = (tasks) => tasks.filter((task) => matches(task, filter, list));
  const ctxFor = (key, task, isLingering) => ({ list, year, now, act, tab: tabFor(key), open: openFor('task', task.id), menu: menuId === task.id, filtered, draggable: !isLingering && !filtered, lingering: isLingering });
  const fill = (key, rows) => {
    const ul = sections[key]?.list ?? doneTodayList;
    ul.replaceChildren(...rows.map(({ task, lingering: isLingering }) => taskRow(task, ctxFor(key, task, isLingering))));
    settleTabs(ul);
  };
  const countWords = (n) => (n ? `${n} ${filtered ? 'shown' : 'open'}` : '');

  const late = shownOf(groups.late);
  const lateRows = partRows(list, 'late', late);
  fill('late', lateOpen ? lateRows : lateRows.slice(0, LATE_ROWS));
  sections.late.el.hidden = lateRows.length === 0;
  sections.late.count.textContent = countWords(late.length);
  sections.late.more.hidden = lateRows.length <= LATE_ROWS;
  sections.late.more.setAttribute('aria-expanded', String(lateOpen));
  sections.late.more.replaceChildren(lateOpen ? 'Show fewer overdue' : `Show ${lateRows.length - LATE_ROWS} more overdue`, lateOpen ? '' : svgIcon('chevron'));
  moveAllButton.hidden = late.length === 0;
  moveAllButton.classList.toggle('is-armed', moveAllArmed);
  moveAllButton.textContent = moveAllArmed ? `Move ${late.length} to Today?` : 'Move all to Today';

  const finished = doneToday(list).filter((task) => !lingering.has(task.id) && matches(task, filter, list));
  const finishedShown = doneTodayOpen ? finished : finished.slice(0, DONE_ROWS);
  doneTodayHead.hidden = doneTodayList.hidden = finished.length === 0;
  doneTodayHead.textContent = `Done today · ${finished.length}`;
  fill('done-today', finishedShown.map((task) => ({ task, lingering: false })));
  doneTodayMore.hidden = finished.length <= DONE_ROWS;
  doneTodayMore.setAttribute('aria-expanded', String(doneTodayOpen));
  doneTodayMore.textContent = doneTodayOpen ? 'Show fewer' : `Show ${finished.length - DONE_ROWS} more`;

  const empties = { today: groups.late.length ? 'Nothing else due today.' : 'Nothing due today.', tomorrow: 'Nothing due tomorrow.', later: 'Nothing later.' };
  for (const day of DAYS) {
    const { el: part, list: ul, date, count } = sections[day];
    const tasks = shownOf(groups[day]);
    const rows = partRows(list, day, tasks);
    fill(day, rows);
    if (rows.length === 0 && !filtered) ul.replaceChildren(h('li', { class: 'tl-quiet', text: empties[day] }));
    part.hidden = filtered && rows.length === 0 && !(day === 'today' && finished.length);
    date.textContent = day === 'later' ? '' : dueDayWords(day === 'today' ? list.today : list.tomorrow, year);
    count.textContent = countWords(tasks.length);
  }
}

export function drawGoals(parts, view, list, year) {
  const { goalsEl, goalsList, goalInvite, goalsMore } = parts;
  const { wide, filter, goalsOpen, act, tabFor, settleTabs, openFor } = view;
  goalsEl.classList.toggle('tl-band', !wide);
  const pressed = (goal) => filter !== null && typeof filter === 'object' && filter.goalId === goal.id;
  const visible = wide || goalsOpen ? list.goals : list.goals.slice(0, BAND_GOALS);
  const draw = wide ? goalCard : goalMeter;
  goalsList.replaceChildren(...visible.map((goal) => draw(goal, { list, year, act, tab: tabFor('goals'), pressed: pressed(goal), open: openFor('goal', goal.id) })));
  settleTabs(goalsList);
  goalsEl.hidden = !wide && list.goals.length === 0;
  goalInvite.hidden = list.goals.length > 0;
  goalsMore.hidden = wide || list.goals.length <= BAND_GOALS;
  goalsMore.setAttribute('aria-expanded', String(goalsOpen));
  goalsMore.textContent = goalsOpen ? 'Show fewer goals' : `Show ${list.goals.length - BAND_GOALS} more goals`;
}

export function drawGoalOptions(parts, list) {
  const { addGoal } = parts;
  const chosen = addGoal.value;
  addGoal.replaceChildren(h('option', { value: '', text: 'No goal' }), ...list.goals.map((goal) => h('option', { value: String(goal.id), text: goal.title })));
  addGoal.value = list.goals.some((goal) => String(goal.id) === chosen) ? chosen : '';
}

export function drawPile(parts, view, list, year, now) {
  const { fold, foldCount, pile } = parts;
  const { lingering, pileOpen, tabFor, settleTabs, act, openFor, store } = view;
  const shownDone = list.done.filter((task) => !lingering.has(task.id));
  foldCount.textContent = list.doneCount ? String(list.doneCount) : '';
  fold.setAttribute('aria-expanded', String(pileOpen));
  fold.setAttribute('aria-label', list.doneCount ? `Done, ${list.doneCount}` : 'Done');
  pile.hidden = !pileOpen;
  if (!pileOpen) { pile.replaceChildren(); return; }
  if (shownDone.length === 0) { pile.replaceChildren(h('p', { class: 'tl-quiet', text: 'Tasks you finish land here.' })); return; }
  const tab = tabFor('done');
  const ul = h('ul', { class: 'tl-list tl-pile-list', 'aria-label': 'Done tasks', 'data-list': 'done' });
  for (const group of doneGroups(shownDone, list.timeZone ?? 'UTC', now, year)) {
    ul.append(h('li', { class: 'tl-day-label', 'aria-hidden': 'true', text: group.label }), ...group.tasks.map((task) => taskRow(task, { list, year, now, act, tab, open: openFor('task', task.id), menu: false, filtered: false, draggable: false, lingering: false })));
  }
  settleTabs(ul);
  const olderLoading = store.state.older === 'loading';
  const more = list.done.length < list.doneCount;
  pile.replaceChildren(...[ul,
    more ? textButton(olderLoading ? 'Loading older…' : 'Show older', () => store.loadOlder(), { class: 'tl-text-btn tl-older', 'data-key': 'older', 'aria-disabled': olderLoading ? 'true' : null }) : null,
    h('p', { class: 'tl-quiet', text: `Done tasks are kept for ${list.doneKeptDays} days.` })].filter(Boolean));
}

export function drawSkeleton(parts, view) {
  const { summary, goalsList, goalsEl, goalsMore, goalInvite } = parts;
  const { wide } = view;
  summary.replaceChildren(skeletonCount(), skeletonCount(), skeletonCount(), skeletonCount());
  goalsList.replaceChildren(skeletonGoal(), skeletonGoal());
  goalsEl.classList.toggle('tl-band', !wide);
  for (const part of [goalsMore, goalInvite]) part.hidden = true;
}

/** Puts each part in or out of sight for the state of the read; drawing a part then hides what it has nothing for. */
export function showParts(parts, view, status, ready, empty) {
  const { stateBlock, skeleton, summary, addBar, goalsEl, rail, emptyBlock, done, filterLine, sections, addField, addDay, addGoal, addButton, addError } = parts;
  const { wide, filter } = view;
  stateBlock.hidden = status !== 'failed';
  skeleton.hidden = status !== 'loading';
  summary.hidden = status === 'failed' || empty;
  addBar.hidden = status === 'failed';
  goalsEl.hidden = status === 'failed';
  rail.hidden = !wide || status === 'failed';
  emptyBlock.hidden = !empty;
  done.hidden = !ready;
  filterLine.hidden = !ready || filter === null;
  for (const part of Object.values(sections)) part.el.hidden = !ready || empty;
  addField.disabled = addDay.disabled = addGoal.disabled = addButton.disabled = status === 'loading';
  addField.placeholder = status === 'loading' ? 'Loading the list…' : 'Add a task';
  if (!ready) addError.hidden = true;
}
