// The fixed parts of the task list page, built once: the head, the counts, the add bar, the goals block, the four parts
// of the agenda, the empty and loading shapes and the done fold. Drawing fills them in, and their taps go to `on`.

import { h, icon } from '../dom.js';
import { svgIcon } from '../plan/icons.js';
import { DAYS, DAY_NAMES } from './model.js';
import { skeletonRow, textButton } from './rows.js';

const EXAMPLE = 'I need to ship the kite page by Friday.';

/**
 * @param {{ add: () => void, moveAll: () => void, toggleLate: () => void, toggleDoneToday: () => void, toggleGoals: () => void,
 *   toggleFold: () => void }} on
 */
export function createParts(on) {
  const title = h('h1', { class: 'tl-title-head', id: 'tasks-title', tabindex: '-1', text: 'Task list' });
  const alert = h('p', { class: 'tl-alert', role: 'alert' });
  const notice = h('p', { class: 'tl-notice' });
  const stateBlock = h('div', { class: 'tl-state', hidden: true });
  const loading = h('p', { class: 'sr-only', role: 'status' });
  const summary = h('div', { class: 'tl-summary', role: 'toolbar', 'aria-label': 'Show only', 'data-list': 'summary' });

  const addField = h('input', { class: 'tl-add-field', type: 'text', placeholder: 'Add a task', 'aria-label': 'New task title', enterkeyhint: 'done', autocomplete: 'off', maxlength: '300', 'aria-keyshortcuts': 'N', 'data-key': 'add' });
  const addDay = h('select', { class: 'tl-select', 'aria-label': 'Day', 'data-key': 'add-day' }, ...DAYS.map((day) => h('option', { value: day, text: DAY_NAMES[day] })));
  const addGoal = h('select', { class: 'tl-select', 'aria-label': 'Goal', 'data-key': 'add-goal' });
  const addButton = h('button', { type: 'submit', class: 'tl-primary', 'data-key': 'add-button', text: 'Add' });
  const addError = h('p', { class: 'tl-add-error', id: 'tl-add-error', hidden: true });
  const addBar = h('form', { class: 'tl-add', 'aria-label': 'Add a task', onSubmit: (event) => { event.preventDefault(); on.add(); } },
    icon('plus'), addField, h('span', { class: 'tl-add-opts' }, addDay, addGoal), addButton);
  // Under 480 px the Day and Goal line shows only while the bar is in use, so it takes one line at rest.
  const syncActive = (focusTo = document.activeElement) => addBar.classList.toggle('is-active', addBar.contains(focusTo) || addField.value !== '');
  addBar.addEventListener('focusin', () => syncActive());
  addBar.addEventListener('focusout', (event) => syncActive(event.relatedTarget));
  addField.addEventListener('input', () => { if (!addError.hidden) showAddError(''); syncActive(); });
  addField.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    addField.value = '';
    addField.blur();
  });


  function showAddError(words) {
    addError.textContent = words;
    addError.hidden = words === '';
    addField.setAttribute('aria-invalid', String(words !== ''));
    if (words) addField.setAttribute('aria-describedby', addError.id); else addField.removeAttribute('aria-describedby');
  }

  const goalsList = h('div', { class: 'tl-goal-list', 'data-list': 'goals' });
  const goalsMore = textButton('', on.toggleGoals, { class: 'tl-text-btn tl-more', 'data-key': 'goals-more' });
  const goalInvite = h('p', { class: 'tl-goal-invite', text: 'Jet makes a goal when you agree one in a chat.' });
  const goalsEl = h('section', { class: 'tl-goals', 'aria-labelledby': 'tl-h-goals' }, h('h2', { id: 'tl-h-goals', text: 'Goals' }), goalsList, goalsMore, goalInvite);
  const filterLine = h('p', { class: 'tl-filter-line', hidden: true });

  const sectionOf = (key, name) => {
    const heading = h('h2', { id: `tl-h-${key}` }, key === 'late' ? icon('alert') : null, name);
    const date = h('span', { class: 'tl-date' });
    const count = h('span', { class: 'tl-count' });
    const list = h('ul', { class: 'tl-list', 'aria-label': name, 'data-list': key });
    const more = textButton('', () => {}, { class: 'tl-text-btn tl-more', 'data-key': `more-${key}`, hidden: true });
    const head = h('div', { class: 'tl-heading' }, heading, date, count);
    const el = h('section', { class: 'tl-section', 'data-day': key, 'aria-labelledby': `tl-h-${key}`, ...(key === 'late' ? { 'data-drag-from': 'late' } : { 'data-drop-day': key }) }, head, list, more);
    return { el, head, date, count, list, more };
  };
  const sections = { late: sectionOf('late', 'Overdue'), today: sectionOf('today', 'Today'), tomorrow: sectionOf('tomorrow', 'Tomorrow'), later: sectionOf('later', 'Later') };
  const moveAllButton = textButton('', on.moveAll, { 'data-key': 'move-all' });
  sections.late.head.append(moveAllButton);
  sections.late.more.addEventListener('click', on.toggleLate);
  const doneTodayHead = h('p', { class: 'tl-sub' });
  const doneTodayList = h('ul', { class: 'tl-list', 'aria-label': 'Done today', 'data-list': 'done-today' });
  const doneTodayMore = textButton('', on.toggleDoneToday, { class: 'tl-text-btn tl-more', 'data-key': 'more-done-today' });
  sections.today.el.append(doneTodayHead, doneTodayList, doneTodayMore);

  const emptyBlock = h('section', { class: 'tl-section tl-empty', hidden: true },
    h('p', { class: 'tl-empty-head', text: 'Nothing on your list yet.' }),
    h('p', { class: 'tl-empty-text' }, 'Add a task above, or tell Jet what you are working on, for example ',
      h('button', { type: 'button', class: 'tl-invite-example', 'data-key': 'example', onClick: (event) => event.currentTarget.dispatchEvent(new CustomEvent('jet:draft', { bubbles: true, detail: { text: EXAMPLE } })) }, `“${EXAMPLE}”`)));
  const skeleton = h('section', { class: 'tl-section', 'aria-hidden': 'true', hidden: true },
    h('div', { class: 'tl-heading' }, h('span', { class: 'tl-skel is-heading' })), h('ul', { class: 'tl-list' }, skeletonRow(), skeletonRow(), skeletonRow(), skeletonRow()));

  const foldCount = h('span', { class: 'tl-count' });
  const fold = h('button', { type: 'button', class: 'tl-fold', 'aria-expanded': 'false', 'aria-controls': 'tl-pile', 'data-key': 'fold-done', onClick: on.toggleFold }, h('span', { text: 'Done' }), foldCount, svgIcon('chevron'));
  const pile = h('div', { class: 'tl-pile', id: 'tl-pile', hidden: true });
  const done = h('section', { class: 'tl-done', 'aria-label': 'Done' }, fold, pile);
  const column = h('div', { class: 'tl-column' }, alert, notice, stateBlock, loading, summary, addBar, addError, goalsEl, filterLine,
    sections.late.el, sections.today.el, sections.tomorrow.el, sections.later.el, emptyBlock, skeleton, done);
  const rail = h('aside', { class: 'tl-rail', 'aria-label': 'Goals', hidden: true });
  const el = h('section', { class: 'tasklist', id: 'tasks-content', 'aria-labelledby': 'tasks-title', hidden: true },
    h('header', { class: 'tl-head' }, title), h('div', { class: 'tl-wrap' }, column, rail));

  return { title, alert, notice, stateBlock, loading, summary, addField, addDay, addGoal, addButton, addError, addBar, syncActive, showAddError, goalsList, goalsMore, goalInvite, goalsEl, filterLine, sections, moveAllButton, doneTodayHead, doneTodayList, doneTodayMore, emptyBlock, skeleton, foldCount, fold, pile, done, column, rail, el };
}
