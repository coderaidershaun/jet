// Draws each tool call's card from its model, keeps finished cards across redraws,
// turns "[n]" in Jet's text into chips, and opens a source when its chip is pressed.
// Rows and pieces are drawn the first time they are opened, so a closed card costs
// nothing.

import { h, icon } from '../../../dom.js';
import { findSource, splitCitations } from './cite.js';
import { callState, cardOf } from './model.js';
import { fillShow } from './show.js';

const SKIPPED_BY_CITATIONS = 'code, pre, a, button, .math';
const CITED_FOR_MS = 1600;

/**
 * What the cards need from the page: the Markdown renderer, the picture reader and the code sealer.
 * @typedef {{ render: (text: string) => Promise<string>, readImage: (path: string) => Promise<string>, seal: (body: HTMLElement) => void }} Parts
 */

const cardData = (card) => ({ 'data-call': card.id, 'data-state': card.state, 'data-key': card.key });

/** The head reads as one phrase, 'quanty · search · 8 sources · 0.8 s', with the separators in the text for screen readers. */
function head(tag, card) {
  return h(tag, { class: 'card-head' }, h('span', { class: 'card-name', text: card.name }), ' · ', h('span', { class: 'card-meta', text: card.meta }));
}

/** Runs `fill` once, the first time the element opens. The flag is set before the fill starts, so opening twice quickly fills once. */
function onFirstOpen(details, fill) {
  let filled = false;
  details.addEventListener('toggle', () => {
    if (!details.open || filled) return;
    filled = true;
    Promise.resolve(fill()).catch((error) => console.warn('a source could not be shown:', error));
  });
}

/** A number in Jet's text: a chip that opens its source, or plain text when no card above holds it. */
function chip(n, calls) {
  const found = findSource(calls, n);
  if (!found) return '[' + n + ']';
  return h('button', {
    class: 'cite',
    type: 'button',
    'data-call': found.callId,
    'data-n': n,
    title: found.title,
    'aria-label': 'Source ' + n + ': ' + found.title,
    text: String(n),
  });
}

/**
 * Turns each "[n]" in the text of `body` into a chip, except inside code, links, buttons and formulas.
 * @param {HTMLElement} body
 * @param {import('./model.js').ShownCall[]} calls   the finished calls above, oldest first
 */
export function linkCitations(body, calls) {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (/\[\d/.test(node.data) && !node.parentElement.closest(SKIPPED_BY_CITATIONS)) texts.push(node);
  }
  for (const text of texts) {
    text.replaceWith(...splitCitations(text.data).map((part) => (typeof part === 'number' ? chip(part, calls) : part)));
  }
}

/**
 * Opens the card of `callId` and its row n, scrolls to the row and marks it for a moment.
 * @returns {boolean} whether the card was found
 */
export function openSource(root, callId, n) {
  const card = [...root.querySelectorAll('.card')].find((el) => el.dataset.call === callId);
  if (!card) return false;
  if (card.tagName === 'DETAILS') card.open = true;
  const row = card.querySelector('.source[data-n="' + n + '"]') ?? card;
  if (row.tagName === 'DETAILS') row.open = true;
  row.scrollIntoView({ block: 'start' });
  row.querySelector('summary')?.focus({ preventScroll: true });
  row.classList.add('is-cited');
  setTimeout(() => row.classList.remove('is-cited'), CITED_FOR_MS);
  return true;
}

/** @param {import('./model.js').SourceRow} row @param {Parts} parts */
function sourceRow(row, parts) {
  const scoreLabel = row.score === null ? null : 'score ' + row.score.toFixed(2);
  const line = h(
    'span',
    { class: 'source-line' },
    h('span', { class: 'source-n', text: '[' + row.n + ']' }),
    h(
      'span',
      { class: 'source-what' },
      h('span', { class: 'source-doc', title: row.document, text: row.document }),
      h(
        'span',
        { class: 'source-meta' },
        [row.page, row.kind].filter(Boolean).join(' · '),
        row.reason ? ' ' : null,
        row.reason ? h('span', { class: 'reason', 'data-why': row.why, text: row.reason }) : null,
      ),
    ),
    scoreLabel === null ? null : h('meter', { class: 'score', min: 0, max: 1, value: row.score, 'data-score': row.score.toFixed(2), title: scoreLabel, 'aria-label': scoreLabel }),
  );
  const body = h('div', { class: 'source-body' });
  const details = h('details', { class: 'source', 'data-n': row.n }, h('summary', {}, line), body);
  onFirstOpen(details, async () => {
    if (row.byline) body.append(h('p', { class: 'byline', text: row.byline }));
    await fillShow(body, row.show, parts);
  });
  return details;
}

const asked = (text) => (text ? h('p', { class: 'card-asked', text: '“' + text + '”' }) : null);

/** An answer's rows are built at once, so a chip can open one; its claims are drawn the first time the card opens. */
function answerBody(card, parts) {
  const { body } = card;
  const claims = h('div', { class: 'claims' });
  const fill = async () => {
    const drawn = body.claims.map((claim) => {
      const element = h('div', { class: 'claim' });
      claims.append(...[claim.heading ? h('h5', { class: 'claim-heading', text: claim.heading }) : null, element].filter(Boolean));
      const addChips = () => {
        if (claim.sources.length > 0) element.append(h('span', { class: 'claim-sources' }, ...claim.sources.map((n) => chip(n, [card.call]))));
      };
      return fillShow(element, { as: 'markdown', text: claim.text }, parts).then(addChips);
    });
    await Promise.all(drawn);
  };
  return {
    nodes: [
      asked(body.asked),
      body.answered ? null : h('p', { class: 'card-empty', text: 'The library has no answer to this.' }),
      body.title ? h('h4', { class: 'answer-title', text: body.title }) : null,
      claims,
      ...body.rows.map((row) => sourceRow(row, parts)),
      body.followUps.length > 0 ? h('ul', { class: 'follow-ups' }, ...body.followUps.map((text) => h('li', { text }))) : null,
    ],
    fill,
  };
}

/** A page's pieces are drawn in reading order the first time the card opens. */
function pageBody(body, parts) {
  const pieces = h('div', { class: 'pieces' });
  const fill = async () => {
    const drawn = body.pieces.map((piece) => {
      const element = h('div', { class: 'piece', 'data-kind': piece.kind });
      pieces.append(...[piece.crumb ? h('p', { class: 'crumb', text: piece.crumb }) : null, element].filter(Boolean));
      return fillShow(element, piece.show, parts);
    });
    await Promise.all(drawn);
  };
  return { nodes: [h('p', { class: 'card-asked', text: [body.title, body.place].filter(Boolean).join(' · ') }), pieces], fill };
}

/** The nodes of a card's body, and the work to do the first time the card opens, if any. */
function bodyOf(card, parts) {
  const { body } = card;
  switch (body.kind) {
    case 'sources':
      return {
        nodes: [
          asked(body.asked),
          body.rows.length === 0 ? h('p', { class: 'card-empty', text: 'Nothing in the library matched.' }) : null,
          ...body.rows.map((row) => sourceRow(row, parts)),
        ],
      };
    case 'answer':
      return answerBody(card, parts);
    case 'page':
      return pageBody(body, parts);
    case 'documents':
      return {
        nodes: [
          h(
            'table',
            { class: 'documents' },
            h('thead', {}, h('tr', {}, ...['Title', 'Authors', 'Pages'].map((name) => h('th', { scope: 'col', text: name })))),
            h('tbody', {}, ...body.documents.map((document) => h('tr', {}, h('td', { text: document.title }), h('td', { text: document.authors }), h('td', { text: document.pages })))),
          ),
          ...body.unreadable.map((line) => h('p', { class: 'card-note', text: line })),
        ],
      };
    case 'health':
      return { nodes: [h('ul', { class: 'health' }, ...body.lines.map((line) => h('li', { 'data-tone': line.ok ? 'ok' : 'invalid', text: line.text })))] };
    default:
      return { nodes: [h('dl', { class: 'fields' }, ...body.fields.flatMap((field) => [h('dt', { text: field.term }), h('dd', {}, field.pre ? h('pre', { text: field.text }) : field.text)]))] };
  }
}

/** The card of a written file: what it is, and two links built from its id alone. */
function fileCard(card) {
  const { body } = card;
  const sheet = h('span', { class: 'file-sheet', 'data-format': body.tag.toLowerCase(), 'aria-hidden': 'true' }, h('span', { class: 'file-tag', text: body.tag }));
  const open = h('a', { class: 'file-action', href: body.view, target: '_blank', rel: 'noopener', 'data-file': true, 'aria-label': 'Open ' + body.name, text: 'Open' });
  const download = h('a', { class: 'file-action file-primary', href: body.download, download: body.name, 'data-file': true, 'aria-label': 'Download ' + body.name }, icon('download'), 'Download');
  return h(
    'div',
    { class: 'card card-file', 'data-tone': card.tone, ...cardData(card) },
    sheet,
    h('div', { class: 'file-what' }, h('p', { class: 'file-title', text: body.title }), h('p', { class: 'file-meta', title: body.name, text: body.meta })),
    h('div', { class: 'file-actions' }, open, download),
  );
}

function defaultCard(card, parts) {
  if (card.state === 'unfinished') {
    return h('div', { class: 'card card-ended', ...cardData(card) }, h('span', { class: 'card-line', text: card.line + ' · stopped' }));
  }
  if (card.state === 'failed') {
    return h(
      'div',
      { class: 'card card-failed', 'data-tone': 'invalid', ...cardData(card) },
      head('p', card),
      h('p', { class: 'card-advice', text: card.advice }),
      card.hint ? h('p', { class: 'card-hint', text: card.hint }) : null,
    );
  }
  const { nodes, fill } = bodyOf(card, parts);
  const details = h('details', { class: 'card', 'data-tone': card.tone, ...cardData(card) }, head('summary', card), h('div', { class: 'card-body' }, ...nodes));
  if (fill) onFirstOpen(details, fill);
  return details;
}

/**
 * The node of a call that has ended: done, failed or unfinished.
 * @param {import('./model.js').Card} card
 * @param {Omit<Parts, 'readImage'> & { readImage: (appId: string, path: string) => Promise<string> }} parts
 */
export function renderResultCard(card, parts) {
  if (card.state === 'done' && card.body?.kind === 'file') return fileCard(card);
  return defaultCard(card, { ...parts, readImage: (path) => parts.readImage(card.call.server, path) });
}

function runningCard(card) {
  return h(
    'div',
    { class: 'card card-running', 'aria-busy': 'true', ...cardData(card) },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    h('span', { class: 'card-line', title: card.line, text: card.line }),
  );
}

/**
 * Keeps one node per call in `container`. A finished card is built once and never rebuilt, so its open state and
 * the rows drawn inside it survive every redraw of the thread.
 * @param {HTMLElement} container
 * @param {Omit<Parts, 'readImage'> & { readImage: (appId: string, path: string) => Promise<string> }} parts
 */
export function createCardList(container, parts) {
  /** @type {Map<string, { el: HTMLElement, state: string }>} */
  const kept = new Map();
  return {
    /**
     * @param {import('./model.js').ShownCall[]} calls   this reply's calls, in order
     * @param {import('./model.js').ShownCall[]} earlier   the finished calls of the replies above, oldest first
     */
    sync(calls, earlier) {
      const above = [...earlier];
      const present = new Set();
      calls.forEach((call, i) => {
        present.add(call.id);
        const state = callState(call);
        let record = kept.get(call.id);
        if (!record || record.state !== state) {
          const card = cardOf(call, above);
          const el = state === 'running' ? runningCard(card) : renderResultCard(card, parts);
          if (record?.state === 'running' && card.body?.kind === 'file') el.classList.add('is-arriving');
          record?.el.replaceWith(el);
          record = { el, state };
          kept.set(call.id, record);
        }
        if (container.children[i] !== record.el) container.insertBefore(record.el, container.children[i] ?? null);
        if (state === 'done') above.push(call);
      });
      for (const [id, record] of kept) {
        if (present.has(id)) continue;
        record.el.remove();
        kept.delete(id);
      }
    },
  };
}
