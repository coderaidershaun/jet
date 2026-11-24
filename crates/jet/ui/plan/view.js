// Draws the plan pane from the pane read: the glance strip, the objectives, Jet's own plan, its recent
// checks and what colleagues share. Every control is one tap, handed to `ctx.act`.

import { h } from '../dom.js';
import { listOf, orNull, recordOf, stringOf, stringsOf } from '../chat/thread/cards/guard.js';
import { svgIcon } from './icons.js';
import { sentSection } from './sent.js';
import {
  clockWords, costWords, dateWords, daysLeftWords, groupObjectives, heldReason, isEmpty, kindWords, latestNote, dueWords,
  noteTone, outcomeOf, rangeWords, relativeWords, setByWords, sharedWithWords, stepProgress, tokensWords,
} from './model.js';

const RUNS_SHOWN = 5;
const chip = (text, tone = 'quiet', extra = {}) => h('span', { class: 'chip', 'data-tone': tone, ...extra, text });
const button = (label, onClick, props = {}, ...inside) => h('button', { type: 'button', class: 'pane-button', onClick: (event) => onClick(event.currentTarget), ...props }, ...inside, h('span', { text: label }));
const line = (className, text) => (text ? h('p', { class: className, text }) : null);
const section = (title, aside, ...children) => h('section', { class: 'pane-section' }, h('h3', { class: 'pane-heading' }, h('span', { text: title }), aside ? h('span', { class: 'pane-aside', text: aside }) : null), ...children);

function stepRow(step, ctx, tick) {
  const done = step.doneAt != null;
  const inside = [h('span', { class: 'step-box' }, done ? svgIcon('check') : null), h('span', { class: 'step-title', text: stringOf(step.title) }), step.due ? h('span', { class: 'step-due', text: dateWords(step.due, ctx.year) }) : null];
  if (!tick) return h('li', {}, h('span', { class: 'step', 'data-done': String(done) }, ...inside));
  return h('li', {}, h('button', { type: 'button', class: 'step', role: 'checkbox', 'aria-checked': String(done), 'data-done': String(done), 'data-key': `step-${step.id}`, onClick: (event) => tick(step, !done, event.currentTarget) }, ...inside));
}

function progressBar(steps) {
  const { done, total } = stepProgress(steps);
  if (total === 0) return null;
  const fill = h('span', { class: 'bar-fill' });
  fill.style.width = `${Math.round((100 * done) / total)}%`;
  return h('div', { class: 'progress' }, h('span', { class: 'bar', role: 'img', 'aria-label': `${done} of ${total} steps done` }, fill), h('span', { class: 'progress-words', text: `${done} of ${total} steps` }));
}

function noteBlock(objective, note, ctx) {
  const priv = note.isPrivate === true;
  const flip = button(priv ? 'Private' : 'Shared', (el) => ctx.act.flip(objective, note, el), { class: 'pane-button note-flip', 'data-key': `note-${note.id}`, 'data-private': String(priv), title: priv ? 'Only you can see this note. Tap to share it.' : 'People this objective is shared with can read this note. Tap to make it private.' }, svgIcon(priv ? 'lock' : 'people'));
  return h('div', { class: 'note', 'data-private': String(priv) },
    h('div', { class: 'note-top' }, orNull(note.status) ? chip(note.status, noteTone(note.status)) : null, h('span', { class: 'note-when', text: clockWords(note.at, ctx.timeZone) }), flip),
    line('note-moved', stringOf(note.moved)),
    note.blockers ? h('p', { class: 'note-blockers' }, h('b', { text: 'Blocked by ' }), stringOf(note.blockers)) : null,
    note.newDates ? h('p', { class: 'note-dates' }, h('b', { text: 'New dates ' }), stringOf(note.newDates)) : null);
}

function objectiveCard(objective, ctx) {
  const left = daysLeftWords(objective.daysLeft);
  const note = latestNote(objective);
  const steps = listOf(objective.steps);
  const sharing = ctx.shares.get(objective.id);
  const priv = objective.private === true;
  return h('article', { class: 'plan-card objective', 'data-status': objective.status, 'data-id': objective.id },
    h('div', { class: 'objective-top' }, h('h4', { class: 'objective-title', text: stringOf(objective.title) }), objective.status === 'paused' ? chip('Paused') : null, left.words ? chip(left.words, left.tone, { class: 'chip days' }) : null),
    line('objective-deliverable', stringOf(objective.deliverable)),
    line('objective-range', rangeWords(objective, ctx.year)),
    progressBar(steps),
    steps.length ? h('ul', { class: 'steps' }, ...steps.map((step) => stepRow(recordOf(step), ctx, (s, done, el) => ctx.act.tick(objective, s, done, el)))) : null,
    note ? noteBlock(objective, note, ctx) : null,
    h('div', { class: 'objective-foot' },
      h('p', { class: 'objective-shared' }, svgIcon(priv ? 'lock' : 'people'), h('span', { text: priv ? 'Private, only you' : 'Shared with ' + sharedWithWords(objective) })),
      h('div', { class: 'objective-buttons' },
        // A card can only change an existing share; a first one is arranged in the objective's chat, where Jet asks who.
        priv && objective.chatId != null ? null : button(sharing ? 'Close' : 'Change who sees it', (el) => ctx.act.share(objective, el), { 'data-key': `share-${objective.id}` }),
        objective.chatId == null ? null : button(priv ? 'Ask Jet to share' : 'Open chat', () => ctx.act.openChat(objective), { 'data-key': `chat-${objective.id}`, title: priv ? 'Open the chat and tell Jet who should see this' : null }, svgIcon('chat')))),
    sharing ?? null);
}

function closedList(objectives, ctx) {
  const details = h('details', { class: 'closed', ...(ctx.showClosed ? { open: true } : {}), onToggle: (event) => ctx.set.closed(event.currentTarget.open) },
    h('summary', { 'data-key': 'closed' }, h('span', { text: `Done and dropped (${objectives.length})` }), svgIcon('chevron')),
    h('ul', { class: 'closed-list' }, ...objectives.map((o) => h('li', { class: 'closed-row', 'data-status': o.status, 'data-id': o.id },
      h('span', { class: 'closed-title', text: stringOf(o.title) }), chip(o.status === 'done' ? 'Done' : 'Dropped', o.status === 'done' ? 'good' : 'quiet'), h('span', { class: 'closed-due', text: dateWords(o.due, ctx.year) }),
      o.chatId == null ? null : button('Open chat', () => ctx.act.openChat(o), { class: 'pane-button icon-only', 'aria-label': `Open the chat of ${stringOf(o.title)}`, title: 'Open chat' }, svgIcon('chat'))))));
  return details;
}

function taskRow(task, ctx) {
  const running = task.state === 'running';
  return h('li', { class: 'plan-card task', 'data-state': task.state, 'data-id': task.id },
    h('div', { class: 'task-when' }, svgIcon('clock'), h('time', { class: 'task-time', text: dueWords(task.dueAt, ctx.timeZone ?? task.timeZone, ctx.year) }), h('span', { class: 'task-rel', text: running ? 'Running now' : relativeWords(task.dueAt - ctx.now) }),
      chip(kindWords(task.kind), 'kind'), task.isDefault ? chip('Default time', 'warn', { title: 'Jet set no time for this, so the server chose this one' }) : null),
    line('task-why', stringOf(task.why)),
    h('p', { class: 'task-meta', text: [orNull(task.objectiveTitle) ? `For ${task.objectiveTitle}` : null, setByWords(task.setBy)].filter(Boolean).join(' · ') }),
    running ? null : h('div', { class: 'task-buttons' },
      button('Snooze', (el) => ctx.act.snooze(task, el), { 'data-key': `snooze-${task.id}`, title: 'Move this to the next 08:00' }),
      button('Cancel', (el) => ctx.act.cancel(task, el), { class: 'pane-button danger', 'data-key': `cancel-${task.id}`, title: 'Jet will not do this check' })));
}

function runRow(run, ctx) {
  const outcome = outcomeOf(run.outcome);
  const sources = stringsOf(run.sourcesRead);
  const found = run.outcome === 'held' ? heldReason(run.found) : stringOf(run.found);
  return h('li', { class: 'plan-card run', 'data-outcome': run.outcome ?? 'running' },
    h('div', { class: 'run-top' }, chip(outcome.words, outcome.tone), h('span', { class: 'run-when', text: `${clockWords(run.startedAt, ctx.timeZone)} · ${relativeWords(run.startedAt - ctx.now)}` })),
    line('run-found', found),
    sources.length ? h('ul', { class: 'sources' }, ...sources.map((source) => h('li', { class: 'source-chip', text: source }))) : null,
    line('run-cost', [tokensWords(run.tokens), costWords(run.cost)].filter(Boolean).join(' · ')));
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

/** The three numbers at the top: what is being worked on, the next check, and how the last one went. */
function glance(pane, ctx, active) {
  const next = pane.tasks.find((task) => task.state !== 'running') ?? pane.tasks[0], last = pane.runs[0];
  const tile = (label, value, detail) => h('div', { class: 'tile' }, h('span', { class: 'tile-label', text: label }), h('span', { class: 'tile-value', text: value }), h('span', { class: 'tile-detail', text: detail }));
  return h('div', { class: 'glance' },
    tile('Working on', String(active.length), active.length === 1 ? 'objective' : 'objectives'),
    tile('Next check', next ? (next.state === 'running' ? 'Now' : relativeWords(next.dueAt - ctx.now)) : 'None', next ? dueWords(next.dueAt, ctx.timeZone ?? next.timeZone, ctx.year) : 'nothing scheduled'),
    tile('Last check', last ? outcomeOf(last.outcome).words : 'None', last ? relativeWords(last.startedAt - ctx.now) : 'none yet'));
}

function invitation() {
  return h('div', { class: 'invite' }, svgIcon('plan'),
    h('h3', { class: 'invite-title', text: 'Nothing to track yet' }),
    h('p', { text: 'Tell Jet what you are working on: what it should deliver, by when, and the steps to get there. Jet keeps the plan here and checks in on its own.' }),
    h('p', { class: 'invite-example', text: '“I need to ship the kite page by Friday.”' }));
}

/** @returns {HTMLElement[]} the sections of the pane for `pane` (from readPane) */
export function planNodes(pane, ctx) {
  if (isEmpty(pane)) return [invitation()];
  const { active, closed } = groupObjectives(pane.objectives);
  const runs = ctx.showAllRuns ? pane.runs : pane.runs.slice(0, RUNS_SHOWN);
  return [
    glance(pane, ctx, active),
    section('Objectives', null,
      active.length ? h('div', { class: 'stack' }, ...active.map((o) => objectiveCard(o, ctx))) : h('p', { class: 'pane-hint', text: 'Nothing active. Tell Jet what you are working on.' }),
      closed.length ? closedList(closed, ctx) : null),
    section("Jet's plan", pane.timeZone ? `Times in ${pane.timeZone}` : null,
      pane.tasks.length ? h('ul', { class: 'stack' }, ...pane.tasks.map((task) => taskRow(task, ctx))) : h('p', { class: 'pane-hint', text: 'Jet has no check scheduled.' })),
    section('Recent checks', null,
      pane.runs.length ? h('ul', { class: 'stack' }, ...runs.map((run) => runRow(run, ctx))) : h('p', { class: 'pane-hint', text: 'Jet has not run a check yet.' }),
      pane.runs.length > RUNS_SHOWN ? button(ctx.showAllRuns ? 'Show fewer' : `Show all ${pane.runs.length}`, () => ctx.set.allRuns(!ctx.showAllRuns), { class: 'pane-button more', 'data-key': 'runs-more' }) : null),
    sentSection(pane.sent, ctx),
    pane.sharedWithMe.length ? section('Shared with you', null, h('div', { class: 'stack' }, ...pane.sharedWithMe.map((item) => sharedCard(item, ctx)))) : null,
  ].filter(Boolean);
}
