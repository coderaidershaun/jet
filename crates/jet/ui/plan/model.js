// What the plan pane says about Jet's read of the user's objectives, tasks and checks, in plain words.
// Pure, with no DOM, so every wording is tested.

import { isRecord, listOf, numberOrNull, orNull, recordOf, stringOf } from '../chat/thread/cards/guard.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** How a check ended, in the user's words, and a tone the page colours it by. A run that has not ended has no outcome. */
const OUTCOMES = {
  spoke: { words: 'Wrote to you', tone: 'good' },
  silent: { words: 'Stayed quiet', tone: 'quiet' },
  held: { words: 'Could not read a source', tone: 'warn' },
  preempted: { words: 'Stopped because you wrote', tone: 'stopped' },
  interrupted: { words: 'Stopped because you wrote', tone: 'stopped' },
  failed: { words: 'Failed', tone: 'bad' },
  stale: { words: 'Skipped, out of date', tone: 'quiet' },
};
const RUNNING = { words: 'Running', tone: 'running' };

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
  };
}

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

/** '1 Jan to 1 Feb · 31 days'. */
export function rangeWords(objective, year) {
  const days = numberOrNull(objective.durationDays);
  return [`${dateWords(objective.start, year)} to ${dateWords(objective.due, year)}`, days === null ? '' : `${days} day${days === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
}

/** 'in 2 days', 'in 3 h', '5 min ago', for a distance in seconds; later is positive. */
export function relativeWords(seconds) {
  const future = seconds >= 0, span = Math.abs(seconds);
  const [amount, unit] = span < 60 ? [0, ''] : span < 3600 ? [Math.round(span / 60), 'min'] : span < 86400 ? [Math.round(span / 3600), 'h'] : [Math.round(span / 86400), span >= 172800 ? 'days' : 'day'];
  if (!unit) return future ? 'in a moment' : 'just now';
  return future ? `in ${amount} ${unit}` : `${amount} ${unit} ago`;
}

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

export const tokensWords = (tokens) => (numberOrNull(tokens) === null ? '' : `${tokens.toLocaleString('en-GB')} tokens`);
export const costWords = (cost) => (numberOrNull(cost) === null ? '' : `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`);

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

/** The newest note of an objective, or null. Notes come oldest first. */
export const latestNote = (objective) => listOf(objective.notes).filter(isRecord).at(-1) ?? null;

/** One key for each thing in the pane that can be new; a key changes when its thing does. */
export function keysOf(pane) {
  return [
    ...pane.objectives.map((o) => `o${o.id}:${o.version}`),
    ...pane.tasks.map((t) => `t${t.id}:${t.version}`),
    ...pane.runs.map((r) => `r${r.id}`),
    ...pane.sharedWithMe.map((s) => `s${s.id}:${recordOf(s.latest).at ?? ''}`),
    ...pane.sent.map((i) => `i${i.id}:${i.state}`),
  ];
}

/** How many things in the pane the user has not seen: keys that were not there when they last opened it. */
export const newCount = (pane, seen) => keysOf(pane).filter((key) => !seen.has(key)).length;
