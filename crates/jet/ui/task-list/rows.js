// The parts of the task list as elements: a count of the summary, a task with its box, title, words and chip, the move
// menu, the strip of an open row, a goal as a card or a meter with its details, and the shapes shown while loading.
// Every control hands its tap to `act`; nothing here keeps state.

import { h, icon } from '../dom.js';
import { svgIcon } from '../plan/icons.js';
import { daysLeftWords, dueDayWords } from '../plan/model.js';
import { DAYS, DAY_NAMES, STATES, STATE_NAMES, chipWords, clock, goalFacts, goalStats, keyboardMove, markWords, sinceWords } from './model.js';

/** A text button: the one kind of quiet control the list has. */
export const textButton = (label, onClick, props = {}) => h('button', { type: 'button', class: 'tl-text-btn', onClick: (event) => onClick(event.currentTarget), ...props }, ...[label].flat());

/** One of the four counts that filter the list. */
export function summaryButton({ kind, count, word, pressed, tab, onClick }) {
  return h('button', { type: 'button', class: 'tl-sum', 'data-kind': kind, 'data-some': String(count > 0), 'aria-pressed': String(pressed), 'data-key': `sum-${kind}`, tabindex: tab, onClick },
    h('span', { class: 'tl-sum-n' }, kind === 'late' && count > 0 ? icon('alert') : null, String(count)), h('span', { class: 'tl-sum-w', text: word }));
}

/** The box that changes a task's status, one step forward per tap. */
export function markButton(task, act, tabindex) {
  const words = markWords(task);
  return h('button', {
    type: 'button', class: 'tl-mark', role: 'checkbox', 'aria-checked': words.checked, 'aria-label': words.label, title: words.tip,
    'aria-keyshortcuts': '1 2 3', 'data-key': `mark-${task.id}`, tabindex, onClick: (event) => act.mark(task, event.currentTarget),
  }, h('span', { class: 'tl-box' }, task.state === 'done' ? svgIcon('check') : task.state === 'in_progress' ? svgIcon('dash') : null));
}

/** The line under a title: how long it has been in progress, then its goal. A done task says only its goal. */
function meta(task, ctx) {
  const since = task.state === 'in_progress' && task.startedAt !== null ? `In progress ${sinceWords(task.startedAt, ctx.now, ctx.list.timeZone)}` : '';
  if (!since && !task.goalTitle) return null;
  return h('p', { class: 'tl-meta' }, since ? h('span', { class: 'tl-since', text: since }) : null, task.goalTitle ? h('span', { class: 'tl-meta-goal', text: task.goalTitle }) : null);
}

/** The chip that opens the move menu, saying how late, Move, or when. */
function chip(task, ctx) {
  const words = chipWords(task, ctx.list, ctx.year);
  return h('button', {
    type: 'button', class: 'tl-chip', 'data-tone': words.tone, 'aria-haspopup': 'menu', 'aria-expanded': String(ctx.menu), 'aria-label': words.name,
    'data-key': `chip-${task.id}`, tabindex: ctx.tab(`chip-${task.id}`), onClick: () => ctx.act.toggleMenu(task),
  }, words.tone === 'late' ? icon('alert') : null, words.lead ? h('span', { class: 'tl-chip-date', text: words.lead }) : null, words.words, svgIcon('chevron'));
}

/** Today, Tomorrow and Later under the chip, with the current day ticked; a late task has none, and says when it was due. */
function moveMenu(task, ctx) {
  return h('div', { class: 'tl-menu', role: 'menu', 'aria-label': `Move ${task.title}` },
    ...DAYS.map((day) => {
      const current = !task.late && task.day === day;
      return h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(current), tabindex: '-1', 'data-key': `menu-${day}-${task.id}`, onClick: () => ctx.act.setDay(task, day, 'menu') },
        DAY_NAMES[day], current ? svgIcon('check') : null);
    }),
    task.late ? h('p', { class: 'tl-menu-foot', text: `Was due ${dueDayWords(task.date, ctx.year)}` }) : null);
}

/**
 * One task. `open` is the field to edit its title in when the row is open, with what else the strip needs.
 * @param {{ list: any, year: number, now: number, act: any, tab: (key: string) => string, open: null | { field: HTMLElement, armed: boolean },
 *   menu: boolean, filtered: boolean, draggable: boolean, lingering: boolean }} ctx
 */
export function taskRow(task, ctx) {
  const { act, open } = ctx;
  const stripId = `strip-${task.id}`;
  const done = task.doneAt !== null;
  // A finished record is not edited: an open done row keeps its title as text, and offers Delete only.
  const title = open && done ? h('span', { class: 'tl-title tl-title-text', text: task.title })
    : open ? open.field : h('button', {
      type: 'button', class: 'tl-title', 'data-key': `title-${task.id}`, tabindex: ctx.tab(`title-${task.id}`), title: task.title,
      'aria-expanded': 'false', 'aria-controls': stripId, 'aria-keyshortcuts': done ? null : 'Alt+ArrowUp Alt+ArrowDown',
      onClick: (event) => act.open(task, event.detail === 0 ? 'keyboard' : 'pointer'),
    }, task.title);
  const right = open ? null
    : ctx.lingering ? h('span', { class: 'tl-time', text: `Done ${clock(task.doneAt, ctx.list.timeZone)}` })
    : done ? h('span', { class: 'tl-time', text: clock(task.doneAt, ctx.list.timeZone) })
    : chip(task, ctx);
  return h('li', {
    class: `tl-row tl-task${ctx.lingering ? ' is-lingering' : ''}`, 'data-id': task.id, 'data-state': task.state, 'data-open': String(Boolean(open)),
    'data-late': String(task.late), 'data-lingering': ctx.lingering ? 'true' : null, 'data-drag-id': ctx.draggable ? task.id : null,
    onClick: (event) => { if (!open && !event.target.closest('.tl-mark, .tl-title, .tl-chip, .tl-menu')) act.open(task, 'pointer'); },
  }, h('div', { class: 'tl-line' }, markButton(task, act, ctx.tab(`mark-${task.id}`)), open ? title : h('div', { class: 'tl-main' }, title, meta(task, ctx)), right),
  ctx.menu && !open ? moveMenu(task, ctx) : null,
  open ? taskStrip(task, ctx, stripId) : null);
}

/** A row of buttons of which one, or none, is pressed. */
function segments(name, items, current, onPick) {
  return h('span', { class: 'tl-seg', role: 'group', 'aria-label': name },
    ...items.map(([key, words, dataKey]) => h('button', { type: 'button', 'aria-pressed': String(key === current), 'data-key': dataKey, onClick: () => onPick(key) }, words)));
}

const why = (id, words) => h('span', { class: 'tl-why', id }, icon('info'), h('span', { text: words }));

/** Up or Down in the open row, off with its reason for a late task, while a filter is on, and at either end. */
function stepButton(label, task, direction, ctx) {
  const stuck = keyboardMove(ctx.list, task.id, direction, ctx.filtered) === null;
  const reason = task.late ? null : ctx.filtered ? 'Show all to reorder' : `Already at the ${direction < 0 ? 'top of Today' : 'end of Later'}`;
  return textButton(label, () => ctx.act.step(task, direction), {
    'data-key': `${label.toLowerCase()}-${task.id}`, 'aria-disabled': stuck ? 'true' : null,
    'aria-describedby': task.late ? `why-step-${task.id}` : null, title: stuck ? reason : null,
  });
}

function deleteButton(task, ctx) {
  return textButton(ctx.open.armed ? 'Delete?' : 'Delete', () => ctx.act.remove(task), { class: `tl-text-btn tl-delete tl-push${ctx.open.armed ? ' is-armed' : ''}`, 'data-key': `delete-${task.id}` });
}

/** The strip of an open task: its status, its day, its goal, Up and Down, its chat and Delete. A done task offers Delete only. */
function taskStrip(task, ctx, id) {
  const { act, list, year } = ctx;
  const group = (...children) => h('div', { class: 'tl-strip', id, role: 'group', 'aria-label': `Change ${task.title}` }, ...children);
  if (task.doneAt !== null) return group(h('div', { class: 'tl-strip-line' }, deleteButton(task, ctx)));
  const goals = h('select', { class: 'tl-select', 'aria-label': 'Goal', 'data-key': `goal-pick-${task.id}`, onChange: (event) => act.setGoal(task, event.currentTarget.value === '' ? null : Number(event.currentTarget.value)) },
    h('option', { value: '', text: 'No goal' }), ...list.goals.map((goal) => h('option', { value: String(goal.id), text: goal.title })));
  goals.value = task.goalId === null ? '' : String(task.goalId);
  const label = (words) => h('span', { class: 'tl-label', text: words });
  return group(
    h('div', { class: 'tl-strip-line' }, label('Status'),
      segments('Status', STATES.map((state) => [state, STATE_NAMES[state], `state-${state}-${task.id}`]), task.state, (state) => act.setState(task, state))),
    h('div', { class: 'tl-strip-line' }, label('Day'),
      segments('Day', DAYS.map((day) => [day, DAY_NAMES[day], `day-${day}-${task.id}`]), task.late ? null : task.day, (day) => act.setDay(task, day, 'strip')),
      task.late ? why(`why-day-${task.id}`, `Was due ${dueDayWords(task.date, year)}. Today gives it today's date.`) : null),
    h('div', { class: 'tl-strip-line' }, label('Goal'), goals),
    h('div', { class: 'tl-strip-line' },
      stepButton('Up', task, -1, ctx), stepButton('Down', task, 1, ctx),
      textButton([svgIcon('chat'), 'Open chat'], () => act.openChat(task), { 'data-key': `chat-${task.id}` }),
      deleteButton(task, ctx),
      task.late ? why(`why-step-${task.id}`, 'An overdue task keeps its place. Use Day or its chip to move it.') : null));
}

/** A goal's bar: done, then in progress, out of all its tasks. */
function goalBar(goal, stats) {
  const part = (className, count) => {
    const el = h('span', { class: className });
    el.style.width = goal.tasks ? `${(100 * count) / goal.tasks}%` : '0%';
    return el;
  };
  return h('div', { class: 'tl-bar', role: 'img', 'aria-label': `${goal.done} of ${goal.tasks} done, ${stats.inProgress} in progress` }, part('tl-bar-done', goal.done), part('tl-bar-prog', stats.inProgress));
}

/** 'Due Mon 30 Nov · 4 days left', 'Due Tue 24 Nov · 2 days overdue' in the late tone, or 'Paused · due Fri 18 Dec'. */
function dueLine(goal, year) {
  const day = dueDayWords(goal.due, year);
  const left = daysLeftWords(goal.daysLeft);
  const late = goal.status !== 'paused' && left.tone === 'bad';
  const words = goal.status === 'paused' ? `Paused${day ? ` · due ${day}` : ''}` : day ? `Due ${day}${left.words ? ` · ${left.words.toLowerCase()}` : ''}` : left.words;
  return words ? h('span', { class: `tl-goal-due${late ? ' is-late' : ''}` }, late ? icon('alert') : null, words) : null;
}

/** 'Next · 3 days late' then the title of the goal's first open task. */
function nextLine(task, ctx) {
  if (!task) return null;
  const when = task.late ? chipWords(task, ctx.list, ctx.year).words : task.day === 'later' ? dueDayWords(task.date, ctx.year) || 'No date' : DAY_NAMES[task.day];
  return h('div', { class: 'tl-goal-next' },
    h('span', {}, h('b', { text: 'Next' }), ' · ', h('span', { class: `tl-next-when${task.late ? ' is-late' : ''}`, text: when })),
    h('span', { class: 'tl-next-title', title: task.title, text: task.title }));
}

const moreButton = (goal, ctx) => h('button', {
  type: 'button', class: 'tl-goal-more', 'aria-label': `More about ${goal.title}`, 'aria-expanded': String(Boolean(ctx.open)), 'aria-controls': `goal-details-${goal.id}`,
  'data-key': `goal-more-${goal.id}`, tabindex: ctx.tab(`goal-more-${goal.id}`), onClick: (event) => ctx.act.openGoal(goal, event.detail === 0 ? 'keyboard' : 'pointer'),
}, icon('more'));

/** The details behind a goal's "⋯": what it delivers, its title to edit, its chat, and Mark done, which asks first. */
function goalDetails(goal, ctx) {
  if (!ctx.open) return null;
  const openTasks = goal.tasks - goal.done;
  const ask = openTasks > 0 ? `Done? Its ${openTasks} open task${openTasks === 1 ? '' : 's'} leave${openTasks === 1 ? 's' : ''} the list.` : 'Done?';
  return h('div', { class: 'tl-goal-details', id: `goal-details-${goal.id}`, role: 'group', 'aria-label': `Change ${goal.title}` },
    goal.deliverable ? h('p', { class: 'tl-deliverable', title: goal.deliverable, text: goal.deliverable }) : null,
    ctx.open.field,
    h('div', { class: 'tl-goal-actions' },
      textButton([svgIcon('chat'), 'Open chat'], () => ctx.act.openGoalChat(goal), { 'data-key': `goal-chat-${goal.id}` }),
      textButton(ctx.open.armed ? ask : 'Mark done', () => ctx.act.closeGoal(goal), { class: `tl-text-btn tl-delete tl-push${ctx.open.armed ? ' is-armed' : ''}`, 'data-key': `goal-done-${goal.id}` })));
}

/**
 * A goal as a card of the rail: its title that filters the list, its bar, counts, due line and next task.
 * @param {{ list: any, year: number, act: any, tab: (key: string) => string, pressed: boolean, open: null | { field: HTMLElement, armed: boolean } }} ctx
 */
export function goalCard(goal, ctx) {
  const stats = goalStats(ctx.list, goal);
  return h('div', { class: `tl-goal${ctx.pressed ? ' is-pressed' : ''}`, 'data-goal': goal.id, 'data-open': String(Boolean(ctx.open)) },
    h('div', { class: 'tl-goal-top' },
      h('button', { type: 'button', class: 'tl-goal-name', 'aria-pressed': String(ctx.pressed), 'data-key': `goal-${goal.id}`, tabindex: ctx.tab(`goal-${goal.id}`), onClick: () => ctx.act.pickGoal(goal) }, goal.title),
      moreButton(goal, ctx)),
    goalBar(goal, stats),
    h('span', { class: 'tl-goal-facts' }, `${goal.done} of ${goal.tasks} done · ${stats.inProgress} in progress`, stats.late ? ' · ' : null, stats.late ? h('b', { text: `${stats.late} late` }) : null),
    dueLine(goal, ctx.year),
    nextLine(stats.next, ctx),
    goalDetails(goal, ctx));
}

/** A goal as one line of the band: its title that filters the list, '3/7 · 4 days left', "⋯", and a thin bar. */
export function goalMeter(goal, ctx) {
  const facts = goalFacts(goal);
  return h('div', { class: 'tl-goal-item', 'data-goal': goal.id, 'data-open': String(Boolean(ctx.open)) },
    h('div', { class: `tl-meter${ctx.pressed ? ' is-pressed' : ''}` },
      h('button', { type: 'button', class: 'tl-pick', 'aria-pressed': String(ctx.pressed), 'data-key': `goal-${goal.id}`, tabindex: ctx.tab(`goal-${goal.id}`), onClick: () => ctx.act.pickGoal(goal) },
        h('span', { class: 'tl-pick-name', title: goal.title, text: goal.title }), h('span', { class: `tl-pick-facts${facts.tone === 'bad' ? ' is-late' : ''}`, text: facts.words })),
      moreButton(goal, ctx),
      goalBar(goal, goalStats(ctx.list, goal))),
    goalDetails(goal, ctx));
}

const skel = (variant) => h('span', { class: `tl-skel ${variant}` });

/** The shapes the list keeps while it loads, with no shimmer: a count, a goal and a row. */
export const skeletonCount = () => h('div', { class: 'tl-sum', 'aria-hidden': 'true' }, skel('is-count'), skel('is-word'));
export const skeletonGoal = () => h('div', { class: 'tl-goal tl-skel-goal', 'aria-hidden': 'true' }, skel('is-name'), skel('is-bar'), skel('is-word'));
export const skeletonRow = () => h('li', { class: 'tl-row tl-skeleton', 'aria-hidden': 'true' }, h('div', { class: 'tl-line' }, h('span', { class: 'tl-mark' }, h('span', { class: 'tl-skel-box' })), skel('is-title')));
