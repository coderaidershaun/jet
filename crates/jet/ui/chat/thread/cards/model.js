// What the card of one tool call says: the line while it runs, a one-line summary
// when it finishes, the server's advice when it fails, and the sources it gave
// back. It reads results that come from outside, so every field is checked and a
// missing one shows as empty. Pure, with no DOM.

import { KINDS, fileLinks, sizeOf } from '../../files.js';

/**
 * One tool call as the thread keeps it. No `ok` yet: still running. `unfinished`: the reply ended first.
 * @typedef {{ id: string, server: string, tool: string, input: any, ok?: boolean, result?: any,
 *   summary?: string, durationMs?: number, unfinished?: boolean }} ShownCall
 */
/** @typedef {'running' | 'done' | 'failed' | 'unfinished'} CallState */
/**
 * @typedef {{ as: 'markdown', text: string, footnote?: boolean }
 *   | { as: 'heading', text: string }
 *   | { as: 'formula', tex: string, label: string | null }
 *   | { as: 'table', text: string, label: string | null }
 *   | { as: 'figure', picture: string | null, text: string, label: string | null }
 *   | { as: 'code', text: string, language: string | null, label: string | null }
 *   | { as: 'plain', text: string }} Show
 */
/** @typedef {{ n: number, document: string, page: string, kind: string, reason: string, why: string, score: number | null, byline: string, title: string, show: Show }} SourceRow */
/** @typedef {{ n: number, kind: string, crumb: string | null, show: Show }} Piece */
/** @typedef {{ term: string, text: string, pre?: boolean }} Field */
/**
 * @typedef {{ kind: 'sources', asked: string | null, rows: SourceRow[] }
 *   | { kind: 'answer', asked: string | null, answered: boolean, title: string | null,
 *       claims: { heading: string | null, text: string, sources: number[] }[], rows: SourceRow[], followUps: string[] }
 *   | { kind: 'page', title: string, place: string, pieces: Piece[] }
 *   | { kind: 'documents', documents: { title: string, authors: string, pages: string }[], unreadable: string[] }
 *   | { kind: 'health', lines: { text: string, ok: boolean }[] }
 *   | { kind: 'fields', fields: Field[] }
 *   | { kind: 'file', name: string, title: string, tag: string, meta: string, download: string, view: string }} Body
 */
/**
 * @typedef {{ id: string, key: string, call: ShownCall, state: CallState, line: string, name: string, meta: string,
 *   head: string, tone: 'ok' | 'invalid' | 'quiet', advice: string | null, hint: string | null, body: Body | null }} Card
 */

const OPEN_QUOTE = '“';
const CLOSE_QUOTE = '”';
// SMELL: these match the words quanty writes in its advice and in its health report. If quanty rewords them, the
// health hint and the red report lines stop showing, and no test here notices.
const HEALTH_SENTENCE = /\s*Call the `health` tool[^.]*\.?/;
const FAILED_LINE = /FAILED/;
const HEALTH_HINT = 'Ask for a health check to see which service is down.';
const FILE_TOOL = 'jet/files_export';
const READ_TOOL = 'jet/files_read';
const LIST_TOOL = 'jet/files_list';

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const recordOf = (value) => (isRecord(value) ? value : {});
const listOf = (value) => (Array.isArray(value) ? value : []);
const stringOf = (value) => (typeof value === 'string' ? value : '');
const stringsOf = (value) => listOf(value).filter((item) => typeof item === 'string');
const orNull = (value) => (typeof value === 'string' && value !== '' ? value : null);
const joined = (...parts) => parts.filter(Boolean).join(' · ');
const quoted = (text) => OPEN_QUOTE + text + CLOSE_QUOTE;
const count = (n, noun) => n + ' ' + noun + (n === 1 ? '' : 's');
const seconds = (ms) => (ms < 10000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000).toString()) + ' s';

/** The result as text, for advice and for a result that is not an object. */
function textOf(value) {
  if (typeof value === 'string') return value;
  return value === undefined ? '' : JSON.stringify(value);
}

/** The format of a file Jet writes, from the call's input while it runs and from its result when it is done. */
function fileFormatOf(call) {
  const named = stringOf(recordOf(call.result).format) || stringOf(recordOf(call.input).format);
  return Object.hasOwn(KINDS, named) && KINDS[named].writing ? KINDS[named] : null;
}

/** @param {ShownCall} call @returns {CallState} */
export function callState(call) {
  if (call.unfinished) return 'unfinished';
  if (call.ok === undefined) return 'running';
  return call.ok ? 'done' : 'failed';
}

/** 'p.145' when the book prints the page, else 'page 15': the place in the chapter, which is not a printed number. */
function pageLabel(item) {
  const { printed_page: printed, page } = recordOf(item);
  if (typeof printed === 'string' && printed !== '') return 'p.' + printed;
  return 'page ' + (page ?? '?');
}

/** 'Option Volatility & Pricing, chapter 9: Risk Measurement II · p.145' */
export function sourceTitle(item) {
  return joined(stringOf(recordOf(item).document), pageLabel(item));
}

/**
 * How a hit or a page piece is drawn, by its kind. `item` supplies the label, picture and language.
 * @returns {Show}
 */
function showOf(kind, text, item = {}) {
  const { label, picture, language } = recordOf(item);
  const words = stringOf(text);
  switch (kind) {
    case 'chunk':
    case 'text':
      return { as: 'markdown', text: words };
    case 'footnote':
      return { as: 'markdown', text: words, footnote: true };
    case 'heading':
      return { as: 'heading', text: words };
    case 'formula':
      return { as: 'formula', tex: words.trim(), label: orNull(label) };
    case 'table':
      return { as: 'table', text: words, label: orNull(label) };
    case 'figure':
      return { as: 'figure', picture: orNull(picture), text: words, label: orNull(label) };
    case 'code':
      return { as: 'code', text: words, language: orNull(language), label: orNull(label) };
    default:
      return { as: 'plain', text: words };
  }
}

function reasonTag(reason) {
  switch (reason.why) {
    case 'nearest':
      return 'nearest';
    case 'concept':
      return 'via ' + stringOf(reason.concept);
    case 'cited':
      return typeof reason.by === 'number' ? 'cited by [' + reason.by + ']' : 'cited';
    default:
      return '';
  }
}

/** @returns {SourceRow} */
function rowOf(raw, index) {
  const item = recordOf(raw);
  const reason = recordOf(item.reason);
  return {
    n: typeof item.number === 'number' ? item.number : index + 1,
    document: stringOf(item.document),
    page: pageLabel(item),
    kind: stringOf(item.kind),
    reason: reasonTag(reason),
    why: stringOf(reason.why),
    score: typeof item.score === 'number' ? item.score : null,
    byline: joined(stringsOf(item.authors).join(', '), stringOf(item.category)),
    title: sourceTitle(item),
    show: showOf(item.kind, item.text, item),
  };
}

/** @returns {Piece[]} */
function piecesOf(pieces) {
  let previous = '';
  return listOf(pieces).map((raw, index) => {
    const piece = recordOf(raw);
    const section = listOf(piece.section).join(' › ');
    const crumb = section !== '' && section !== previous ? section : null;
    previous = section;
    return { n: typeof piece.number === 'number' ? piece.number : index + 1, kind: stringOf(piece.kind), crumb, show: showOf(piece.kind, piece.content, piece) };
  });
}

function pageTitle(page) {
  const title = orNull(page.document_title);
  if (title) return title;
  const chapter = typeof page.chapter_number === 'number'
    ? 'chapter ' + page.chapter_number + (page.chapter_name ? ': ' + stringOf(page.chapter_name) : '')
    : '';
  return [stringOf(page.media), chapter].filter(Boolean).join(', ');
}

/** The title of a document that a call above already named, else null. */
function titleOfDocument(documentId, earlier) {
  if (typeof documentId !== 'string') return null;
  for (const call of earlier) {
    if (call.server !== 'quanty') continue;
    const result = recordOf(call.result);
    const named = [...listOf(result.results), ...listOf(result.sources)].map(recordOf);
    const source = named.find((item) => item.document_id === documentId && typeof item.document === 'string');
    if (source) return source.document;
    const listed = listOf(result.documents).map(recordOf).find((item) => item.document_id === documentId && typeof item.title === 'string');
    if (listed) return listed.title;
    if (call.tool === 'read_page' && result.document_id === documentId) return pageTitle(result);
  }
  return null;
}

/** What the call is doing, in words. It also stays on the card as the name of what was asked. */
function lineOf(call, earlier) {
  const input = recordOf(call.input);
  const asked = orNull(input.question);
  switch (call.server + '/' + call.tool) {
    case 'quanty/search':
      return asked ? 'Searching quanty · ' + quoted(asked) : 'Searching quanty';
    case 'quanty/read_page': {
      const title = titleOfDocument(input.document_id, earlier) ?? 'a document';
      const page = typeof input.page === 'number' || typeof input.page === 'string' ? 'page ' + input.page : 'a page';
      return 'Reading ' + page + ' of ' + title;
    }
    case 'quanty/answer':
      return asked ? 'Answering · ' + quoted(asked) : 'Answering';
    case 'quanty/list_documents':
      return 'Listing the library';
    case 'quanty/health':
      return 'Checking the library';
    case 'quanty/ingest_pdf': {
      const file = stringOf(input.path).split(/[\\/]/).pop() || stringOf(input.file_name);
      return file ? 'Adding a PDF · ' + file : 'Adding a PDF';
    }
    case 'quanty/ingest_status':
      return 'Checking the ingest';
    case READ_TOOL:
      return 'Reading a file';
    case LIST_TOOL:
      return 'Listing files';
    case FILE_TOOL: {
      const writing = fileFormatOf(call)?.writing;
      const title = orNull(input.title);
      if (!writing) return 'Writing a file';
      return title ? 'Writing ' + quoted(title) + ' as ' + writing : 'Writing ' + writing;
    }
    default:
      return 'Calling ' + call.server + ' · ' + call.tool;
  }
}

function fieldText(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number')) return value.join(', ');
  return JSON.stringify(value);
}

/** @returns {Field[]} */
function fieldsOf(value) {
  if (!isRecord(value)) return [{ term: 'result', text: textOf(value) }];
  return Object.entries(value).map(([term, entry]) => ({ term, text: fieldText(entry) }));
}

/** A call with no reader of its own: the outcome comes from its summary, and its result shows as plain fields. */
function readGeneric(result, _input, call) {
  if (call.server === 'jet' && call.tool === 'apps_update' && typeof result.change?.change === 'string') {
    const outcome = joined(result.change.change, orNull(result.app?.label) ?? orNull(result.change.appId));
    return { outcome, tone: 'quiet', body: { kind: 'fields', fields: fieldsOf(call.result) } };
  }
  const prefix = call.server + ' · ' + call.tool + ' · ';
  const summary = stringOf(call.summary);
  const outcome = summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
  return { outcome: outcome || 'done', tone: 'quiet', body: { kind: 'fields', fields: fieldsOf(call.result) } };
}

function readSearch(result, input) {
  const rows = listOf(result.results).map(rowOf);
  return { outcome: count(rows.length, 'source'), tone: 'quiet', body: { kind: 'sources', asked: orNull(input.question), rows } };
}

function readAnswer(result, input) {
  const claims = listOf(result.claims).map((raw) => {
    const claim = recordOf(raw);
    return { heading: orNull(claim.heading), text: stringOf(claim.text), sources: listOf(claim.sources).filter((n) => typeof n === 'number') };
  });
  const rows = listOf(result.sources).map(rowOf);
  const answered = typeof result.answered === 'boolean' ? result.answered : claims.length > 0;
  const outcome = answered ? joined(count(claims.length, 'claim'), count(rows.length, 'source')) : 'no answer';
  const body = { kind: 'answer', asked: orNull(input.question), answered, title: orNull(result.title), claims, rows, followUps: stringsOf(result.follow_ups) };
  return { outcome, tone: 'quiet', body };
}

function readPage(result) {
  const pieces = piecesOf(result.pieces);
  const where = 'page ' + (result.page ?? '?') + (typeof result.pages === 'number' ? ' of ' + result.pages : '');
  const place = orNull(result.printed_page) ? pageLabel(result) + ' · ' + where : where;
  return { outcome: joined(pageLabel(result), count(pieces.length, 'piece')), tone: 'quiet', body: { kind: 'page', title: pageTitle(result), place, pieces } };
}

function readDocuments(result) {
  const documents = listOf(result.documents).map((raw) => {
    const document = recordOf(raw);
    return { title: stringOf(document.title), authors: stringsOf(document.authors).join(', '), pages: document.pages == null ? '' : String(document.pages) };
  });
  return { outcome: count(documents.length, 'document'), tone: 'quiet', body: { kind: 'documents', documents, unreadable: stringsOf(result.unreadable_chapters) } };
}

function readHealth(result) {
  const lines = stringOf(result.report).split('\n').filter(Boolean).map((text) => ({ text, ok: !FAILED_LINE.test(text) }));
  const healthy = typeof result.healthy === 'boolean' ? result.healthy : lines.every((line) => line.ok);
  return { outcome: healthy ? 'healthy' : 'not healthy', tone: healthy ? 'ok' : 'invalid', body: { kind: 'health', lines } };
}

function readIngest(result, input, call) {
  const state = orNull(result.state);
  const items = typeof result.items === 'number' ? result.items : null;
  const cost = typeof result.cost_usd === 'number' ? '$' + result.cost_usd.toFixed(2) : null;
  const entries = [
    ['State', state && state.replace(/_/g, ' ')], ['Stage', orNull(result.stage)], ['Media', orNull(result.media)], ['File', orNull(result.file)],
    ['Document', orNull(result.document_id)], ['Items', items === null ? null : String(items)], ['Cost', cost],
  ];
  const fields = entries.filter(([, text]) => text).map(([term, text]) => ({ term, text }));
  const summary = orNull(result.summary);
  if (summary) fields.push({ term: 'Summary', text: summary, pre: true });
  const error = orNull(result.error);
  if (error) fields.push({ term: 'Error', text: error });

  const outcomes = {
    running: joined('running', orNull(result.stage)),
    done: joined('done', items === null ? '' : count(items, 'item')),
    already_ingested: 'already in the library',
    failed: 'failed',
  };
  const outcome = state ? (Object.hasOwn(outcomes, state) ? outcomes[state] : state) : readGeneric(result, {}, call).outcome;
  const tone = state === 'failed' ? 'invalid' : state === 'done' || state === 'already_ingested' ? 'ok' : 'quiet';
  return { outcome, tone, body: { kind: 'fields', fields } };
}

/** The saved file of a finished export. A result without a UUID id is not a file, and no link is made from it. */
function readFile(result, input, call) {
  const format = fileFormatOf(call);
  const links = fileLinks(result.id);
  if (!links || !format) return { problem: "This file can't be found." };
  const title = orNull(result.title) ?? orNull(input.title) ?? 'Document';
  const name = orNull(result.name) ?? title;
  const meta = joined(format.label, typeof result.bytes === 'number' ? sizeOf(result.bytes) : '');
  const body = { kind: 'file', name, title, tag: format.tag, meta, download: links.download, view: links.view };
  return { outcome: meta, tone: 'ok', body };
}

const grouped = (n) => n.toLocaleString('en-US');

/** What a read of an attached file gave back, in one line and with no body: the file, and the part of it that was read. */
function readAttached(result) {
  const name = orNull(result.name);
  if (typeof result.mime === 'string') {
    const size = typeof result.width === 'number' && typeof result.height === 'number' ? result.width + ' × ' + result.height + ' ' : '';
    return { outcome: joined(name, size + 'picture'), tone: 'quiet', body: null };
  }
  const unit = stringOf(result.unit);
  const [start, end, total] = ['start', 'end', 'total'].map((key) => (typeof result[key] === 'number' ? result[key] : null));
  let part = '';
  if (unit && start !== null && end !== null && total !== null) {
    if (end < start) part = 'nothing from ' + grouped(start) + ' · ' + grouped(total) + ' ' + unit + ' in all';
    else if (end === start) part = unit.replace(/s$/, '') + ' ' + grouped(start) + ' of ' + grouped(total);
    else part = unit + ' ' + grouped(start) + '–' + grouped(end) + ' of ' + grouped(total);
  }
  return { outcome: joined(name, part) || 'read', tone: 'quiet', body: null };
}

function readFileList(result) {
  return { outcome: count(listOf(result.files).length, 'file'), tone: 'quiet', body: null };
}

/** The sentence a failed call gave back, from a result that may be text or an error record. */
function messageOf(result) {
  const record = recordOf(result);
  return orNull(recordOf(record.error).message) ?? orNull(record.message) ?? orNull(record.error) ?? textOf(result);
}

/** Numbered sources are a result format, independent of an app's registered ID. */
export function citationSources(call) {
  if (callState(call) !== 'done' || !isRecord(call.result)) return [];
  const sources = call.tool === 'search' ? call.result.results : call.tool === 'answer' ? call.result.sources : null;
  return Array.isArray(sources) ? sources.filter((source) => isRecord(source) && Number.isInteger(source.number) && typeof source.document === 'string') : [];
}

function readerFor(call) {
  const key = call.server + '/' + call.tool;
  if (key === FILE_TOOL) return readFile;
  if (key === READ_TOOL) return readAttached;
  if (key === LIST_TOOL) return readFileList;
  if (!isRecord(call.result)) return readGeneric;
  const legacy = READERS[call.server + '/' + call.tool];
  if (legacy) return legacy;
  if (citationSources(call).length) return call.tool === 'search' ? readSearch : readAnswer;
  if (call.tool === 'read_page' && Array.isArray(call.result.pieces) && typeof call.result.document_id === 'string') return readPage;
  return readGeneric;
}

const READERS = {
  'quanty/search': readSearch,
  'quanty/answer': readAnswer,
  'quanty/read_page': readPage,
  'quanty/list_documents': readDocuments,
  'quanty/health': readHealth,
  'quanty/ingest_pdf': readIngest,
  'quanty/ingest_status': readIngest,
};

/**
 * The card of a call. `earlier` holds the finished calls above it, oldest first, so a page can name its document.
 * It never throws: it runs while the thread paints, and a throw there would stop every later paint.
 * @param {ShownCall} call
 * @param {ShownCall[]} [earlier]
 * @returns {Card}
 */
export function cardOf(call, earlier = []) {
  const state = callState(call);
  const name = call.server + ' · ' + call.tool;
  const line = lineOf(call, earlier);
  const time = typeof call.durationMs === 'number' ? seconds(call.durationMs) : '';
  const card = { id: call.id, key: call.server + '/' + call.tool, call, state, line, name, meta: '', head: line, tone: 'quiet', advice: null, hint: null, body: null };
  const ended = (meta) => ({ ...card, meta, head: name + ' · ' + meta });

  if (state === 'running') return card;
  if (state === 'unfinished') return ended('stopped');
  if (state === 'failed' && (card.key === FILE_TOOL || card.key === READ_TOOL)) {
    const failedName = card.key === READ_TOOL ? "Couldn't read the file" : "Couldn't write the " + (fileFormatOf(call)?.label ?? 'file');
    const meta = joined('failed', time);
    return { ...card, name: failedName, meta, head: failedName + ' · ' + meta, tone: 'invalid', advice: messageOf(call.result) };
  }
  if (state === 'failed') {
    const advice = textOf(call.result);
    const hinted = HEALTH_SENTENCE.test(advice);
    return { ...ended(joined('failed', time)), tone: 'invalid', advice: advice.replace(HEALTH_SENTENCE, '').trim(), hint: hinted ? HEALTH_HINT : null };
  }

  const input = recordOf(call.input);
  const read = readerFor(call);
  const { outcome, tone, body, problem } = read(recordOf(call.result), input, call);
  if (problem) return { ...ended(joined('failed', time)), state: 'failed', tone: 'invalid', advice: problem };
  return { ...ended(joined(outcome, time)), tone, body };
}
