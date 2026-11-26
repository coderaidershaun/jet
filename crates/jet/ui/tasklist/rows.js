// The rows of the task list as elements: a task with its box, its title and its facts; a goal with its colour; and
// the strip an open row shows. Every control hands its tap to `act`; nothing here keeps state.

import { h } from '../dom.js';
import { svgIcon } from '../plan/icons.js';
import { DAYS, DAY_NAMES, STATES, STATE_NAMES, goalFacts, goalLabel, keyboardMove, markWords, metaWords } from './model.js';
import { dueDayWords, daysLeftWords } from '../plan/model.js';

/** A text button: the one kind of control the list has, apart from the boxes and the rows. */
export const textButton = (label, onClick, props = {}) => h('button', { type: 'button', class: 'text-button', onClick: (event) => onClick(event.currentTarget), ...props }, label);

/** The box that changes a task's status, one step forward per tap. */
export function markButton(task, act, tabindex) {
  const words = markWords(task);
  return h('button', {
    type: 'button', class: 'tl-mark', role: 'checkbox', 'aria-checked': words.checked, 'aria-label': words.label, title: words.tip,
    'data-key': `mark-${task.id}`, tabindex, onClick: (event) => act.mark(task, event.currentTarget),
  }, h('span', { class: 'tl-box' }, task.state === 'done' ? svgIcon('check') : task.state === 'in_progress' ? svgIcon('dash') : null));
}

function meta(task, ctx) {
  const { goal, fact } = metaWords(task, ctx.list, ctx.year);
  if (!goal && !fact) return null;
  return h('span', { class: 'tl-meta' }, goal ? h('span', { class: 'tl-meta-goal', text: goal }) : null, goal && fact ? h('span', { class: 'tl-sep', text: '·' }) : null, fact ? h('span', { class: 'tl-fact', text: fact }) : null);
}

/**
 * One task. `open` is the field to edit its title in when the row is open, with what else the strip needs.
 * @param {{ list: any, year: number, act: any, tab: (key: string) => string, open: null | { field: HTMLElement, armed: boolean },
 *   draggable: boolean, lingering: boolean }} ctx
 */
export function taskRow(task, ctx) {
  const { act, open } = ctx;
  const stripId = `strip-${task.id}`;
  // A finished record is not edited: an open done row keeps its title as text, and offers Delete only.
  const title = open && task.doneAt !== null ? h('span', { class: 'tl-title tl-title-text', text: task.title })
    : open ? open.field : h('button', {
    type: 'button', class: 'tl-title', 'data-key': `title-${task.id}`, tabindex: ctx.tab(`title-${task.id}`), title: task.title,
    'aria-expanded': 'false', 'aria-controls': stripId, 'aria-keyshortcuts': task.doneAt === null ? 'Alt+ArrowUp Alt+ArrowDown' : null,
    onClick: (event) => act.open(task, event.detail === 0 ? 'keyboard' : 'pointer'),
  }, task.title);
  return h('li', {
    class: 'tl-row tl-task', 'data-id': task.id, 'data-state': task.state, 'data-open': String(Boolean(open)), 'data-lingering': ctx.lingering ? 'true' : null,
    'data-drag-id': ctx.draggable ? task.id : null,
    onClick: (event) => { if (!open && !event.target.closest('.tl-mark, .tl-title')) act.open(task, 'pointer'); },
  }, h('div', { class: 'tl-line' }, markButton(task, act, ctx.tab(`mark-${task.id}`)), title, open ? null : meta(task, ctx)),
  open ? taskStrip(task, ctx, stripId) : null);
}

const pressedButton = (label, pressed, onClick, key) => textButton(label, onClick, { class: 'text-button tl-word', 'aria-pressed': String(pressed), 'data-key': key });

function deleteButton(task, ctx) {
  return textButton(ctx.open.armed ? 'Delete?' : 'Delete', (el) => ctx.act.remove(task, el), { class: `text-button tl-delete${ctx.open.armed ? ' is-armed' : ''}`, 'data-key': `delete-${task.id}` });
}

/** Up or Down in the open row; at the top of Today or the bottom of Later there is nowhere to go, and it says so. */
function stepButton(label, task, direction, ctx) {
  const stuck = keyboardMove(ctx.list, task.id, direction) === null;
  return textButton(label, (el) => ctx.act.step(task, direction, el), { 'data-key': `${label.toLowerCase()}-${task.id}`, 'aria-disabled': stuck ? 'true' : null, title: stuck ? `Already at the ${direction < 0 ? 'top of Today' : 'end of Later'}` : null });
}

/** The strip of an open task: its status, its goal, where it goes, its chat and Delete. A done task offers Delete only. */
function taskStrip(task, ctx, id) {
  const { act, list } = ctx;
  if (task.doneAt !== null) return h('div', { class: 'tl-strip', id, role: 'group', 'aria-label': `Change ${task.title}` }, deleteButton(task, ctx));
  const goals = h('select', { class: 'tl-goal-pick', 'aria-label': 'Goal', 'data-key': `goal-pick-${task.id}`, onChange: (event) => act.setGoal(task, event.currentTarget.value === '' ? null : Number(event.currentTarget.value)) },
    h('option', { value: '', text: 'No goal' }), ...list.goals.map((goal) => h('option', { value: String(goal.id), text: goal.title })));
  goals.value = task.goalId === null ? '' : String(task.goalId);
  return h('div', { class: 'tl-strip', id, role: 'group', 'aria-label': `Change ${task.title}` },
    h('div', { class: 'tl-strip-line' },
      ...STATES.map((state) => pressedButton(STATE_NAMES[state], task.state === state, (el) => act.setState(task, state, el), `state-${state}-${task.id}`)),
      h('label', { class: 'tl-pick' }, h('span', { class: 'tl-word-quiet', text: 'Goal' }), goals)),
    h('div', { class: 'tl-strip-line' },
      h('span', { class: 'tl-word-quiet', text: 'Move to' }),
      ...DAYS.filter((day) => day !== task.day).map((day) => textButton(DAY_NAMES[day], (el) => act.moveTo(task, day, el), { 'data-key': `to-${day}-${task.id}` })),
      stepButton('Up', task, -1, ctx),
      stepButton('Down', task, 1, ctx),
      textButton('Open chat', () => act.openChat(task), { 'data-key': `chat-${task.id}` }),
      deleteButton(task, ctx)));
}

/** One goal: its colour, its title and its facts; open, its deliverable, its dates and the way to mark it done. */
export function goalRow(goal, ctx) {
  const { act, open } = ctx;
  const facts = goalFacts(goal);
  const stripId = `goal-strip-${goal.id}`;
  const line = h('div', { class: 'tl-line' },
    h('span', { class: 'tl-slot' }, h('span', { class: 'tl-dot', 'data-state': goal.state, 'aria-hidden': 'true' })),
    open ? open.field : h('button', { type: 'button', class: 'tl-title', 'data-key': `goal-${goal.id}`, tabindex: ctx.tab(`goal-${goal.id}`), 'aria-label': goalLabel(goal), title: goal.title, 'aria-expanded': 'false', 'aria-controls': stripId, onClick: (event) => act.openGoal(goal, event.detail === 0 ? 'keyboard' : 'pointer') }, goal.title),
    open ? null : h('span', { class: 'tl-facts', 'data-tone': facts.tone, text: facts.words }));
  if (!open) return h('li', { class: 'tl-row tl-goal', 'data-id': goal.id, 'data-state': goal.state, 'data-open': 'false', onClick: (event) => { if (!event.target.closest('.tl-title')) act.openGoal(goal, 'pointer'); } }, line);
  const openTasks = goal.tasks - goal.done;
  const due = [goal.due ? `Due ${dueDayWords(goal.due, ctx.year)}` : '', goal.status === 'paused' ? 'Paused' : daysLeftWords(goal.daysLeft).words, goal.tasks ? `${goal.done} of ${goal.tasks} done` : ''].filter(Boolean).join(' · ');
  const ask = openTasks > 0 ? `Done? Its ${openTasks} open task${openTasks === 1 ? '' : 's'} leave${openTasks === 1 ? 's' : ''} the list.` : 'Done?';
  return h('li', { class: 'tl-row tl-goal', 'data-id': goal.id, 'data-state': goal.state, 'data-open': 'true' }, line,
    h('div', { class: 'tl-strip', id: stripId, role: 'group', 'aria-label': `Change ${goal.title}` },
      goal.deliverable ? h('p', { class: 'tl-deliverable', text: goal.deliverable }) : null,
      due ? h('p', { class: 'tl-goal-facts', text: due }) : null,
      h('div', { class: 'tl-strip-line' },
        textButton('Open chat', () => act.openGoalChat(goal), { 'data-key': `goal-chat-${goal.id}` }),
        textButton(open.armed ? ask : 'Mark done', (el) => act.closeGoal(goal, el), { class: `text-button tl-delete${open.armed ? ' is-armed' : ''}`, 'data-key': `goal-done-${goal.id}` }))));
}

/** A row in the shape of a task while the list loads, with no shimmer. */
export const skeletonRow = () => h('li', { class: 'tl-row tl-skeleton', 'aria-hidden': 'true' }, h('span', { class: 'tl-slot' }, h('span', { class: 'tl-box' })), h('span', { class: 'tl-bar' }));
