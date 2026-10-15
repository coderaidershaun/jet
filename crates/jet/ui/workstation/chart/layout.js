// The charts, the pointer and the crosshair must agree to the pixel on where each plot sits, so
// the stack's geometry is worked out in one place. It draws nothing, so tests can check it.

const MID_SHARE = 0.7;
export const STRIP_HEIGHT = 30;
const PLOT_PAD = 10;
const AXIS_GUTTER = 72;
const PILL_OFFSET = 8;
const PILL_PAD_X = 6;
const PILL_PAD_Y = 3;

export const AXIS_FONT_PX = 11;
const LABEL_PITCH = 2;
const MINIMUM_LABEL_PITCH = 1.2;
const MINIMUM_TICKS = 5;

/**
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Rect
 * @typedef {{ width: number, height: number, split: number, riskTop: number, mid: Rect | null, risk: Rect | null }} StackLayout
 */

/** The plot inside a chart that spans `top` to `bottom`; null when the padding and gutter leave no room. */
function plotRect(width, top, bottom) {
  const plot = { left: PLOT_PAD, top: top + PLOT_PAD, right: width - PLOT_PAD - AXIS_GUTTER, bottom: bottom - PLOT_PAD };
  return plot.right > plot.left && plot.bottom > plot.top ? plot : null;
}

/**
 * The mid chart takes 70% of the stack, a 30 px strip follows, and the risk chart gets the rest.
 * Rects are in stack coordinates; both plots have the same left and right.
 * @param {number} width
 * @param {number} height
 * @returns {StackLayout}
 */
export function stackLayout(width, height) {
  const split = Math.round(height * MID_SHARE);
  const riskTop = split + STRIP_HEIGHT;
  return { width, height, split, riskTop, mid: plotRect(width, 0, split), risk: plotRect(width, riskTop, height) };
}

/**
 * How far across the plots an x position is, 0 at the left edge and 1 at the right. Not clamped, so a
 * pointer in the gutter reads above 1. Null when no plot has room.
 * @param {number} x in stack coordinates
 * @param {StackLayout} layout
 */
export function fractionAt(x, layout) {
  const plot = layout.mid ?? layout.risk;
  return plot === null ? null : (x - plot.left) / (plot.right - plot.left);
}

/** Like the desktop app's cast to an unsigned count: a negative or NaN value becomes 0. */
const asCount = (value) => Math.max(0, Math.trunc(value)) || 0;

/**
 * How many axis labels fit in a plot this tall. Each step is rounded to single precision because
 * the desktop app this copies works that way: at 66 px it finds just under 5 label slots and
 * draws no labels, where double precision finds exactly 5 and would draw 3.
 * @param {number} height plot height in CSS px
 */
export function legibleTickCeiling(height) {
  const single = Math.fround;
  const ideal = single(single(AXIS_FONT_PX) * single(LABEL_PITCH));
  const minimum = single(single(AXIS_FONT_PX) * single(MINIMUM_LABEL_PITCH));
  const tall = single(height);
  if (asCount(single(tall / minimum)) < MINIMUM_TICKS) return 0;
  return asCount(single(tall / ideal));
}

/**
 * The axis entries to draw. The frame's entries were made for the ceiling the page sent last, so a
 * plot that has since shrunk below the legible height must not show them.
 * @param {Array<{ v: number, label: string }> | null | undefined} axis
 * @param {number} plotHeight
 */
export function axisEntries(axis, plotHeight) {
  return legibleTickCeiling(plotHeight) === 0 ? [] : (axis ?? []);
}

/**
 * Where a value pill goes: a little right of the crosshair, centred on the anchor's height, and
 * pushed back inside the stack when it would stick out.
 * @param {{ anchorX: number, anchorY: number, textWidth: number, textHeight: number, layout: StackLayout }} pill
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function pillRect({ anchorX, anchorY, textWidth, textHeight, layout }) {
  const width = textWidth + 2 * PILL_PAD_X;
  const height = textHeight + 2 * PILL_PAD_Y;
  let x = anchorX + PILL_OFFSET;
  let y = anchorY - textHeight / 2;
  if (x + width > layout.width) x = layout.width - width;
  if (y + height > layout.height) y = layout.height - height;
  return { x: Math.max(x, 0), y: Math.max(y, 0), width, height };
}
