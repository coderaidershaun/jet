// What the plan pane says about Jet's read of the user's objectives, tasks and checks, in plain words.
// Pure, with no DOM, so every wording is tested.

import { KINDS, sizeOf } from '../chat/files.js';
import { isRecord, joined, listOf, numberOrNull, orNull, recordOf, stringOf } from '../chat/thread/cards/guard.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** How a check ended, in the user's words. Only a failed check is in the danger tone; a run that has not ended has no outcome. */
const OUTCOMES = {
  spoke: { words: 'Wrote to you', tone: 'quiet' },
  silent: { words: 'Stayed quiet', tone: 'quiet' },
  held: { words: 'Could not read a source', tone: 'quiet' },
  preempted: { words: 'Stopped because you wrote', tone: 'quiet' },
  interrupted: { words: 'Cut off by a restart', tone: 'quiet' },
  failed: { words: 'Failed', tone: 'bad' },
  stale: { words: 'Skipped, out of date', tone: 'quiet' },
};
const RUNNING = { words: 'Running', tone: 'quiet' };

export const outcomeOf = (outcome) => OUTCOMES[outcome] ?? RUNNING;

/** What a held run found, without the 'held: ' the server writes before the reason ('source unavailable', 'no evidence'). */
export const heldReason = (found) => {
  const reason = stringOf(found).replace(/^held:\s*/i, '');
  return reason.charAt(0).toUpperCase() + reason.slice(1);
};

/** The pane as the server sends it. A part of the wrong kind reads as empty, so the page never throws on it. */
export function readPane(raw) {
  const pane = recordOf(raw);
  const records = (value) => listOf(value).filter(isRecord);
  return {
    timeZone: orNull(pane.timeZone),
    objectives: records(pane.objectives),
    tasks: records(pane.tasks),
    runs: records(pane.runs),
    sharedWithMe: records(pane.sharedWithMe),
    sent: records(pane.sent),
    artifacts: records(pane.artifacts),
  };
}

/** The files the open chat holds; the server sends them newest change first. */
export const chatFiles = (pane, chatId) => pane.artifacts.filter((file) => listOf(file.chats).includes(chatId));

/** 'HTML page · 3 KB · 5 min ago' for a file; `now` is in Unix seconds, `changedAt` in milliseconds. */
export const fileWords = (file, now) => joined(KINDS[file.kind]?.label ?? 'File', numberOrNull(file.bytes) === null ? '' : sizeOf(file.bytes), numberOrNull(file.changedAt) === null ? '' : relativeWords(file.changedAt / 1000 - now));

/** How many other chats hold the file, which is what makes it shared. */
export const otherChats = (file, chatId) => listOf(file.chats).filter((id) => id !== chatId).length;

export const isEmpty = (pane) => !pane.objectives.length && !pane.tasks.length && !pane.runs.length && !pane.sharedWithMe.length && !pane.sent.length;

/** Objectives still being worked on, then those that are finished or dropped. */
export function groupObjectives(objectives) {
  const closed = (objective) => objective.status === 'done' || objective.status === 'dropped';
  return { active: objectives.filter((objective) => !closed(objective)), closed: objectives.filter(closed) };
}

export function stepProgress(steps) {
  const list = listOf(steps);
  return { done: list.filter((step) => recordOf(step).doneAt != null).length, total: list.length };
}

/** '2/5', or nothing for an objective with no steps. */
export function progressWords(steps) {
  const { done, total } = stepProgress(steps);
  return total === 0 ? '' : `${done}/${total}`;
}

/** '1 Feb' for '2026-02-01'; the year is added when it is not `year`. */
export function dateWords(iso, year) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stringOf(iso));
  if (!match) return '';
  const day = `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`;
  return Number(match[1]) === year ? day : `${day} ${match[1]}`;
}

/** The words for the days left, and a tone: 'bad' when overdue, 'warn' in the last 3 days. */
export function daysLeftWords(daysLeft) {
  const days = numberOrNull(daysLeft);
  if (days === null) return { words: '', tone: 'quiet' };
  const plural = (n) => `${n} day${n === 1 ? '' : 's'}`;
  if (days < 0) return { words: `${plural(-days)} overdue`, tone: 'bad' };
  if (days === 0) return { words: 'Due today', tone: 'warn' };
  return { words: `${plural(days)} left`, tone: days <= 3 ? 'warn' : 'quiet' };
}

/** 'Sun 1 Feb' for '2026-02-01', the way an objective's due date reads; the year is added when it is not `year`. */
export function dueDayWords(iso, year) {
  const words = dateWords(iso, year);
  return words && `${WEEKDAYS[new Date(iso + 'T00:00Z').getUTCDay()]} ${words}`;
}

/** 'in 2 days', 'in 3 h', '5 min ago', for a distance in seconds; later is positive. */
export function relativeWords(seconds) {
  const future = seconds >= 0, span = Math.abs(seconds);
  const days = Math.round(span / 86400);
  const [amount, unit] = span < 60 ? [0, ''] : span < 3600 ? [Math.round(span / 60), 'min'] : span < 86400 ? [Math.round(span / 3600), 'h'] : [days, days === 1 ? 'day' : 'days'];
  if (!unit) return future ? 'in a moment' : 'just now';
  return future ? `in ${amount} ${unit}` : `${amount} ${unit} ago`;
}

/** The day a Unix second falls on in `timeZone`, as '2026-01-05'. */
export function isoDay(seconds, timeZone) {
  if (numberOrNull(seconds) === null) return '';
  return new Intl.DateTimeFormat('en-CA', { ...(timeZone ? { timeZone } : {}), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(seconds * 1000));
}

/**
 * A step's due day, said late in the danger tone once it has passed unticked, in amber on the day, and in amber
 * when it lies after `due`, the day its objective is due.
 */
export function stepDueWords(step, today, year, due) {
  const words = dateWords(step.due, year);
  if (!words || step.doneAt != null || !today) return { words, tone: 'quiet' };
  if (step.due < today) return { words: `${words}, late`, tone: 'bad' };
  if (due && step.due > due) return { words: `${words}, after the due date`, tone: 'warn' };
  if (step.due === today) return { words: 'Today', tone: 'warn' };
  return { words, tone: 'quiet' };
}

/**
 * 'Steps end 27 Nov, before the new due date.' while the newest note is a change of dates and the last open step
 * is dated before the day the objective is due: the due date moved and the steps did not follow. Else nothing.
 */
export function stepsEndWords(objective, year) {
  const last = listOf(objective.steps).filter((step) => isRecord(step) && step.doneAt == null && step.due).map((step) => step.due).sort().at(-1);
  return latestNote(objective)?.newDates && last && last < objective.due ? `Steps end ${dateWords(last, year)}, before the new due date.` : '';
}

/** 'Closed 3 Dec' for a done or dropped objective, from the instant it was closed. */
export const closedWords = (objective, timeZone, year) => (numberOrNull(objective.closedAt) === null ? '' : `Closed ${dateWords(isoDay(objective.closedAt, timeZone), year)}`);

/** 'Mon 5 Jan, 09:00' for a Unix second in `timeZone`, with the year when it is not `year`. */
export function dueWords(seconds, timeZone, year) {
  if (numberOrNull(seconds) === null) return '';
  const zone = timeZone ? { timeZone } : {};
  const part = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { ...zone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(seconds * 1000)).map((p) => [p.type, p.value]));
  return `${part.weekday} ${part.day} ${part.month}${Number(part.year) === year ? '' : ' ' + part.year}, ${part.hour}:${part.minute}`;
}

/** The time a Unix second falls at in the user's zone, such as '5 Jan, 09:00'. */
export function clockWords(seconds, timeZone) {
  if (numberOrNull(seconds) === null) return '';
  const zone = timeZone ? { timeZone } : {};
  return new Date(seconds * 1000).toLocaleString('en-GB', { ...zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

const SET_BY = { jet: 'Set by Jet', user: 'Set by you', default: 'Time chosen by default', review: "Set by Jet's review" };
export const setByWords = (setBy) => SET_BY[setBy] ?? SET_BY.jet;
export const kindWords = (kind) => (kind === 'follow_up' ? 'Follow-up' : 'Check');

export const tokensWords = (tokens) => (!numberOrNull(tokens) ? '' : `${tokens.toLocaleString('en-GB')} tokens`);
export const costWords = (cost) => (!numberOrNull(cost) ? '' : `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`);

/** What a check was about: its objective, or 'Follow-up' and the reason Jet gave. */
export function runTitle(run) {
  if (numberOrNull(run.objectiveId) !== null) return stringOf(run.title);
  const why = stringOf(run.why);
  return why ? `Follow-up: ${why}` : 'Follow-up';
}

/** The tone of a note's status word: 'on track' is good, 'at risk' warns, 'blocked' is bad. */
export function noteTone(status) {
  const word = stringOf(status).toLowerCase();
  if (/block|off track|failed/.test(word)) return 'bad';
  if (/risk|behind|late|slip/.test(word)) return 'warn';
  if (/track|done|ahead|complete/.test(word)) return 'good';
  return 'quiet';
}

/** Who an objective is shared with: 'Only you', or 'Bob and the Commercial team'. */
export function sharedWithWords(objective) {
  const shared = recordOf(objective.sharedWith);
  const names = [...listOf(shared.people).map((person) => stringOf(recordOf(person).name)), ...listOf(shared.teams).map((team) => `the ${stringOf(recordOf(team).name)} team`)].filter(Boolean);
  if (names.length === 0) return 'Only you';
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
}

/** The objective's next check that waits or runs, or null. */
export function nextCheck(objective) {
  const open = listOf(objective.tasks).filter((task) => isRecord(task) && (task.state === 'scheduled' || task.state === 'running'));
  return open.sort((a, b) => a.dueAt - b.dueAt)[0] ?? null;
}

/** The newest note of an objective, or null. Notes come oldest first. */
export const latestNote = (objective) => listOf(objective.notes).filter(isRecord).at(-1) ?? null;

/**
 * One key for each thing in the pane that Jet or a colleague did on their own: a check that ran, a check set or
 * moved, a colleague's update, an answer to what the user sent. The user's own taps change objectives, so
 * objectives have no key; a key changes when its thing does.
 */
export function keysOf(pane) {
  return [
    ...pane.tasks.map((t) => `t${t.id}:${t.version}`),
    ...pane.runs.map((r) => `r${r.id}`),
    ...pane.sharedWithMe.map((s) => `s${s.id}:${recordOf(s.latest).at ?? ''}`),
    ...pane.sent.filter((i) => i.state !== 'sent').map((i) => `i${i.id}:${i.state}`),
  ];
}

/** How many things in the pane the user has not seen: keys that were not there when they last opened it. */
export const newCount = (pane, seen) => keysOf(pane).filter((key) => !seen.has(key)).length;

/** Whether an objective needs the user: it is overdue, or its latest note says blocked or at risk. */
export function needsYou(objective) {
  if (objective.status === 'done' || objective.status === 'dropped') return false;
  const tone = noteTone(latestNote(objective)?.status);
  return numberOrNull(objective.daysLeft) < 0 || tone === 'bad' || tone === 'warn';
}

/** Active objectives: those that need the user first, then by due date. */
export function needsFirst(objectives) {
  const byDue = (a, b) => stringOf(a.due).localeCompare(stringOf(b.due));
  return [...objectives.filter(needsYou).sort(byDue), ...objectives.filter((objective) => !needsYou(objective)).sort(byDue)];
}

/** What the user has sent that still waits for an answer. */
export const waitingItems = (sent) => sent.filter((item) => item.closedAt == null);

/**
 * What belongs to the open chat when it is not the main chat: the objectives whose chat it is, Jet's tasks for them
 * and the follow-ups set in it, their runs, and what was sent about them or from it. Null when nothing belongs to it,
 * so the main view shows.
 */
export function scopeOf(pane, chatId, mainId) {
  if (chatId == null || chatId === mainId) return null;
  const objectives = pane.objectives.filter((objective) => objective.chatId === chatId);
  const own = new Set(objectives.map((objective) => objective.id));
  const mine = (item) => own.has(item.objectiveId) || (item.objectiveId == null && item.chatId === chatId);
  const tasks = pane.tasks.filter(mine);
  if (objectives.length === 0 && tasks.length === 0) return null;
  const sent = waitingItems(pane.sent).filter((item) => (own.has(item.objectiveId) && item.objectiveTitle != null) || item.chatId === chatId);
  return { objectives, tasks, runs: pane.runs.filter(mine), sent };
}

/** 'Today', 'Tomorrow' or 'Fri 27 Nov' for the day a Unix second falls on in `timeZone`. */
export function dayWords(seconds, timeZone, now, year) {
  const day = isoDay(seconds, timeZone);
  if (day <= isoDay(now, timeZone)) return 'Today';
  if (day === isoDay(now + 86400, timeZone)) return 'Tomorrow';
  return dueWords(seconds, timeZone, year).split(',')[0];
}

/** '09:00' for a Unix second in `timeZone`. */
export function timeWords(seconds, timeZone) {
  return dueWords(seconds, timeZone, 0).split(', ')[1] ?? '';
}
