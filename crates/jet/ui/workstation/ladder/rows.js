// The ladder body's rules, with no DOM: how many rows fit, how big the text is, which row the
// pointer is over, what the cells and the readout say. All sizes are CSS pixels.

/** Rows per side the ladder can hold. */
export const MAX_ROWS = 30;
/** The middle band's share of the body's height. */
export const SEPARATOR_SHARE = 0.08;
const ROW_FLOOR_PX = 8.5;
const REFERENCE_ROW_PX = 18;
const CELL_FONT_PX = 13;
const TAG_FONT_PX = 9;
const MIN_FONT_PX = 7;
const MIN_GRID_FADE = 0.35;
const CHEVRON_MIN_PX = 16;
const CHEVRON_MAX_PX = 22;
const POINTER_GAP_PX = 8;
const MISSING = '--';

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** The height of the asks, or of the bids: what is left beside the centred separator. */
const sideHeight = (bodyHeight) => (Math.max(0, bodyHeight) * (1 - SEPARATOR_SHARE)) / 2;

/** How many rows each side can show without a row shrinking below the legible floor. */
export function rowsThatFit(bodyHeight) {
  if (bodyHeight <= 0) return 0;
  return Math.min(Math.floor(sideHeight(bodyHeight) / ROW_FLOOR_PX), MAX_ROWS);
}

/**
 * The sizes that follow from the body's height and the number of rows shown. `tagFont` is null
 * when the tags would be too small to read; the colour and the ring still carry the status.
 */
export function rowGeometry(bodyHeight, rows) {
  const side = sideHeight(bodyHeight);
  const rowHeight = rows > 0 ? side / rows : side;
  const scale = Math.min(rowHeight / REFERENCE_ROW_PX, 1);
  const tagFont = TAG_FONT_PX * scale;
  return {
    rowHeight,
    scale,
    cellFont: Math.max(CELL_FONT_PX * scale, MIN_FONT_PX),
    tagFont: tagFont >= MIN_FONT_PX ? tagFont : null,
    gridFade: Math.max(scale, MIN_GRID_FADE),
    chevronHeight: clamp(rowHeight, CHEVRON_MIN_PX, CHEVRON_MAX_PX),
  };
}

/**
 * What the strategy cell of a row shows. A real order is shown before the wanted quote, and the
 * two are never merged.
 * @param {import('../../bridge/workstation.js').LadderRow | undefined} row
 * @returns {{ qty: string, word: string, tone: string } | null}
 */
export function strategyCell(row) {
  if (row?.order) return { qty: row.order.qty, word: row.order.word, tone: row.order.tone };
  if (row?.want) return { qty: row.want, word: 'want', tone: 'want' };
  return null;
}

/**
 * Which row the pointer is over. `y` is measured from the top of the body. The asks stack up from
 * the separator and the bids down from it; the separator itself and anything past the last row hit nothing.
 * @returns {{ side: 'ask' | 'bid', index: number } | null}
 */
export function hoveredRow({ y, height, rows }) {
  if (rows <= 0 || y < 0 || y >= height) return null;
  const separatorTop = sideHeight(height);
  const separatorBottom = height - separatorTop;
  if (y >= separatorTop && y <= separatorBottom) return null;
  const rowHeight = separatorTop / rows;
  const side = y < separatorTop ? 'ask' : 'bid';
  const index = Math.floor((side === 'ask' ? separatorTop - y : y - separatorBottom) / rowHeight);
  return index < rows ? { side, index } : null;
}

/** The four lines of the hover readout, their labels padded to six characters. */
export function readoutLines(row) {
  const order = row.order ? row.order.qty + '  ' + row.order.word : MISSING;
  return ['px    ' + row.price, 'pub   ' + (row.public ?? MISSING), 'order ' + order, 'want  ' + (row.want ?? MISSING)];
}

/** Where the readout box goes: just below and right of the pointer, pulled back inside the bounds. */
export function readoutPosition({ x, y }, { width, height }, bounds) {
  return {
    left: Math.max(0, Math.min(x + POINTER_GAP_PX, bounds.width - width)),
    top: Math.max(0, Math.min(y + POINTER_GAP_PX, bounds.height - height)),
  };
}

/** The text of the chevron for a quote above the asks and for one below the bids; null = none. */
export function chevronsOf(ladder) {
  return { up: ladder?.chevrons?.up?.text ?? null, down: ladder?.chevrons?.down?.text ?? null };
}
