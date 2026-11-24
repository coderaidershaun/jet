// Draws the plan pane from the pane read: the glance tiles, the objectives folded to one summary each, Jet's own
// plan, its recent checks and what colleagues share. Every control is one tap, handed to `ctx.act`.

import { h } from '../dom.js';
import { listOf, numberOrNull, orNull, recordOf, stringOf, stringsOf } from '../chat/thread/cards/guard.js';
import { svgIcon } from './icons.js';
import { sentSection } from './sent.js';
import {
  clockWords, closedWords, costWords, dateWords, daysLeftWords, groupObjectives, heldReason, isEmpty, kindWords, latestNote, dueWords,
  nextCheck, noteTone, outcomeOf, rangeWords, relativeWords, runTitle, setByWords, sharedWithWords, stepDueWords, stepProgress, tokensWords,
} from './model.js';

const RUNS_SHOWN = 5;
const EXAMPLE = 'I need to ship the kite page by Friday.';
const chip = (text, tone = 'quiet', extra = {}) => h('span', { class: 'chip', 'data-tone': tone, ...extra, text });
const button = (label, onClick, props = {}, ...inside) => h('button', { type: 'button', class: 'pane-button', onClick: (event) => onClick(event.currentTarget), ...props }, ...inside, h('span', { text: label }));
const line = (className, text) => (text ? h('p', { class: className, text }) : null);

/** A section whose heading a tile can jump to; `count` is how many things it holds. */
function section(key, title, count, aside, ...children) {
  return h('section', { class: 'pane-section' },
    h('h3', { class: 'pane-heading', tabindex: '-1', 'data-key': `heading-${key}` },
      h('span', { text: title }), count ? h('span', { class: 'pane-heading-count', text: String(count) }) : null, aside ? h('span', { class: 'pane-aside', text: aside }) : null),
    ...children);
}

function stepRow(step, ctx, tick) {
  const done = step.doneAt != null;
  const due = stepDueWords(step, ctx.today, ctx.year);
  const dueSpan = due.words ? h('span', { class: 'step-due', 'data-tone': due.tone, text: due.words }) : null;
  if (!tick) return h('li', { class: 'step-read', 'data-done': String(done) }, done ? svgIcon('check') : h('span', { class: 'step-dot', 'aria-hidden': 'true' }), h('span', { class: 'step-title', text: stringOf(step.title) }), done ? h('span', { class: 'sr-only', text: ', done' }) : null, dueSpan);
  return h('li', {}, h('button', { type: 'button', class: 'step', role: 'checkbox', 'aria-checked': String(done), 'data-done': String(done), 'data-key': `step-${step.id}`, onClick: (event) => tick(step, !done, event.currentTarget) },
    h('span', { class: 'step-box' }, done ? svgIcon('check') : null), h('span', { class: 'step-title', text: stringOf(step.title) }), dueSpan));
}

function progressBar(steps) {
  const { done, total } = stepProgress(steps);
  if (total === 0) return null;
  const fill = h('span', { class: 'bar-fill' });
  fill.style.width = `${Math.round((100 * done) / total)}%`;
  return h('span', { class: 'progress' }, h('span', { class: 'bar', 'aria-hidden': 'true' }, fill), h('span', { class: 'progress-words', text: `${done} of ${total} steps` }));
}

function noteBlock(objective, note, ctx) {
  const priv = note.isPrivate === true;
  const flip = button('Private', (el) => ctx.act.flip(objective, note, el), { class: 'pane-button note-flip', 'data-key': `note-${note.id}`, 'data-private': String(priv), 'aria-pressed': String(priv) }, svgIcon(priv ? 'lock' : 'people'));
  return h('div', { class: 'note', 'data-private': String(priv) },
    h('div', { class: 'note-top' }, orNull(note.status) ? chip(note.status, noteTone(note.status)) : null, h('span', { class: 'note-when', text: clockWords(note.at, ctx.timeZone) }), flip),
    line('note-moved', stringOf(note.moved)),
    note.blockers ? h('p', { class: 'note-blockers' }, h('b', { text: 'Blocked by ' }), stringOf(note.blockers)) : null,
    note.newDates ? h('p', { class: 'note-dates' }, h('b', { text: 'New dates ' }), stringOf(note.newDates)) : null,
    h('p', { class: 'note-who', text: priv ? 'Only you can read this note.' : 'People you share the objective with can read this note.' }));
}

/** The objective's next check and when, or that none is set, so the user can tell Jet when to look in. */
function checkLine(objective, ctx) {
  const next = nextCheck(objective);
  if (next) {
    const when = next.state === 'running' ? 'running now' : relativeWords(next.dueAt - ctx.now);
    return h('span', { class: 'objective-check' }, svgIcon('clock'), h('span', { text: `Next check ${dueWords(next.dueAt, ctx.timeZone ?? next.timeZone, ctx.year)}, ${when}` }));
  }
  if (objective.hasOpenCheck !== false || (objective.status !== 'active' && objective.status !== 'paused')) return null;
  return h('span', { class: 'objective-check', 'data-tone': 'warn' }, svgIcon('clock'), h('span', { text: 'No check is set. Tell Jet when to look in.' }));
}

function objectiveCard(objective, ctx) {
  const open = ctx.open.has(objective.id);
  const left = daysLeftWords(objective.daysLeft);
  const note = latestNote(objective);
  const steps = listOf(objective.steps);
  const sharing = ctx.shares.get(objective.id);
  const priv = objective.private === true;
  const bodyId = `objective-body-${objective.id}`;
  const summary = h('button', { type: 'button', class: 'objective-summary', 'aria-expanded': String(open), 'aria-controls': bodyId, 'data-key': `fold-${objective.id}`, onClick: () => ctx.act.fold(objective) },
    h('span', { class: 'objective-top' },
      h('span', { class: 'objective-title', text: stringOf(objective.title) }),
      svgIcon('chevron')),
    h('span', { class: 'objective-chips' },
      orNull(note?.status) ? chip(note.status, noteTone(note.status)) : null,
      objective.status === 'paused' ? chip('Paused') : null,
      left.words ? chip(left.words, left.tone, { class: 'chip days' }) : null),
    progressBar(steps),
    checkLine(objective, ctx));
  return h('article', { class: 'plan-card objective', 'data-status': objective.status, 'data-id': objective.id, 'data-open': String(open) },
    h('h4', { class: 'objective-head' }, summary),
    h('div', { class: 'objective-body', id: bodyId, hidden: !open },
      line('objective-deliverable', stringOf(objective.deliverable)),
      line('objective-range', rangeWords(objective, ctx.year)),
      steps.length ? h('ul', { class: 'steps' }, ...steps.map((step) => stepRow(recordOf(step), ctx, (s, done, el) => ctx.act.tick(objective, s, done, el)))) : null,
      note ? noteBlock(objective, note, ctx) : null,
      h('div', { class: 'objective-foot' },
        h('p', { class: 'objective-shared' }, svgIcon(priv ? 'lock' : 'people'), h('span', { text: priv ? 'Private, only you' : 'Shared with ' + sharedWithWords(objective) })),
        h('div', { class: 'objective-buttons' },
          button(sharing ? 'Close' : priv ? 'Share' : 'Change who sees it', (el) => ctx.act.share(objective, el), { 'data-key': `share-${objective.id}`, 'aria-expanded': String(Boolean(sharing)) }),
          objective.chatId == null ? null : button('Open chat', () => ctx.act.openChat(objective), { 'data-key': `chat-${objective.id}` }, svgIcon('chat')))),
      sharing ?? null));
}

function closedList(objectives, ctx) {
  return h('details', { class: 'closed', ...(ctx.showClosed ? { open: true } : {}), onToggle: (event) => ctx.set.closed(event.currentTarget.open) },
    h('summary', { 'data-key': 'closed' }, h('span', { text: `Done and dropped (${objectives.length})` }), svgIcon('chevron')),
    h('ul', { class: 'closed-list' }, ...objectives.map((o) => h('li', { class: 'closed-row', 'data-status': o.status, 'data-id': o.id },
      h('span', { class: 'closed-title', text: stringOf(o.title) }), chip(o.status === 'done' ? 'Done' : 'Dropped', o.status === 'done' ? 'good' : 'quiet'),
      h('span', { class: 'closed-due', text: closedWords(o, ctx.timeZone, ctx.year) || dateWords(o.due, ctx.year) }),
      o.chatId == null ? null : button('Open chat', () => ctx.act.openChat(o), { class: 'pane-button icon-only', 'aria-label': `Open the chat of ${stringOf(o.title)}` }, svgIcon('chat'))))));
}

function taskRow(task, ctx) {
  const running = task.state === 'running';
  const armed = ctx.taps.armed === task.id;
  const zone = ctx.timeZone ?? task.timeZone;
  return h('li', { class: 'plan-card task', 'data-state': task.state, 'data-id': task.id },
    h('div', { class: 'task-when' }, svgIcon('clock'), h('time', { class: 'task-time', text: dueWords(task.dueAt, zone, ctx.year) }), h('span', { class: 'task-rel', text: running ? 'Running now' : relativeWords(task.dueAt - ctx.now) }),
      chip(kindWords(task.kind), 'kind'), task.isDefault ? chip('Default time', 'warn') : null),
    line('task-why', stringOf(task.why)),
    h('p', { class: 'task-meta', text: [orNull(task.objectiveTitle) ? `For ${task.objectiveTitle}` : null, setByWords(task.setBy)].filter(Boolean).join(' · ') }),
    running ? null : h('div', { class: 'task-buttons' },
      button(numberOrNull(task.snoozeAt) === null ? 'Snooze' : `Snooze to ${dueWords(task.snoozeAt, zone, ctx.year)}`, (el) => ctx.act.snooze(task, el), { 'data-key': `snooze-${task.id}` }),
      button(armed ? 'Tap again to cancel' : 'Cancel', (el) => ctx.act.cancel(task, el), { class: armed ? 'pane-button danger is-armed' : 'pane-button danger', 'data-key': `cancel-${task.id}` })));
}

function runRow(run, ctx) {
  const outcome = outcomeOf(run.outcome);
  const sources = stringsOf(run.sourcesRead);
  const found = run.outcome === 'held' ? heldReason(run.found) : stringOf(run.found);
  const reaction = orNull(run.reaction);
  const hasCheckIn = numberOrNull(run.entryId) !== null && numberOrNull(run.chatId) !== null;
  const cost = [tokensWords(run.tokens), costWords(run.cost)].filter(Boolean).join(' · ');
  return h('li', { class: 'plan-card run', 'data-outcome': run.outcome ?? 'running', 'data-id': run.id },
    h('div', { class: 'run-top' }, h('span', { class: 'run-title', text: runTitle(run) }), chip(outcome.words, outcome.tone)),
    h('p', { class: 'run-when', text: `${clockWords(run.startedAt, ctx.timeZone)} · ${relativeWords(run.startedAt - ctx.now)}` }),
    line('run-found', found),
    sources.length ? h('ul', { class: 'sources', 'aria-label': 'Sources read' }, ...sources.map((source) => h('li', { class: 'source-chip', text: source }))) : null,
    reaction || hasCheckIn ? h('div', { class: 'run-foot' },
      hasCheckIn ? button('Open check-in', () => ctx.act.openRun(run), { 'data-key': `run-${run.id}` }, svgIcon('chat')) : null,
      reaction ? chip(`Seen ${reaction}`, 'good', { class: 'chip run-reaction' }) : null) : null,
    line('run-cost', cost));
}

function sharedCard(item, ctx) {
  const left = daysLeftWords(item.daysLeft), latest = item.latest == null ? null : recordOf(item.latest);
  return h('article', { class: 'plan-card shared', 'data-id': item.id },
    h('p', { class: 'shared-owner', text: `${stringOf(item.owner)} shared` }),
    h('div', { class: 'objective-top' }, h('h4', { class: 'objective-title', text: stringOf(item.title) }), left.words ? chip(left.words, left.tone, { class: 'chip days' }) : null),
    line('objective-range', item.due ? `Due ${dateWords(item.due, ctx.year)}` : ''),
    progressBar(item.steps),
    listOf(item.steps).length ? h('ul', { class: 'steps' }, ...listOf(item.steps).map((step) => stepRow(recordOf(step), ctx, null))) : null,
    latest ? h('div', { class: 'note' }, h('div', { class: 'note-top' }, orNull(latest.status) ? chip(latest.status, noteTone(latest.status)) : null, h('span', { class: 'note-when', text: clockWords(latest.at, ctx.timeZone) })),
      line('note-moved', stringOf(latest.moved)), latest.blockers ? h('p', { class: 'note-blockers' }, h('b', { text: 'Blocked by ' }), stringOf(latest.blockers)) : null) : h('p', { class: 'pane-hint', text: 'No update yet.' }));
}

/** Three tiles at the top, each a jump to its section: what is being worked on, the next check, and the last one. */
function glance(pane, ctx, active) {
  const next = pane.tasks.find((task) => task.state !== 'running') ?? pane.tasks[0], last = pane.runs[0];
  const tile = (target, label, value, detail) => h('button', { type: 'button', class: 'tile', 'data-key': `tile-${target}`, onClick: () => ctx.act.jump(target) },
    h('span', { class: 'tile-label', text: label }), h('span', { class: 'tile-value', text: value }), h('span', { class: 'tile-detail', text: detail }));
  return h('nav', { class: 'glance', 'aria-label': 'Jump to' },
    tile('objectives', 'Working on', String(active.length), active.length === 1 ? 'objective' : 'objectives'),
    tile('plan', 'Next check', next ? (next.state === 'running' ? 'Now' : relativeWords(next.dueAt - ctx.now)) : 'None', next ? orNull(next.objectiveTitle) ?? `Follow-up: ${stringOf(next.why)}` : 'nothing scheduled'),
    tile('checks', 'Last check', last ? outcomeOf(last.outcome).words : 'None', last ? runTitle(last) : 'none yet'));
}

function invitation(ctx) {
  return h('div', { class: 'invite' }, svgIcon('plan'),
    h('h3', { class: 'invite-title', text: 'Nothing to track yet' }),
    h('p', { text: 'Tell Jet what you are working on: what it should deliver, by when, and the steps to get there. Jet keeps the plan here and checks in on its own.' }),
    h('button', { type: 'button', class: 'invite-example', 'data-key': 'example', onClick: () => ctx.act.draft(EXAMPLE) }, `“${EXAMPLE}”`),
    h('p', { class: 'invite-hint', text: 'Tap it to start your message with it.' }));
}

/** @returns {HTMLElement[]} the sections of the pane for `pane` (from readPane) */
export function planNodes(pane, ctx) {
  if (isEmpty(pane)) return [invitation(ctx)];
  const { active, closed } = groupObjectives(pane.objectives);
  const runs = ctx.showAllRuns ? pane.runs : pane.runs.slice(0, RUNS_SHOWN);
  return [
    glance(pane, ctx, active),
    section('objectives', 'Objectives', active.length, null,
      active.length ? h('div', { class: 'stack' }, ...active.map((o) => objectiveCard(o, ctx))) : h('p', { class: 'pane-hint', text: 'Nothing active. Tell Jet what you are working on.' }),
      closed.length ? closedList(closed, ctx) : null),
    section('plan', "Jet's plan", pane.tasks.length, pane.timeZone ? `Times in ${pane.timeZone}` : null,
      pane.tasks.length ? h('ul', { class: 'stack' }, ...pane.tasks.map((task) => taskRow(task, ctx))) : h('p', { class: 'pane-hint', text: 'Jet has no check scheduled.' })),
    section('checks', 'Recent checks', pane.runs.length, null,
      pane.runs.length ? h('ul', { class: 'stack' }, ...runs.map((run) => runRow(run, ctx))) : h('p', { class: 'pane-hint', text: 'Jet has not run a check yet.' }),
      pane.runs.length > RUNS_SHOWN ? button(ctx.showAllRuns ? 'Show fewer' : `Show all ${pane.runs.length}`, () => ctx.set.allRuns(!ctx.showAllRuns), { class: 'pane-button more', 'data-key': 'runs-more' }) : null),
    sentSection(pane.sent, ctx),
    pane.sharedWithMe.length ? section('shared', 'Shared with you', pane.sharedWithMe.length, null, h('div', { class: 'stack' }, ...pane.sharedWithMe.map((item) => sharedCard(item, ctx)))) : null,
  ].filter(Boolean);
}
