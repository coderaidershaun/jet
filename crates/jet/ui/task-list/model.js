// What the task list knows without a page: the server's read made safe, the parts and counts of the agenda, the words
// of a row and a goal, the status cycle, and each change applied to the page's own copy before the server answers.

import { isRecord, listOf, numberOrNull, orNull, recordOf, stringOf } from '../chat/thread/cards/guard.js';
import { dateWords, daysLeftWords, dueDayWords, isoDay } from '../plan/model.js';

export const DAYS = Object.freeze(['today', 'tomorrow', 'later']);
export const STATES = Object.freeze(['not_started', 'in_progress', 'done']);
export const DAY_NAMES = Object.freeze({ today: 'Today', tomorrow: 'Tomorrow', later: 'Later' });
export const STATE_NAMES = Object.freeze({ not_started: 'Not started', in_progress: 'In progress', done: 'Done' });
const STATE_TIPS = Object.freeze({ not_started: 'Not started. Tap to start.', in_progress: 'In progress. Tap when done.', done: 'Done. Tap to put back.' });

const oneOf = (value, set, fallback) => (set.includes(value) ? value : fallback);

/** One task as the server sends it, or null when it lacks an id. */
function readTask(raw) {
  const task = recordOf(raw);
  const id = numberOrNull(task.id);
  if (id === null) return null;
  const doneAt = numberOrNull(task.doneAt);
  return Object.freeze({
    id, title: stringOf(task.title), goalId: numberOrNull(task.goalId), goalTitle: orNull(task.goalTitle), chatId: numberOrNull(task.chatId),
    date: orNull(task.date), day: doneAt === null ? oneOf(task.day, DAYS, 'later') : null, late: doneAt === null && task.late === true,
    state: doneAt === null ? oneOf(task.state, STATES, 'not_started') : 'done', startedAt: numberOrNull(task.startedAt), doneAt,
  });
}

function readGoal(raw) {
  const goal = recordOf(raw);
  const id = numberOrNull(goal.id);
  if (id === null) return null;
  return Object.freeze({
    id, title: stringOf(goal.title), deliverable: stringOf(goal.deliverable), chatId: numberOrNull(goal.chatId), due: orNull(goal.due),
    daysLeft: numberOrNull(goal.daysLeft), status: goal.status === 'paused' ? 'paused' : 'active', state: oneOf(goal.state, STATES, 'not_started'),
    tasks: numberOrNull(goal.tasks) ?? 0, done: numberOrNull(goal.done) ?? 0,
  });
}

const records = (value, read) => listOf(value).filter(isRecord).map(read).filter(Boolean);

/** GET /api/task-list, or any write's answer. A part of the wrong kind reads as empty, so the page never throws on it. */
export function readTaskList(raw) {
  const list = recordOf(raw);
  const done = records(list.done, readTask).filter((task) => task.doneAt !== null);
  return Object.freeze({
    timeZone: orNull(list.timeZone), today: stringOf(list.today), tomorrow: stringOf(list.tomorrow), mainChatId: numberOrNull(list.mainChatId),
    doneKeptDays: numberOrNull(list.doneKeptDays) ?? 90, doneCount: Math.max(numberOrNull(list.doneCount) ?? 0, done.length), changed: numberOrNull(list.changed),
    goals: records(list.goals, readGoal), tasks: records(list.tasks, readTask).filter((task) => task.doneAt === null), done,
  });
}

/** GET /api/task-list/done: the next older done tasks, and whether there are more. */
export function readDonePage(raw) {
  const page = recordOf(raw);
  return { done: records(page.done, readTask).filter((task) => task.doneAt !== null), more: page.more === true };
}

/** The open tasks in the page's four parts, each in the user's one order. `today` holds no late task. */
export function agendaGroups(list) {
  const groups = { late: [], today: [], tomorrow: [], later: [] };
  for (const task of list.tasks) groups[task.late ? 'late' : task.day].push(task);
  return groups;
}

const isDoneToday = (task, list) => task.doneAt !== null && isoDay(task.doneAt, list.timeZone ?? 'UTC') === list.today;

/** The done tasks of today, newest first, as the read sends them. */
export const doneToday = (list) => list.done.filter((task) => isDoneToday(task, list));

/** The four counts of the summary, which are also the drawer's two. */
export function summaryCounts(list) {
  const groups = agendaGroups(list);
  return {
    overdue: groups.late.length, dueToday: groups.today.length,
    inProgress: list.tasks.filter((task) => task.state === 'in_progress').length, doneToday: doneToday(list).length,
  };
}

/** Whether a task shows under a filter: 'late', 'today', 'progress', 'done', `{ goalId }`, or null for none. */
export function matches(task, filter, list) {
  if (filter === null) return true;
  if (typeof filter === 'object') return task.goalId === filter.goalId;
  switch (filter) {
    case 'late': return task.late;
    case 'today': return task.doneAt === null && task.day === 'today' && !task.late;
    case 'progress': return task.state === 'in_progress';
    case 'done': return isDoneToday(task, list);
    default: throw new Error(`matches: unknown filter ${String(filter)}`);
  }
}

/** Whole days from one 'YYYY-MM-DD' to another; negative when `to` is earlier. */
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00Z`) - Date.parse(`${from}T00:00Z`)) / 86400000);

const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What the chip of an open task says. `lead` is the part a narrow column leaves out, and `name` gives the date in full.
 * @returns {{ tone: 'late' | 'move' | 'date', lead: string, words: string, name: string }}
 */
export function chipWords(task, list, year) {
  const day = dueDayWords(task.date, year);
  if (task.late) return { tone: 'late', lead: '', words: `${plural(daysBetween(task.date, list.today), 'day')} late`, name: `Was due ${day}. Move` };
  switch (task.day) {
    case 'today': case 'tomorrow': return { tone: 'move', lead: '', words: 'Move', name: `Due ${task.day}${day ? `, ${day}` : ''}. Move` };
    case 'later': {
      if (!day) return { tone: 'date', lead: '', words: 'No date', name: 'Later, no date. Move' };
      const until = daysBetween(list.today, task.date);
      if (until < 1 || until > 6) return { tone: 'date', lead: '', words: day, name: `Due ${day}. Move` };
      return { tone: 'date', lead: `${day} · `, words: `in ${until} days`, name: `Due ${day}, in ${until} days. Move` };
    }
    default: throw new Error(`chipWords: unknown day ${String(task.day)}`);
  }
}

/** How long a task has been in progress: 'since 09:30', 'since yesterday', 'since Tue', or 'since 16 Nov · 10 days'. */
export function sinceWords(startedAt, now, timeZone) {
  const zone = timeZone ?? 'UTC';
  const started = isoDay(startedAt, zone), today = isoDay(now, zone);
  const days = daysBetween(started, today);
  if (days <= 0) return `since ${clock(startedAt, zone)}`;
  if (days === 1) return 'since yesterday';
  if (days <= 6) return `since ${WEEKDAY.format(new Date(`${started}T12:00Z`))}`;
  return `since ${dateWords(started, Number(today.slice(0, 4)))} · ${days} days`;
}

/** A goal's facts that the read does not count: its open tasks in progress and late, and its first open task in agenda order. */
export function goalStats(list, goal) {
  const mine = list.tasks.filter((task) => task.goalId === goal.id);
  const groups = agendaGroups({ tasks: mine });
  return {
    inProgress: mine.filter((task) => task.state === 'in_progress').length, late: groups.late.length,
    next: groups.late[0] ?? groups.today[0] ?? groups.tomorrow[0] ?? groups.later[0] ?? null,
  };
}

/** A title as one line: a run of line breaks or tabs, typed or pasted, becomes one space. */
export const oneLine = (text) => text.replace(/[\r\n\t]+/g, ' ');

/** A tap on the box: gray to yellow, yellow to green, and green back to where it was before. */
export function nextState(task) {
  switch (task.state) {
    case 'not_started': return 'in_progress';
    case 'in_progress': return 'done';
    case 'done': return putBackState(task);
    default: throw new Error(`nextState: unknown state ${String(task.state)}`);
  }
}

/** A done task put back is yellow again if it had been started, else gray. */
export const putBackState = (task) => (task.startedAt != null ? 'in_progress' : 'not_started');

/** The state of a plan pane step, which carries the same two times as a task. */
export const stepState = (step) => (step.doneAt != null ? 'done' : step.startedAt != null ? 'in_progress' : 'not_started');

/** What the box says to a screen reader and in its tooltip. */
export function markWords(task) {
  switch (task.state) {
    case 'not_started': case 'in_progress': case 'done':
      return { checked: task.state === 'done' ? 'true' : task.state === 'in_progress' ? 'mixed' : 'false', label: `${task.title}, ${STATE_NAMES[task.state].toLowerCase()}`, tip: STATE_TIPS[task.state] };
    default: throw new Error(`markWords: unknown state ${String(task.state)}`);
  }
}

/** '14:05' for a Unix second in `timeZone`. */
export const clock = (seconds, timeZone) => new Intl.DateTimeFormat('en-GB', { ...(timeZone ? { timeZone } : {}), hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(seconds * 1000));

/** A goal's facts, '2/5 · 3 days left', 'Paused', or '2 days overdue' with the bad tone. */
export function goalFacts(goal) {
  if (goal.status === 'paused') return { words: 'Paused', tone: 'quiet' };
  const progress = goal.tasks ? `${goal.done}/${goal.tasks}` : '';
  const left = daysLeftWords(goal.daysLeft);
  return { words: [progress, left.words].filter(Boolean).join(' · '), tone: left.tone === 'bad' ? 'bad' : 'quiet' };
}

/** The done pile in the days it was done: 'Today', 'Yesterday', then 'Mon 23 Nov'. */
export function doneGroups(done, timeZone, now, year) {
  const today = isoDay(now, timeZone), yesterday = isoDay(now - 86400, timeZone);
  const groups = [];
  for (const task of done) {
    const day = isoDay(task.doneAt, timeZone);
    const label = day === today ? 'Today' : day === yesterday ? 'Yesterday' : dueDayWords(day, year);
    if (groups.at(-1)?.label !== label) groups.push({ label, tasks: [] });
    groups.at(-1).tasks.push(task);
  }
  return groups;
}

/**
 * Alt+Up or Alt+Down on a task, as the change to send: one place among the rows shown in its day, or to the end of the
 * day before, or to the top of the day after. Any move re-dates a task, so a late task is never moved one place, and in
 * Today the late tasks are not counted, so `after` is always a row the person sees. Null at the top of Today, at the
 * bottom of Later, while a filter hides rows, and for a task not in the list.
 */
export function keyboardMove(list, id, direction, filtered = false) {
  const task = list.tasks.find((item) => item.id === id);
  if (!task || task.late || filtered) return null;
  const groups = agendaGroups(list);
  const day = groups[task.day], at = day.findIndex((item) => item.id === id);
  const dayIndex = DAYS.indexOf(task.day);
  if (direction < 0) {
    if (at > 0) return { day: task.day, after: at >= 2 ? day[at - 2].id : null };
    if (dayIndex === 0) return null;
    const before = DAYS[dayIndex - 1];
    return { day: before, after: groups[before].at(-1)?.id ?? null };
  }
  if (at < day.length - 1) return { day: task.day, after: day[at + 1].id };
  if (dayIndex === DAYS.length - 1) return null;
  return { day: DAYS[dayIndex + 1], after: null };
}

/** The date a move gives a task, by the day rule: today's, tomorrow's, or in Later the one it had there, else none. */
function movedDate(task, day, list) {
  switch (day) {
    case 'today': return list.today || task.date;
    case 'tomorrow': return list.tomorrow || task.date;
    case 'later': return task.day === 'later' ? task.date : null;
    default: throw new Error(`movedDate: unknown day ${String(day)}`);
  }
}

/**
 * Puts `task` into `tasks` by the server's placing rule: just after `after` when it is in the day, first for null,
 * and last when `after` is not given or not in the day.
 */
function placed(tasks, task, after) {
  const rest = tasks.filter((item) => item.id !== task.id);
  const inDay = rest.map((item, index) => ({ item, index })).filter(({ item }) => item.day === task.day);
  let at;
  if (after === null) at = inDay.length ? inDay[0].index : rest.length;
  else if (after === undefined) at = inDay.length ? inDay.at(-1).index + 1 : rest.length;
  else {
    const anchor = inDay.find(({ item }) => item.id === after);
    at = anchor ? anchor.index + 1 : inDay.length ? inDay.at(-1).index + 1 : rest.length;
  }
  return [...rest.slice(0, at), task, ...rest.slice(at)];
}

/** The day a stored date falls in, for a task put back from the pile. */
const dayOf = (date, list) => (date === null ? 'later' : date <= list.today ? 'today' : date === list.tomorrow ? 'tomorrow' : 'later');

/**
 * A PATCH of one task applied to the page's copy, as the server will apply it, so it shows at once. `now` is in
 * Unix seconds. `at` is where a task put back from done goes among the open tasks; the server's answer corrects it.
 */
export function applyPatch(list, id, patch, now, at = null) {
  const open = list.tasks.find((task) => task.id === id);
  const done = list.done.find((task) => task.id === id);
  let task = open ?? done;
  if (!task) return list;
  if ('title' in patch) task = { ...task, title: patch.title };
  if ('goalId' in patch) {
    const goal = list.goals.find((item) => item.id === patch.goalId) ?? null;
    task = { ...task, goalId: goal?.id ?? null, goalTitle: goal?.title ?? null, chatId: goal?.chatId ?? list.mainChatId };
  }
  let tasks = list.tasks, doneList = list.done, doneCount = list.doneCount;
  const state = patch.state ?? task.state;
  if (state === 'done' && task.state !== 'done') {
    task = { ...task, state, doneAt: now, day: null, late: false };
    tasks = tasks.filter((item) => item.id !== id);
    doneList = [task, ...doneList];
    doneCount += 1;
  } else if (state !== 'done' && task.state === 'done') {
    task = { ...task, state, doneAt: null, startedAt: state === 'in_progress' ? task.startedAt ?? now : null, day: dayOf(task.date, list), late: task.date !== null && task.date < list.today };
    doneList = doneList.filter((item) => item.id !== id);
    doneCount -= 1;
    const index = at === null ? tasks.length : Math.min(at, tasks.length);
    tasks = [...tasks.slice(0, index), task, ...tasks.slice(index)];
  } else if (state !== task.state) {
    task = { ...task, state, startedAt: state === 'in_progress' ? task.startedAt ?? now : null };
  }
  if (task.doneAt === null && ('day' in patch || 'after' in patch)) {
    const day = patch.day ?? task.day;
    const date = movedDate(task, day, list);
    const sameDay = day === task.day && !('after' in patch);
    task = { ...task, day, date, late: date !== null && date < list.today };
    tasks = sameDay ? tasks.map((item) => (item.id === id ? task : item)) : placed(tasks, task, 'after' in patch ? patch.after : undefined);
  } else if (task.doneAt === null) {
    tasks = tasks.map((item) => (item.id === id ? task : item));
  } else {
    doneList = doneList.map((item) => (item.id === id ? task : item));
  }
  return Object.freeze({ ...list, tasks, done: doneList, doneCount });
}

/** A delete applied to the page's copy. */
export function applyDelete(list, id) {
  const wasDone = list.done.some((task) => task.id === id);
  return Object.freeze({ ...list, tasks: list.tasks.filter((task) => task.id !== id), done: list.done.filter((task) => task.id !== id), doneCount: list.doneCount - (wasDone ? 1 : 0) });
}

/** A goal's rename applied to the page's copy, on the goal and on every task under it. */
export function applyGoalTitle(list, id, title) {
  const rename = (task) => (task.goalId === id ? { ...task, goalTitle: title } : task);
  return Object.freeze({ ...list, goals: list.goals.map((goal) => (goal.id === id ? { ...goal, title } : goal)), tasks: list.tasks.map(rename), done: list.done.map(rename) });
}

const newerFirst = (a, b) => b.doneAt - a.doneAt || b.id - a.id;

/** The done pile with an older page added at its end. */
export function withOlder(list, older) {
  const known = new Set(list.done.map((task) => task.id));
  return Object.freeze({ ...list, done: [...list.done, ...older.filter((task) => !known.has(task.id))] });
}

/**
 * A fresh read keeps the older done tasks the person already paged in: those older than the read's own pile,
 * and in neither of its lists, because a task put back or deleted elsewhere is no longer done.
 */
export function keepOlder(fresh, previous) {
  if (previous === null || previous.done.length <= fresh.done.length) return fresh;
  const last = fresh.done.at(-1);
  const seen = new Set([...fresh.tasks, ...fresh.done].map((task) => task.id));
  const older = previous.done.filter((task) => !seen.has(task.id) && (!last || newerFirst(last, task) < 0));
  return withOlder(fresh, older);
}
