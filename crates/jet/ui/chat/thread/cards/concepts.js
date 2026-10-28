// How quanty's concept tools read as cards: one concept, how concepts relate, the items that mention a concept,
// two documents compared, and the lists of concepts and items that a search found. Each reader gives back
// null for a result of a shape it does not know, and the card then shows the plain fields. Pure, with no DOM.

import { CUT_SHORT, cardOfBlocks, facts, lead, list, note } from './block.js';
import { count, counted, isRecord, joined, listOf, numberOrNull, numeral, orNull, recordOf, stringOf, stringsOf } from './guard.js';
import { pageLabel } from './pieces.js';

/** What a concept is called, by its ID, from the `concepts` a result lists. An ID it does not list shows as itself. */
function namer(...concepts) {
  const named = concepts.flatMap(listOf).map(recordOf).filter((concept) => typeof concept.concept_id === 'string');
  const names = new Map(named.map((concept) => [concept.concept_id, stringOf(concept.name)]));
  return (id) => names.get(id) || (typeof id === 'string' ? id : '?');
}

/** 'A —ASSUMES→ B', with the page of the item that states the edge. */
function edgeRows(edges, nameOf) {
  return listOf(edges).map((raw) => {
    const edge = recordOf(raw);
    const page = numberOrNull(recordOf(edge.stated_by).page);
    return { text: `${nameOf(edge.from)} —${stringOf(edge.kind)}→ ${nameOf(edge.to)}`, meta: page === null ? '' : 'page ' + page };
  });
}

/** An item that mentions a concept: the words it used, and where. */
function itemRows(items) {
  return listOf(items).map((raw) => {
    const item = recordOf(raw);
    return { text: stringOf(item.wording), meta: joined(pageLabel(item), stringOf(item.kind)) };
  });
}

function readConcept(result) {
  if (typeof result.concept_id !== 'string' || typeof result.name !== 'string') return readConceptNodes(result);
  const documents = listOf(result.documents).map((raw) => {
    const document = recordOf(raw);
    return { text: stringOf(document.title), meta: counted(document.mentions, 'mention') };
  });
  const blocks = [
    lead(result.name),
    facts([
      ['Definition', orNull(result.definition)],
      ['Aliases', stringsOf(result.aliases).join(', ')],
      ['Mentions', numeral(result.mentions)],
    ]),
    list('Documents', documents),
    list('Top items', itemRows(result.top_items)),
  ];
  return cardOfBlocks(counted(result.mentions, 'mention') || 'concept', 'quiet', blocks);
}

/** With no argument, `concept` lists the most mentioned concepts, each as a node to open. */
function readConceptNodes(result) {
  if (result.concept_id !== undefined || !Array.isArray(result.nodes)) return null;
  const rows = result.nodes.map(recordOf).filter((node) => node.kind === 'discover' && typeof node.label === 'string').map((node) => ({ text: node.label, meta: '' }));
  return cardOfBlocks(count(rows.length, 'concept'), 'quiet', [list('Concepts', rows, 'No concepts are stored yet.')]);
}

function readNeighbours(result) {
  if (typeof result.concept_id !== 'string' || !Array.isArray(result.edges)) return null;
  const nameOf = namer(result.concepts);
  const cut = result.truncated === true;
  const blocks = [
    lead(nameOf(result.concept_id)),
    list(null, edgeRows(result.edges, nameOf), 'No relations are stored for this concept.'),
    cut ? note('There are more relations than this shows.') : null,
  ];
  return cardOfBlocks(joined(count(result.edges.length, 'edge'), cut ? CUT_SHORT : ''), 'quiet', blocks);
}

function readPath(result) {
  if (!isRecord(result.from) || !isRecord(result.to) || !Array.isArray(result.edges)) return null;
  const nameOf = namer(result.concepts, [result.from, result.to]);
  const header = lead(nameOf(result.from.concept_id) + ' → ' + nameOf(result.to.concept_id));
  if (result.edges.length === 0) return cardOfBlocks('no chain', 'quiet', [header, note('No chain links these two concepts.')]);
  return cardOfBlocks(count(result.edges.length, 'edge'), 'quiet', [header, list(null, edgeRows(result.edges, nameOf))]);
}

function readConceptItems(result) {
  if (!Array.isArray(result.items)) return null;
  const more = orNull(result.next_cursor) ? note('More items follow. Ask again with the next cursor.') : null;
  return cardOfBlocks(count(result.items.length, 'item'), 'quiet', [list(null, itemRows(result.items), 'No item mentions this concept.'), more]);
}

function readCompare(result) {
  if (!Array.isArray(result.documents) || !Array.isArray(result.shared) || !isRecord(result.only_in)) return null;
  const documents = result.documents.map(recordOf).map((document) => ({ id: stringOf(document.document_id), title: stringOf(document.title) }));
  const shared = result.shared.map((raw) => {
    const concept = recordOf(raw);
    const mentions = recordOf(concept.mentions);
    const where = documents.filter(({ id }) => numberOrNull(mentions[id]) !== null).map(({ id, title }) => `${title}: ${mentions[id]}`);
    return { text: stringOf(concept.name), meta: where.join(' · ') };
  });
  const only = documents.map(({ id, title }) => {
    const rows = listOf(result.only_in[id]).map(recordOf).map((concept) => ({ text: stringOf(concept.name), meta: counted(concept.mentions, 'mention') }));
    return list('Only in ' + title, rows, 'Nothing is only here.');
  });
  const cut = result.truncated === true;
  const blocks = [list('Shared', shared, 'No concept is shared.'), ...only, cut ? note('The lists were cut short.') : null];
  return cardOfBlocks(joined(shared.length + ' shared', cut ? CUT_SHORT : ''), 'quiet', blocks);
}

const scoreWords = (score) => (numberOrNull(score) === null ? '' : 'score ' + score.toFixed(2));

function readFound(result) {
  if (!Array.isArray(result.concepts)) return null;
  const rows = result.concepts.map((raw) => {
    const concept = recordOf(raw);
    return {
      text: stringOf(concept.name),
      meta: joined(counted(concept.mentions, 'mention'), counted(concept.documents, 'document'), scoreWords(concept.score)),
      detail: stringOf(concept.definition),
    };
  });
  return cardOfBlocks(count(rows.length, 'concept'), 'quiet', [list(null, rows, 'No concept matched.')]);
}

function readSimilar(result) {
  if (!Array.isArray(result.items)) return null;
  const rows = result.items.map((raw) => {
    const item = recordOf(raw);
    return { text: stringOf(item.document), meta: joined(pageLabel(item), stringOf(item.kind), orNull(item.label), scoreWords(item.score)) };
  });
  return cardOfBlocks(count(rows.length, 'item'), 'quiet', [list(null, rows, 'Nothing similar was found.')]);
}

export const CONCEPT_READERS = {
  concept: readConcept,
  concept_neighbours: readNeighbours,
  concept_path: readPath,
  concept_items: readConceptItems,
  compare_documents: readCompare,
  find_concepts: readFound,
  similar_items: readSimilar,
};
