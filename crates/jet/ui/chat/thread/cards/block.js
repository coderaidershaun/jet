// The small set of blocks that the research cards are made of, so the page draws one kind of body for
// all of them. A reader says what to show, and the view says how. Pure, with no DOM.

/**
 * @typedef {{ text: string, meta: string, detail?: string }} Row
 * @typedef {{ type: 'lead', text: string }
 *   | { type: 'facts', fields: import('./model.js').Field[] }
 *   | { type: 'list', heading: string | null, rows: Row[], empty: string | null }
 *   | { type: 'outline', rows: (Row & { depth: number })[] }
 *   | { type: 'show', crumb: string | null, kind: string, show: import('./model.js').Show }
 *   | { type: 'note', text: string }
 *   | { type: 'part', heading: string, meta: string, blocks: Block[] }} Block
 */

/** The word a card's summary adds when the result was cut short. */
export const CUT_SHORT = 'cut short';

/** One line that says what the card is about. */
export const lead = (text) => (text ? { type: 'lead', text } : null);

/** Term and text pairs, as the fields of a result. A pair with no text is left out, and so is a list with none. */
export function facts(entries) {
  const fields = entries.filter(([, text]) => text).map(([term, text]) => ({ term, text }));
  return fields.length > 0 ? { type: 'facts', fields } : null;
}

/** A list of rows. With no rows it shows `empty` when there is one, else nothing. */
export const list = (heading, rows, empty = null) => (rows.length > 0 || empty ? { type: 'list', heading, rows, empty } : null);

/** A list whose rows sit at a depth, from 0. */
export const outline = (rows) => (rows.length > 0 ? { type: 'outline', rows } : null);

/** A muted line, for what was cut short and for what is empty. */
export const note = (text) => ({ type: 'note', text });

export const show = (shown, kind = '', crumb = null) => ({ type: 'show', crumb, kind, show: shown });

/** A result inside a result, with its own heading and words. */
export const part = (heading, meta, blocks) => ({ type: 'part', heading, meta, blocks: blocks.filter(Boolean) });

/** The reader's answer for a card whose body is these blocks. */
export function cardOfBlocks(outcome, tone, blocks) {
  return { outcome, tone, body: { kind: 'blocks', blocks: blocks.filter(Boolean) } };
}
