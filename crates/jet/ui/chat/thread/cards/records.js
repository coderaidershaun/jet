// How a call to Jet's own records reads in the thread: one plain line for each command of the
// objectives, tasks and people tools, its result as named fields, and the fold that turns a reply's
// many such calls into one line. Pure, with no DOM.

import { count, isRecord, listOf, orNull, recordOf, stringOf } from './guard.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RECORD_TOOLS = new Set(['objectives_update', 'objectives_list', 'tasks_update', 'tasks_list', 'people_list', 'people_update']);
// A call whose result is one of these asks the user for a tap, so it is drawn as its own card and never folded.
const CARD_KEYS = ['send', 'reply', 'proposal'];

/** 'Wed 25 Nov' from '2026-11-25', or the text as it came when it is not a date. */
export function dayWords(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(stringOf(date));
  if (!match) return stringOf(date);
  const [year, month, day] = match.slice(1).map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] + ' ' + day + ' ' + MONTHS[month - 1];
}

/** 'Wed 25 Nov, 09:00' from the user's local time '2026-11-25T09:00', which needs no time zone sum. */
export function timeWords(local) {
  const time = /T(\d{2}:\d{2})/.exec(stringOf(local));
  return dayWords(local) + (time ? ', ' + time[1] : '');
}

export const isRecordsCall = (call) => call.server === 'jet' && RECORD_TOOLS.has(call.tool);
const isCard = (result) => CARD_KEYS.some((key) => isRecord(recordOf(result)[key]));
const isChange = (call) => call.tool.endsWith('_update');

/** The line of a records call while it runs. */
export const runningWords = (call) => (call.tool.startsWith('people') ? 'Reading the people list' : isChange(call) ? 'Updating your plan' : 'Reading your plan');

/** The line of a records call that failed. A refused send or reply is a message to a colleague, not the plan. */
export function failedWords(call) {
  const action = recordOf(recordOf(call.input).command).action;
  if (call.tool === 'tasks_update' && action === 'send') return 'Your message to a colleague could not go';
  if (call.tool === 'tasks_update' && action === 'reply') return 'Your reply to a colleague could not go';
  return isChange(call) ? 'Jet could not update your plan' : 'Jet could not read your plan';
}

const stepOf = (objective, id) => listOf(objective.steps).map(recordOf).find((step) => step.id === id) ?? {};
const range = (objective) => [objective.start, objective.due].filter(Boolean).map(dayWords).join(' – ');

function objectiveLine(command, objective) {
  const title = stringOf(objective.title);
  switch (command.action) {
    case 'create':
      return 'Recorded ' + title;
    case 'edit':
      if (command.status === 'paused') return 'Paused ' + title;
      if (command.status === 'active') return 'Resumed ' + title;
      return 'Changed ' + title;
    case 'step_add':
      return 'Added the step ' + (orNull(command.title) ?? stringOf(recordOf(listOf(objective.steps).at(-1)).title));
    case 'step_tick':
      if (command.started === true) return 'Started ' + stringOf(stepOf(objective, command.step).title);
      if (command.started === false) return 'Put ' + stringOf(stepOf(objective, command.step).title) + ' back to not started';
      return (command.done === false ? 'Unticked ' : 'Ticked ') + stringOf(stepOf(objective, command.step).title);
    case 'step_edit': {
      const step = stepOf(objective, command.step);
      return command.due ? 'Moved ' + stringOf(step.title) + ' to ' + dayWords(command.due) : 'Renamed a step to ' + stringOf(step.title);
    }
    case 'dates':
      return 'Moved ' + title + ' to ' + range(objective);
    case 'note':
      return 'Noted: ' + stringOf(command.status);
    case 'close':
      return command.outcome === 'dropped' ? 'Dropped ' + title : 'Closed ' + title + ' as done';
    default:
      return 'Changed ' + title;
  }
}

function objectiveFields(command, objective) {
  const steps = listOf(objective.steps).map(recordOf).map((step) => (step.doneAt ? '✓ ' : '○ ') + stringOf(step.title) + (step.due ? ' · ' + dayWords(step.due) : ''));
  const note = command.action === 'note' ? recordOf(listOf(objective.notes).at(-1)) : null;
  return [
    { term: 'Deliverable', text: stringOf(objective.deliverable) },
    { term: 'Dates', text: range(objective) },
    { term: 'Status', text: stringOf(objective.status) },
    { term: 'Steps', text: steps.join('\n') },
    { term: 'Why moved', text: command.action === 'dates' ? stringOf(command.reason) : '' },
    { term: 'Note', text: note ? stringOf(note.moved) : '' },
    { term: 'Blocked by', text: note ? stringOf(note.blockers) : '' },
  ].filter((field) => field.text !== '');
}

function taskLine(command, result) {
  const task = recordOf(result.task);
  const what = task.kind === 'follow_up' ? 'follow-up' : 'check';
  switch (command.action) {
    case 'schedule':
      return (result.moved === true ? 'Moved the ' + what + ' to ' : 'Set a ' + what + ' for ') + timeWords(task.localTime);
    case 'cancel':
      return 'Cancelled the ' + what + ': ' + stringOf(task.why);
    case 'checked':
      return orNull(result.next) ? 'Noted the check, next on ' + timeWords(result.next) : 'Noted the check';
    default:
      return 'Updated your checks';
  }
}

function taskFields(command, result) {
  if (command.action === 'checked') return [{ term: 'Found', text: stringOf(result.recorded) }, { term: 'Next check', text: orNull(result.next) ? timeWords(result.next) : 'none' }];
  const task = recordOf(result.task);
  return [{ term: 'When', text: timeWords(task.localTime) }, { term: 'Why', text: stringOf(task.why) }];
}

const doneSteps = (objective) => listOf(objective.steps).filter((step) => recordOf(step).doneAt).length;

/**
 * The line and fields of a finished records call, or null for a result of a shape this page does not know.
 * @returns {{ line: string, fields: { term: string, text: string }[] } | null}
 */
export function recordsOf(call) {
  const input = recordOf(call.input);
  const command = recordOf(input.command);
  const result = recordOf(call.result);
  switch (call.tool) {
    case 'objectives_update': {
      // A task under no goal comes back as one step, so it reads through a goal that holds only that step.
      const objective = isRecord(result.objective) ? result.objective : isRecord(result.step) ? { steps: [result.step] } : null;
      return objective ? { line: objectiveLine(command, objective), fields: objectiveFields(command, objective) } : null;
    }
    case 'objectives_list': {
      const objectives = listOf(result.objectives).map(recordOf);
      const fields = objectives.map((objective) => ({ term: stringOf(objective.title), text: doneSteps(objective) + ' of ' + count(listOf(objective.steps).length, 'step') + (objective.due ? ' · due ' + dayWords(objective.due) : '') }));
      return { line: input.owner === undefined ? 'Read your objectives' : "Read a colleague's shared objectives", fields: fields.length ? fields : [{ term: 'Objectives', text: 'none' }] };
    }
    case 'tasks_update':
      return isRecord(result.task) || command.action === 'checked' ? { line: taskLine(command, result), fields: taskFields(command, result) } : null;
    case 'tasks_list': {
      const tasks = listOf(result.tasks).map(recordOf);
      const fields = tasks.map((task) => ({ term: timeWords(task.localTime), text: stringOf(task.why) }));
      return { line: "Read Jet's checks", fields: [...fields, { term: 'Recent runs', text: String(listOf(result.runs).length) }] };
    }
    case 'people_list':
      return { line: 'Read the people list', fields: [{ term: 'People', text: String(listOf(result.users).length) }, { term: 'Teams', text: listOf(result.teams).map((team) => stringOf(recordOf(team).name)).join(', ') || 'none' }] };
    default:
      return null;
  }
}

/**
 * The calls of one reply as the thread draws them: every finished call to Jet's own records that asks for
 * no tap folds into one item at the place of the first, when there are two or more. Running and failed
 * calls, and the cards that need a tap, stay as their own items.
 * @param {import('./model.js').ShownCall[]} calls
 * @returns {({ kind: 'call', call: import('./model.js').ShownCall } | { kind: 'records', id: string, calls: import('./model.js').ShownCall[], line: string })[]}
 */
export function foldRecords(calls) {
  const folded = calls.filter((call) => isRecordsCall(call) && call.ok === true && !call.unfinished && !isCard(call.result));
  if (folded.length < 2) return calls.map((call) => ({ kind: 'call', call }));
  const changes = folded.filter(isChange).length;
  const line = changes > 0 ? 'Jet updated your plan · ' + count(changes, 'change') : 'Jet read your plan';
  const group = { kind: 'records', id: 'records:' + folded[0].id, calls: folded, line };
  return calls.flatMap((call) => (call === folded[0] ? [group] : folded.includes(call) ? [] : [{ kind: 'call', call }]));
}
