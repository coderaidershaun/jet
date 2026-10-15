// How "[n]" in Jet's text finds its source: the text is split at each citation,
// and a number is matched to the nearest card above it that holds that source.
// Pure, with no DOM.

import { callState, sourceTitle } from './model.js';

const CITATION = /\[(\d{1,3})\]/g;

/** 'see [2][3].' becomes ['see ', 2, 3, '.']. Only 1 to 3 digits count, and 0 is not a citation. */
export function splitCitations(text) {
  const parts = [];
  const addText = (more) => {
    if (more === '') return;
    if (typeof parts.at(-1) === 'string') parts[parts.length - 1] += more;
    else parts.push(more);
  };
  let from = 0;
  for (const match of text.matchAll(CITATION)) {
    const number = Number(match[1]);
    addText(text.slice(from, match.index));
    if (number === 0) addText(match[0]);
    else parts.push(number);
    from = match.index + match[0].length;
  }
  addText(text.slice(from));
  return parts;
}

/** The sources a finished search or answer holds. A page's pieces are numbered too, but they are not sources. */
function sourcesOf(call) {
  if (call.server !== 'quanty' || callState(call) !== 'done' || typeof call.result !== 'object' || call.result === null) return [];
  const held = call.tool === 'search' ? call.result.results : call.tool === 'answer' ? call.result.sources : [];
  return Array.isArray(held) ? held : [];
}

/**
 * The nearest card above that holds source n: the last call in `calls` with it.
 * @param {import('./model.js').ShownCall[]} calls   oldest first
 * @returns {{ callId: string, item: any, title: string } | null}
 */
export function findSource(calls, n) {
  for (const call of calls.toReversed()) {
    const item = sourcesOf(call).find((source) => source && source.number === n);
    if (item) return { callId: call.id, item, title: sourceTitle(item) };
  }
  return null;
}
