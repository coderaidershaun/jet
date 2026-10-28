// How quanty's library tools read as cards: the overview of a document, its outline, the text of a section
// or of some pages, one item, several reads in one, the list of media, and the check of a PDF.
// Each reader gives back null for a result of a shape it does not know, and the card then shows the
// plain fields. Pure, with no DOM.

import { CUT_SHORT, cardOfBlocks, facts, lead, list, note, outline, part, show } from './block.js';
import { count, counted, isRecord, joined, listOf, numberOrNull, numeral, orNull, recordOf, stringOf, stringsOf } from './guard.js';
import { pageLabel, pageTitle, piecesOf, showOf } from './pieces.js';

const CUT_NOTE = 'Cut short. Reading again with the cursor this result gives continues from here.';
const ITEM_NOUNS = { formula: 'formula', figure: 'figure', table: 'table', code: 'code listing' };
const INSIGHTS_STATE = { saved: 'insights saved', not_written_yet: 'no insights yet', none_for_book_part: 'no insights for this part' };
const MAX_DEPTH = 3;

const unspaced = (text) => text.replace(/_/g, ' ');
const plainRows = (texts) => texts.map((text) => ({ text, meta: '' }));
const insightsWords = (state) => (Object.hasOwn(INSIGHTS_STATE, state) ? INSIGHTS_STATE[state] : unspaced(stringOf(state)));

/** The pages of a section as [first, last], or null for a section with none, which quanty writes [0, 0]. */
function rangeOf(first, last) {
  const [from, to] = [numberOrNull(first), numberOrNull(last)];
  return from === null || to === null || from < 1 || to < from ? null : [from, to];
}
const rangeOfPair = (pair) => (Array.isArray(pair) ? rangeOf(...pair) : null);
const spanOf = ([from, to]) => (from === to ? String(from) : from + '–' + to);
const pagesWords = (range) => (range ? (range[0] === range[1] ? 'page ' : 'pages ') + spanOf(range) : '');
const pagesMeta = (range) => (range ? 'p. ' + spanOf(range) : '');

/** The text of an `{ error }` part of a result, else null. */
const errorOf = (value) => orNull(recordOf(value).error);
const unavailable = (what, value) => (errorOf(value) ? note(what + ' could not be read: ' + errorOf(value)) : null);

function outlineRows(sections) {
  return listOf(sections).map((raw, position) => {
    const section = recordOf(raw);
    const path = stringsOf(section.path);
    const heading = [orNull(section.printed_number), path.at(-1)].filter(Boolean).join(' ');
    const rank = numberOrNull(section.rank);
    const range = rangeOfPair(section.pages);
    return {
      text: heading || 'Section ' + (numberOrNull(section.index) ?? position + 1),
      meta: pagesMeta(range),
      depth: Math.max(0, Math.min(MAX_DEPTH, (rank ?? path.length) - 1)),
    };
  });
}

function itemCounts(items) {
  return Object.entries(ITEM_NOUNS)
    .map(([kind, noun]) => [numberOrNull(recordOf(items)[kind]) ?? 0, noun])
    .filter(([n]) => n > 0);
}

function conceptRows(concepts) {
  return listOf(concepts).map((raw) => {
    const concept = recordOf(raw);
    return { text: stringOf(concept.name), meta: counted(concept.mentions, 'mention'), detail: stringOf(concept.definition) };
  });
}

function artifactsWords(artifacts) {
  const done = numberOrNull(artifacts.total) === null ? '' : `${numberOrNull(artifacts.done) ?? 0} of ${artifacts.total}`;
  return joined(unspaced(stringOf(artifacts.state)), done);
}

function readOverview(result) {
  if (typeof result.document_id !== 'string') return null;
  const found = itemCounts(result.items);
  const insights = recordOf(result.insights);
  const related = listOf(result.related_documents).map((raw) => {
    const document = recordOf(raw);
    return { text: stringOf(document.title), meta: counted(document.shared, 'shared concept') };
  });
  const blocks = [
    lead(joined(pageTitle(result), counted(result.pages, 'page'))),
    facts([
      ['Items', found.map(([n, noun]) => count(n, noun)).join(', ')],
      ['Insights', insightsWords(insights.state)],
      ['Artifacts', artifactsWords(recordOf(result.artifacts))],
    ]),
    unavailable('The insights', result.insights),
    list('Takeaways', plainRows(stringsOf(insights.takeaways))),
    unavailable('The concepts', result.concepts),
    list('Top concepts', conceptRows(result.concepts)),
    unavailable('The related documents', result.related_documents),
    list('Related documents', related),
    outline(outlineRows(result.outline)),
  ];
  const total = found.reduce((sum, [n]) => sum + n, 0);
  return cardOfBlocks(joined(counted(result.pages, 'page'), total > 0 ? count(total, 'item') : '') || 'overview', 'quiet', blocks);
}

function readOutline(result) {
  if (typeof result.document_id !== 'string' || !Array.isArray(result.sections)) return null;
  const rows = outlineRows(result.sections);
  const blocks = [
    lead(pageTitle(result)),
    orNull(result.concepts_error) ? note('The concepts could not be read: ' + result.concepts_error) : null,
    outline(rows) ?? note('This document has no sections.'),
  ];
  return cardOfBlocks(count(rows.length, 'section'), 'quiet', blocks);
}

/** The text of a read as the page draws it (Markdown, or the pieces one by one), and a note when it was cut short. */
function textBlocks(result) {
  const pieces = piecesOf(result.pieces).map((piece) => show(piece.show, piece.kind, piece.crumb));
  const text = orNull(result.text) ? [show({ as: 'markdown', text: result.text })] : [];
  const read = [...text, ...pieces];
  return [...(read.length > 0 ? read : [note('Nothing was read.')]), cutNote(result)];
}

const isText = (result) => typeof result.document_id === 'string' && (typeof result.text === 'string' || Array.isArray(result.pieces));
const cutWords = (result) => (result.truncated === true ? CUT_SHORT : '');
const cutNote = (result) => (result.truncated === true ? note(CUT_NOTE) : null);

function readSection(result) {
  if (!isText(result)) return null;
  const range = rangeOfPair(result.pages);
  const header = lead(joined(pageTitle(result), stringsOf(result.path).join(' › '), pagesWords(range)));
  return cardOfBlocks(joined(pagesWords(range) || 'section', cutWords(result)), 'quiet', [header, ...textBlocks(result)]);
}

function readPages(result) {
  if (!isText(result)) return null;
  const range = rangeOf(result.from, result.to);
  const ofAll = range && numberOrNull(result.pages) !== null ? ' of ' + result.pages : '';
  const header = lead(joined(pageTitle(result), pagesWords(range) + ofAll));
  return cardOfBlocks(joined(pagesWords(range) || 'pages', cutWords(result)), 'quiet', [header, ...textBlocks(result)]);
}

function readItem(result) {
  if (typeof result.item_id !== 'string' || typeof result.kind !== 'string') return null;
  const cited = listOf(result.cited_by).map((raw) => ({ text: stringOf(recordOf(raw).excerpt), meta: pageLabel(raw) }));
  const blocks = [
    lead(pageTitle(result)),
    facts([['Kind', result.kind], ['Label', orNull(result.label)], ['Place', pageLabel(result)], ['Section', stringsOf(result.section).join(' › ')], ['Caption', orNull(result.caption)]]),
    show(showOf(result.kind, result.content, result), result.kind),
    list('Cited by', cited),
    cutNote(result),
  ];
  return cardOfBlocks(joined(result.kind, orNull(result.label), pageLabel(result), cutWords(result)), 'quiet', blocks);
}

/** A saved chapter insights result, which `read_many` can hold. */
function readChapterInsights(result) {
  if (typeof result.state !== 'string') return null;
  const insights = listOf(result.insights).map((raw) => {
    const insight = recordOf(raw);
    return { text: stringOf(insight.text), meta: pagesMeta(rangeOfPair(insight.pages)) };
  });
  const blocks = [
    lead(pageTitle(result)),
    list('Takeaways', plainRows(stringsOf(result.takeaways))),
    list('Insights', insights),
    cutNote(result),
  ];
  return cardOfBlocks(joined(insightsWords(result.state), cutWords(result)), 'quiet', blocks);
}

const INNER_READERS = { read_section: readSection, read_pages: readPages, read_item: readItem, chapter_insights: readChapterInsights };

/** One read of a `read_many`, drawn as a part with its own words and its own mark when it was cut short. */
function partOf(raw) {
  const entry = recordOf(raw);
  const tool = orNull(entry.tool) ?? 'read';
  if (orNull(entry.error)) return part(tool, 'failed', [note(entry.error)]);
  if (entry.result === undefined) return part(tool, 'not read', [note('Not read: the budget ran out.')]);
  const read = isRecord(entry.result) && Object.hasOwn(INNER_READERS, tool) ? INNER_READERS[tool](entry.result) : null;
  if (!read) return part(tool, '', [note('This result could not be read.')]);
  const cut = entry.truncated === true && entry.result.truncated !== true;
  return part(tool, joined(read.outcome, cut ? CUT_SHORT : ''), [...read.body.blocks, cut ? note(CUT_NOTE) : null]);
}

function readMany(result) {
  if (!Array.isArray(result.results)) return null;
  const cut = result.results.filter((entry) => recordOf(entry).truncated === true).length;
  return cardOfBlocks(joined(count(result.results.length, 'read'), cut > 0 ? cut + ' ' + CUT_SHORT : ''), 'quiet', result.results.map(partOf));
}

function readMedia(result) {
  if (!Array.isArray(result.media)) return null;
  const rows = result.media.map((raw) => {
    const media = recordOf(raw);
    const meta = joined(orNull(media.category), stringsOf(media.authors).join(', '), counted(media.documents, 'document'), counted(media.pages, 'page'), counted(media.items, 'item'));
    return { text: stringOf(media.title), meta };
  });
  return cardOfBlocks(rows.length + ' media', 'quiet', [list(null, rows, 'The library has no media.')]);
}

function pdfState(result) {
  if (result.state === null) return 'different PDF in its folder';
  if (typeof result.state !== 'string') return '';
  const words = unspaced(result.state);
  const done = result.state === 'partly_converted' ? counted(result.pages_done, 'page') : '';
  return done ? words + ' (' + done + ' done)' : words;
}

/** 'about $0.42–$0.61, 4 minutes', or 'about 4 minutes, cost unknown' when a price is missing. */
function estimateWords(estimate) {
  const [low, high, minutes] = [numberOrNull(estimate.usd_low), numberOrNull(estimate.usd_high), numberOrNull(estimate.minutes)];
  const time = minutes === null ? '' : count(minutes, 'minute');
  if (low !== null && high !== null) return 'about $' + low.toFixed(2) + '–$' + high.toFixed(2) + (time ? ', ' + time : '');
  return time ? 'about ' + time + ', cost unknown' : '';
}

function readCheck(result) {
  if (!Array.isArray(result.blockers)) return null;
  const blockers = stringsOf(result.blockers);
  const estimate = estimateWords(recordOf(result.estimate));
  const blocks = [
    facts([
      ['Title', orNull(result.title)],
      ['Media', orNull(result.media)],
      ['File', orNull(result.file)],
      ['Category', orNull(result.category)],
      ['State', pdfState(result)],
      ['Pages', numeral(result.pages)],
      ['Items', numeral(result.items)],
      ['Estimate', estimate],
    ]),
    list('Blockers', plainRows(blockers)),
  ];
  return cardOfBlocks(checkOutcome(result, blockers, estimate), blockers.length > 0 ? 'invalid' : 'ok', blocks);
}

/** A stored document has nothing left to convert, and an ingest would only repair it or do nothing, so its state is the summary. */
function checkOutcome(result, blockers, estimate) {
  if (blockers.length > 0) return count(blockers.length, 'blocker');
  if (result.state === 'ingested') return 'already ingested';
  if (typeof result.state === 'string' && result.state.startsWith('ingested_')) return pdfState(result);
  return joined('ready to ingest', estimate);
}

export const LIBRARY_READERS = {
  document_overview: readOverview,
  document_outline: readOutline,
  read_section: readSection,
  read_pages: readPages,
  read_item: readItem,
  read_many: readMany,
  list_media: readMedia,
  check_pdf: readCheck,
};
