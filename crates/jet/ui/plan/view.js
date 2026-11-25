// Draws the plan pane from the pane read, as rows with a hairline between them. In an objective's own chat the pane
// holds that objective and what belongs to it; everywhere else it is the overview, led by Jet's tasks. A row unfolds in
// place and nothing starts unfolded. Every control is one tap, handed to `ctx.act`.

import { h } from '../dom.js';
import { listOf, numberOrNull, orNull, recordOf, stringOf } from '../chat/thread/cards/guard.js';
import { openProps } from '../chat/file-view.js';
import { svgIcon } from './icons.js';
import { sentList } from './sent.js';
import {
  chatFiles, clockWords, closedWords, costWords, dateWords, dayWords, daysLeftWords, dueDayWords, dueWords, groupObjectives, heldReason, isEmpty, kindWords,
  fileWords, latestNote, needsFirst, noteTone, otherChats, outcomeOf, progressWords, relativeWords, runTitle, setByWords, sharedWithWords,
  stepDueWords, stepsEndWords, timeWords, tokensWords, waitingItems,
} from './model.js';

const TASKS_SHOWN_DAYS = 2;
const EXAMPLE = 'I need to ship the kite page by Friday.';
/** A text button: the one kind of control the pane has, apart from the rows that unfold and the step ticks. */
const textButton = (label, onClick, props = {}) => h('button', { type: 'button', class: 'text-button', onClick: (event) => onClick(event.currentTarget), ...props }, label);
const line = (className, text) => (text ? h('p', { class: className, text }) : null);
/** A fact in plain text, in a colour only when it needs the user: 'bad' or 'warn'. */
const fact = (words, tone = 'quiet', className = 'fact') => (words ? h('span', { class: className, 'data-tone': tone === 'bad' || tone === 'warn' ? tone : 'quiet', text: words }) : null);
const needsTone = (tone) => (tone === 'bad' ? 'bad' : 'quiet');

/** A section of the pane: a plain heading with its count, then its content. */
function section(key, title, count, ...children) {
  return h('section', { class: 'pane-section' },
    h('h3', { class: 'pane-heading', tabindex: '-1', 'data-key': `heading-${key}` }, title, count ? h('span', { class: 'heading-count', text: String(count) }) : null),
    ...children);
}

/** One line that opens a list below it: its words and count, a chevron, and the content once open. */
function foldLine(ctx, key, label, count, content, byDefault = false) {
  const open = ctx.isOpen(key, byDefault), id = `fold-${key}`;
  return h('section', { class: 'fold', 'data-open': String(open) },
    h('button', { type: 'button', class: 'fold-line', 'aria-expanded': String(open), 'aria-controls': id, 'data-key': `fold-${key}`, onClick: () => ctx.act.fold(key, open) },
      h('span', { text: label }), h('span', { class: 'heading-count', text: String(count) }), svgIcon('chevron')),
    h('div', { id, hidden: !open }, open ? content() : null));
}

/** A row that unfolds in place: a summary button with its facts and a chevron, an optional control beside it, and the body. */
function foldRow(kind, id, ctx, head, body, aside = null, under = null) {
  const key = `${kind}${id}`, open = ctx.isOpen(key), bodyId = `body-${key}`;
  const summary = h('button', { type: 'button', class: `row-summary ${kind}-summary`, 'aria-expanded': String(open), 'aria-controls': bodyId, 'data-key': `fold-${key}`, onClick: () => ctx.act.fold(key, open) }, ...head, svgIcon('chevron'));
  return h('li', { class: `plan-row ${kind}`, 'data-id': id, 'data-open': String(open) },
    h('div', { class: 'row-line' }, summary, aside),
    under,
    h('div', { class: 'row-body', id: bodyId, hidden: !open }, ...body));
}

function stepRow(step, ctx, tick, objectiveDue) {
  const done = step.doneAt != null;
  const due = stepDueWords(step, ctx.today, ctx.year, objectiveDue);
  const dueSpan = due.words ? h('span', { class: 'step-due', 'data-tone': due.tone, text: due.words }) : null;
  if (!tick) return h('li', { class: 'step-read', 'data-done': String(done) }, done ? svgIcon('check') : h('span', { class: 'step-dot', 'aria-hidden': 'true' }), h('span', { class: 'step-title', text: stringOf(step.title) }), done ? h('span', { class: 'sr-only', text: ', done' }) : null, dueSpan);
  return h('li', {}, h('button', { type: 'button', class: 'step', role: 'checkbox', 'aria-checked': String(done), 'data-done': String(done), 'data-key': `step-${step.id}`, onClick: (event) => tick(step, !done, event.currentTarget) },
    h('span', { class: 'step-box' }, done ? svgIcon('check') : null), h('span', { class: 'step-title', text: stringOf(step.title) }), dueSpan));
}

/** The steps of an objective that is due on `due`. */
const stepsList = (steps, ctx, tick, due) => (listOf(steps).length ? h('ul', { class: 'steps' }, ...listOf(steps).map((step) => stepRow(recordOf(step), ctx, tick, due))) : null);

/** The state word of an objective: a paused one, else its latest note's status, coloured when it needs the user. */
function stateFact(objective) {
  const status = orNull(latestNote(objective)?.status);
  if (objective.status === 'paused') return fact('Paused');
  return status ? fact(status, noteTone(status)) : null;
}
const leftFact = (daysLeft) => { const left = daysLeftWords(daysLeft); return fact(left.words, needsTone(left.tone)); };

/** A note as plain lines. `flip` is the owner's control that moves it between private and shared. */
function noteBlock(note, ctx, flip) {
  const status = orNull(note.status);
  return h('div', { class: 'pane-note' },
    h('p', { class: 'note-top' }, fact(status, status ? noteTone(status) : 'quiet'), h('span', { class: 'note-when', text: clockWords(note.at, ctx.timeZone) }), flip),
    line('note-moved', stringOf(note.moved)),
    note.blockers ? h('p', { class: 'note-blockers' }, h('b', { text: 'Blocked by ' }), stringOf(note.blockers)) : null,
    note.newDates ? h('p', { class: 'note-dates' }, h('b', { text: 'New dates ' }), stringOf(note.newDates)) : null);
}

function ownNote(objective, note, ctx) {
  const priv = note.isPrivate === true;
  const flip = textButton(priv ? 'Private' : 'Shared', (el) => ctx.act.flip(objective, note, el), { class: 'text-button note-flip', 'data-key': `note-${note.id}`, 'data-private': String(priv), 'aria-pressed': String(priv), title: priv ? 'Only you can read this note. Tap to share it.' : 'People you share the objective with can read this note. Tap to make it private.' });
  return noteBlock(note, ctx, flip);
}

const isOpen = (objective) => objective.status === 'active' || objective.status === 'paused';

/** The overview's line for an objective; it unfolds to its steps, its latest note and its chat. */
function objectiveRow(objective, ctx) {
  const tick = (s, done, el) => ctx.act.tick(objective, s, done, el);
  const note = latestNote(objective);
  const ownChat = objective.chatId != null && objective.chatId !== ctx.mainId;
  const noCheck = objective.hasOpenCheck === false && isOpen(objective);
  return foldRow('objective', objective.id, ctx,
    [h('span', { class: 'row-title', text: stringOf(objective.title) }), h('span', { class: 'row-facts' }, stateFact(objective), leftFact(objective.daysLeft), fact(progressWords(objective.steps), 'quiet', 'fact progress'))],
    [stepsList(objective.steps, ctx, tick, objective.due), note ? ownNote(objective, note, ctx) : null, ownChat ? textButton('Open chat', () => ctx.act.openChat(objective), { 'data-key': `chat-${objective.id}` }) : null],
    null,
    noCheck ? h('p', { class: 'row-warn', text: 'No check is set. Tell Jet when to look in.' }) : null);
}

function closedList(objectives, ctx) {
  return foldLine(ctx, 'closed', 'Done and dropped', objectives.length, () => h('ul', { class: 'plan-rows' }, ...objectives.map((o) => h('li', { class: 'plan-row closed-row', 'data-status': o.status, 'data-id': o.id },
    h('span', { class: 'closed-title', text: stringOf(o.title) }), h('span', { class: 'closed-due', text: closedWords(o, ctx.timeZone, ctx.year) || dateWords(o.due, ctx.year) }),
    o.chatId == null || o.chatId === ctx.mainId ? null : textButton('Open chat', () => ctx.act.openChat(o), { 'aria-label': `Open the chat of ${stringOf(o.title)}` })))));
}

/** The control that moves a waiting task to the next morning; its name says where it lands. */
function snoozeButton(task, ctx) {
  const landing = numberOrNull(task.snoozeAt) === null ? null : dueWords(task.snoozeAt, ctx.timeZone ?? task.timeZone, ctx.year);
  return textButton('Snooze', (el) => ctx.act.snooze(task, el), { class: 'text-button snooze', 'data-key': `snooze-${task.id}`, ...(landing ? { 'aria-label': `Snooze to ${landing}`, title: `Snooze to ${landing}` } : {}) });
}
const cancelButton = (task, ctx) => textButton(ctx.taps.armed === task.id ? 'Tap again to cancel' : 'Cancel', (el) => ctx.act.cancel(task, el), { class: 'text-button danger', 'data-key': `cancel-${task.id}` });

/** In the overview, one of Jet's tasks: the hour, the reason and, under it, the objective, muted; it unfolds to Cancel and the chat. */
function taskRow(task, ctx) {
  const running = task.state === 'running';
  const zone = ctx.timeZone ?? task.timeZone;
  const meta = [running ? 'Running now' : relativeWords(task.dueAt - ctx.now), kindWords(task.kind), setByWords(task.setBy)].join(' · ');
  return foldRow('task', task.id, ctx,
    [h('time', { class: 'task-time', text: running ? 'Now' : timeWords(task.dueAt, zone) }), h('span', { class: 'row-stack' }, h('span', { class: 'row-title task-why', text: stringOf(task.why) }), orNull(task.objectiveTitle) ? h('span', { class: 'task-for', text: task.objectiveTitle }) : null)],
    [h('p', { class: 'task-meta', text: meta }), running ? null : cancelButton(task, ctx), task.chatId === ctx.mainId ? null : textButton('Open chat', () => ctx.act.openChat(task), { 'data-key': `task-chat-${task.id}` })],
    running ? null : snoozeButton(task, ctx));
}

/** In an objective's chat, one of Jet's tasks: its reason, its time under it, and both controls in sight. */
function scopedTaskRow(task, ctx) {
  const running = task.state === 'running';
  return h('li', { class: 'plan-row task scoped-task', 'data-id': task.id },
    h('div', { class: 'row-line' },
      h('div', { class: 'row-summary' }, h('span', { class: 'row-stack' }, h('span', { class: 'row-title task-why', text: stringOf(task.why) }), h('time', { class: 'task-time', text: running ? 'Running now' : dueWords(task.dueAt, ctx.timeZone ?? task.timeZone, ctx.year) }))),
      running ? null : snoozeButton(task, ctx), running ? null : cancelButton(task, ctx)));
}

/** The overview's tasks, soonest first, under their day. Today and tomorrow show; the rest wait behind one line. */
function tasksList(tasks, ctx) {
  const days = [];
  for (const task of tasks) {
    const label = task.state === 'running' ? 'Today' : dayWords(task.dueAt, ctx.timeZone ?? task.timeZone, ctx.now, ctx.year);
    if (days.at(-1)?.label !== label) days.push({ label, rows: [] });
    days.at(-1).rows.push(task);
  }
  const draw = (group) => group.map((d) => h('div', { class: 'day' }, h('h4', { class: 'day-label', text: d.label }), h('ul', { class: 'plan-rows' }, ...d.rows.map((task) => taskRow(task, ctx)))));
  const soon = days.filter((d) => d.label === 'Today' || d.label === 'Tomorrow'), later = days.slice(soon.length);
  const laterCount = later.reduce((n, d) => n + d.rows.length, 0);
  return h('div', { class: 'days' }, ...draw(soon), laterCount ? foldLine(ctx, 'later', 'Later', laterCount, () => h('div', { class: 'days' }, ...draw(later))) : null);
}

/** One past run as a line: how it ended, what it was about, when. Its check-in opens from the line. */
function runRow(run, ctx, withTitle) {
  const outcome = outcomeOf(run.outcome);
  const reaction = orNull(run.reaction);
  const found = run.outcome === 'held' ? heldReason(run.found) : stringOf(run.found);
  const cost = [tokensWords(run.tokens), costWords(run.cost)].filter(Boolean).join(' · ');
  const hasCheckIn = numberOrNull(run.entryId) !== null && numberOrNull(run.chatId) !== null;
  const words = [h('span', { class: 'run-outcome', 'data-tone': outcome.tone, text: outcome.words }), withTitle ? h('span', { class: 'row-title run-title', text: runTitle(run) }) : h('span', { class: 'row-title' }),
    h('span', { class: 'fact run-when', text: relativeWords(run.startedAt - ctx.now) }), reaction ? h('span', { class: 'fact run-reaction', text: reaction }) : null, cost ? h('span', { class: 'fact run-cost', text: cost }) : null];
  const props = { class: 'plan-row run', 'data-outcome': run.outcome ?? 'running', 'data-id': run.id, ...(found ? { title: found } : {}) };
  return hasCheckIn
    ? h('li', props, h('button', { type: 'button', class: 'row-summary run-open', 'data-key': `run-${run.id}`, onClick: () => ctx.act.openRun(run) }, ...words, h('span', { class: 'sr-only', text: ', opens the check-in' })))
    : h('li', props, h('div', { class: 'row-summary' }, ...words));
}

const runList = (runs, ctx, withTitle) => h('ul', { class: 'plan-rows' }, ...runs.map((run) => runRow(run, ctx, withTitle)));

function sharedRow(item, ctx) {
  const latest = item.latest == null ? null : recordOf(item.latest);
  return foldRow('shared', item.id, ctx,
    [h('span', { class: 'row-title', text: stringOf(item.title) }), h('span', { class: 'row-facts' }, leftFact(item.daysLeft), fact(progressWords(item.steps), 'quiet', 'fact progress'))],
    [stepsList(item.steps, ctx, null, item.due), latest ? noteBlock(latest, ctx, null) : h('p', { class: 'pane-hint', text: 'No update yet.' })]);
}

/** What colleagues share, one row each under its owner. */
function sharedGroups(items, ctx) {
  const owners = [...new Set(items.map((item) => stringOf(item.owner)))];
  return h('div', { class: 'days' }, ...owners.map((owner) => h('div', { class: 'day' }, h('h4', { class: 'day-label', text: owner }), h('ul', { class: 'plan-rows' }, ...items.filter((item) => stringOf(item.owner) === owner).map((item) => sharedRow(item, ctx))))));
}

function invitation(ctx) {
  return h('p', { class: 'invite' }, 'Tell Jet what you are working on, for example ',
    h('button', { type: 'button', class: 'invite-example', 'data-key': 'example', onClick: () => ctx.act.draft(EXAMPLE) }, `“${EXAMPLE}”`));
}

/** The overview: Jet's tasks first, then the objectives, then what waits on colleagues, what they share, and what Jet did. */
function overviewNodes(pane, ctx) {
  const { active, closed } = groupObjectives(pane.objectives);
  const soonest = [...pane.tasks].sort((a, b) => a.dueAt - b.dueAt);
  const waiting = waitingItems(pane.sent);
  const failed = pane.runs.slice(0, 3).some((run) => run.outcome === 'failed' || run.outcome === 'held');
  return [
    ctx.scope ? h('div', { class: 'back' }, textButton('This chat only', () => ctx.act.swap(false), { class: 'text-button back-button', 'data-key': 'swap' })) : null,
    section('will', "Jet's tasks", pane.tasks.length, soonest.length ? tasksList(soonest, ctx) : h('p', { class: 'pane-hint', text: 'Jet has no check scheduled.' })),
    section('objectives', 'Objectives', active.length,
      active.length ? h('ul', { class: 'plan-rows' }, ...needsFirst(active).map((o) => objectiveRow(o, ctx))) : h('p', { class: 'pane-hint', text: 'Nothing active. Tell Jet what you are working on.' }),
      closed.length ? closedList(closed, ctx) : null),
    h('div', { class: 'folds' },
      waiting.length ? foldLine(ctx, 'waiting', 'Waiting on colleagues', waiting.length, () => sentList(waiting, ctx, foldRow)) : null,
      pane.sharedWithMe.length ? foldLine(ctx, 'shared', 'Shared with you', pane.sharedWithMe.length, () => sharedGroups(pane.sharedWithMe, ctx)) : null,
      pane.runs.length ? foldLine(ctx, 'did', 'What Jet did', `${pane.runs.length} check${pane.runs.length === 1 ? '' : 's'}`, () => runList(pane.runs, ctx, true), failed) : null),
  ].filter(Boolean);
}

/** The words after "Jet last looked 2 h ago:". */
const lookWords = (run) => { const words = outcomeOf(run.outcome).words; return words.charAt(0).toLowerCase() + words.slice(1); };

/** One objective in its own chat: title, the day it is due and the other facts, deliverable, steps, latest note and who sees it. */
function objectiveBlock(objective, ctx) {
  const note = latestNote(objective);
  const sharing = ctx.shares.get(objective.id);
  const priv = objective.private === true;
  const tick = (s, done, el) => ctx.act.tick(objective, s, done, el);
  return h('div', { class: 'focus', 'data-id': objective.id },
    h('header', { class: 'focus-head' },
      h('h3', { class: 'focus-title', tabindex: '-1', 'data-key': 'heading-focus', text: stringOf(objective.title) }),
      h('p', { class: 'row-facts' }, fact(`Due ${dueDayWords(objective.due, ctx.year)}`, 'quiet', 'fact focus-due'), stateFact(objective), leftFact(objective.daysLeft), fact(progressWords(objective.steps), 'quiet', 'fact progress'), fact(`from ${dateWords(objective.start, ctx.year)}`)),
      line('focus-deliverable', stringOf(objective.deliverable))),
    stepsList(objective.steps, ctx, tick, objective.due),
    line('row-warn', stepsEndWords(objective, ctx.year)),
    note ? ownNote(objective, note, ctx) : null,
    h('p', { class: 'who' }, h('span', { text: priv ? 'Private, only you' : 'Shared with ' + sharedWithWords(objective) }),
      textButton(sharing ? 'Close' : priv ? 'Share' : 'Change', (el) => ctx.act.share(objective, el), { 'data-key': `share-${objective.id}`, 'aria-expanded': String(Boolean(sharing)), 'aria-label': sharing ? 'Close' : priv ? 'Share' : 'Change who sees it' })),
    sharing ?? null);
}

/** The pane in a chat that holds an objective, or follow-ups Jet set in it: those, and nothing of the rest. */
function scopedNodes(pane, ctx) {
  const { objectives, tasks, runs, sent } = ctx.scope;
  const soonest = [...tasks].sort((a, b) => a.dueAt - b.dueAt);
  const unseen = runs.filter((run) => numberOrNull(run.entryId) === null);
  const last = runs[0];
  const lastLine = last ? `Jet last looked ${relativeWords(last.startedAt - ctx.now)}: ${lookWords(last)}` : '';
  return [
    ...objectives.map((objective) => objectiveBlock(objective, ctx)),
    section('will', "Jet's tasks", soonest.length,
      soonest.length ? h('ul', { class: 'plan-rows' }, ...soonest.map((task) => scopedTaskRow(task, ctx))) : h('p', { class: 'pane-hint', text: objectives.some(isOpen) ? 'No check is set. Tell Jet when to look in.' : 'Nothing is scheduled.' })),
    sent.length ? foldLine(ctx, 'waiting', 'Waiting on colleagues', sent.length, () => sentList(sent, ctx, foldRow), true) : null,
    last && unseen.length ? foldLine(ctx, 'did', lastLine, `${unseen.length} not in the chat`, () => runList(unseen, ctx, false)) : line('last-look', lastLine),
    filesSection(pane, ctx),
    h('div', { class: 'back' }, textButton('All objectives and tasks', () => ctx.act.swap(true), { class: 'text-button back-button', 'data-key': 'swap' })),
  ].filter(Boolean);
}

/** One file of the open chat: a link that opens it the way its kind asks, with its facts and its note under the name in muted text. */
function fileRow(file, ctx) {
  const name = stringOf(file.name);
  const others = otherChats(file, ctx.chatId);
  const note = orNull(file.context);
  const words = [h('span', { class: 'file-name', text: name }),
    h('span', { class: 'file-facts' }, fileWords(file, ctx.now), others ? h('span', { class: 'file-shared', title: `Also in ${others} other chat${others === 1 ? '' : 's'}`, text: ' · Shared' }) : null),
    line('file-note', note)];
  const opens = openProps({ id: file.id, kind: file.kind, name });
  return h('li', { class: 'plan-row file-row', 'data-id': stringOf(file.id) },
    opens ? h('a', { class: 'file-open', 'data-key': `file-${file.id}`, 'aria-label': 'Open ' + name, ...(note ? { title: note } : {}), ...opens }, ...words) : h('div', { class: 'file-open' }, ...words));
}

/** The files of the open chat, newest change first; nothing when it holds none. */
function filesSection(pane, ctx) {
  const files = chatFiles(pane, ctx.chatId);
  return files.length ? section('files', 'Files', files.length, h('ul', { class: 'plan-rows' }, ...files.map((file) => fileRow(file, ctx)))) : null;
}

/** @returns {HTMLElement[]} the sections of the pane for `pane` (from readPane) */
export function planNodes(pane, ctx) {
  if (isEmpty(pane)) return [invitation(ctx), filesSection(pane, ctx)].filter(Boolean);
  // The scoped pane draws its files above its way back to the overview.
  return ctx.scope && !ctx.overview ? scopedNodes(pane, ctx) : [...overviewNodes(pane, ctx), filesSection(pane, ctx)].filter(Boolean);
}
