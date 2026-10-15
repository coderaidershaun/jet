// The only code that draws on the chart canvases. It is given numbers already worked out, so the
// maths that decides what to draw can be tested without a browser.

import { AXIS_FONT_PX, axisEntries, pillRect } from './layout.js';
import { candleColour, lerp, xFraction, yFraction } from './model.js';

const LINE_WIDTH = 1.25;
const WICK_WIDTH = 1;
const MARKER_RADIUS = 3;
const MARKER_OUTLINE = 1;
const TICK_LENGTH = 10;
const CAPTION_FONT_PX = 10;
const NOTE_FONT_PX = 13;
const PILL_TEXT_HEIGHT = 13;
const PILL_RADIUS = 3;
const TIME_BOTTOM_MARGIN = 3;

const COLOUR_TOKENS = {
  canvas: '--ws-canvas',
  panel: '--ws-panel',
  panelRaised: '--ws-panel-raised',
  border: '--ws-border',
  grid: '--ws-grid',
  text: '--ws-text',
  text2: '--ws-text-2',
  bid: '--ws-bid',
  ask: '--ws-ask',
  sellFill: '--ws-sell-fill',
  selected: '--ws-selected',
};

/**
 * @typedef {{ colours: Record<keyof typeof COLOUR_TOKENS, string>, mono: string, font: string }} Look
 * @typedef {import('./layout.js').Rect} Rect
 */

/**
 * Reads the colours and fonts from the page's tokens. The element must already be in the document,
 * or every token reads as empty.
 * @param {Element} element
 * @returns {Look}
 */
export function readLook(element) {
  const style = getComputedStyle(element);
  const token = (name) => style.getPropertyValue(name).trim();
  const colours = Object.fromEntries(Object.entries(COLOUR_TOKENS).map(([key, name]) => [key, token(name)]));
  return {
    colours,
    mono: token('--mono') || 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    font: token('--font') || '-apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif',
  };
}

/**
 * Sizes a canvas for the screen and returns its context, drawing in CSS pixels. The canvas is only
 * resized when the size changed, because resizing wipes it.
 * @param {HTMLCanvasElement} canvas
 * @param {{ width: number, height: number }} size in CSS px
 * @param {number} dpr
 */
export function fitCanvas(canvas, { width, height }, dpr) {
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return context;
}

/** Moves a coordinate to the middle of the device pixel it falls in, so a thin line stays sharp. */
const crisp = (value, dpr) => (Math.round(value * dpr - 0.5) + 0.5) / dpr;

function scaleOf(plot, domain, bounds) {
  return {
    x: (index) => lerp(plot.left, plot.right, xFraction(index, domain)),
    y: (value) => lerp(plot.bottom, plot.top, yFraction(value, bounds)),
  };
}

function hairlines(ctx, colour, dpr, segments) {
  ctx.beginPath();
  for (const [x0, y0, x1, y1] of segments) {
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  }
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1 / dpr;
  ctx.stroke();
}

function fillBackground(ctx, size, look) {
  ctx.fillStyle = look.colours.panel;
  ctx.fillRect(0, 0, size.width, size.height);
}

function paintNote(ctx, plot, note, look) {
  ctx.font = `${NOTE_FONT_PX}px ${look.font}`;
  ctx.fillStyle = look.colours.text2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(note, (plot.left + plot.right) / 2, (plot.top + plot.bottom) / 2);
}

/** A run of one point is a dot, so a lone bucket between two holes is still seen. */
function strokeRuns(ctx, points, locate, look) {
  const colour = look.colours.selected;
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineJoin = 'miter';
  ctx.miterLimit = Math.SQRT2;
  ctx.lineCap = 'butt';
  let run = [];
  const flush = () => {
    if (run.length === 1) {
      ctx.beginPath();
      ctx.arc(run[0].x, run[0].y, LINE_WIDTH, 0, 2 * Math.PI);
      ctx.fill();
    } else if (run.length > 1) {
      ctx.beginPath();
      ctx.moveTo(run[0].x, run[0].y);
      for (const point of run.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    run = [];
  };
  for (const point of points) {
    if (point.isRunStart) flush();
    run.push(locate(point.item));
  }
  flush();
}

function paintCandles(ctx, { plot, scene, scale, dpr, look }) {
  const { domain, points } = scene;
  const slot = (plot.right - plot.left) / (domain.last - domain.first + 1);
  const bodyWidth = Math.max(slot - 1, 1, 1 / dpr);
  const breaks = [];
  const byColour = { bid: [], ask: [], text2: [] };
  points.forEach(({ item, isRunStart }, position) => {
    const x = scale.x(item.i);
    if (isRunStart && position > 0) {
      const edge = crisp(x - slot / 2, dpr);
      breaks.push([edge, plot.top, edge, plot.bottom]);
    }
    byColour[candleColour(item)].push({ item, x });
  });

  hairlines(ctx, look.colours.border, dpr, breaks);
  ctx.lineWidth = WICK_WIDTH;
  for (const [name, candles] of Object.entries(byColour)) {
    ctx.beginPath();
    for (const { item, x } of candles) {
      const wickX = crisp(x, dpr);
      ctx.moveTo(wickX, scale.y(item.h));
      ctx.lineTo(wickX, scale.y(item.l));
    }
    ctx.strokeStyle = look.colours[name];
    ctx.stroke();
  }
  for (const [name, candles] of Object.entries(byColour)) {
    ctx.beginPath();
    for (const { item, x } of candles) {
      const top = scale.y(Math.max(item.o, item.c));
      const bottom = Math.max(scale.y(Math.min(item.o, item.c)), top + 1 / dpr);
      ctx.rect(x - bodyWidth / 2, top, bodyWidth, bottom - top);
    }
    ctx.fillStyle = look.colours[name];
    ctx.fill();
  }
}

function paintFills(ctx, { plot, scene, scale, look }) {
  ctx.lineWidth = MARKER_OUTLINE;
  ctx.strokeStyle = look.colours.canvas;
  for (const fill of scene.fills) {
    ctx.beginPath();
    ctx.arc(scale.x(fill.i), scale.y(fill.ht), MARKER_RADIUS, 0, 2 * Math.PI);
    ctx.fillStyle = fill.side === 'buy' ? look.colours.bid : look.colours.sellFill;
    ctx.fill();
    ctx.stroke();
  }
  if (!scene.hasCaption) return;
  ctx.font = `${CAPTION_FONT_PX}px ${look.font}`;
  ctx.fillStyle = look.colours.text2;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('fills', plot.left, plot.bottom);
}

function paintAxis(ctx, { plot, scene, scale, dpr, look }) {
  const entries = axisEntries(scene.axis, plot.bottom - plot.top);
  const ticks = entries.map(({ v }) => {
    const y = crisp(scale.y(v), dpr);
    return [plot.right, y, plot.right + TICK_LENGTH, y];
  });
  hairlines(ctx, look.colours.grid, dpr, ticks);
  ctx.font = `${AXIS_FONT_PX}px ${look.mono}`;
  ctx.fillStyle = look.colours.text2;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const { v, label } of entries) ctx.fillText(label, plot.right + TICK_LENGTH, scale.y(v));
}

/**
 * Paints the mid chart: the line or the candles, the fills with their caption, and the price axis.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ plot: Rect | null, size: { width: number, height: number }, scene: import('./model.js').MidScene,
 *   look: Look, dpr: number }} options `plot` is in this canvas's own coordinates
 */
export function paintMid(ctx, { plot, size, scene, look, dpr }) {
  fillBackground(ctx, size, look);
  if (plot === null) return;
  if (scene.note) return paintNote(ctx, plot, scene.note, look);
  if (!scene.isPlottable) return;

  const scale = scaleOf(plot, scene.domain, scene.bounds);
  const parts = { plot, scene, scale, dpr, look };
  if (scene.mode === 'candles') paintCandles(ctx, parts);
  else strokeRuns(ctx, scene.points, (bucket) => ({ x: scale.x(bucket.i), y: scale.y(bucket.c) }), look);
  // The fills go after the series, so a marker is never hidden under a candle.
  paintFills(ctx, parts);
  paintAxis(ctx, parts);
}

/**
 * Paints the risk chart: the zero baseline, the exposure or PnL line and its axis.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ plot: Rect | null, size: { width: number, height: number }, scene: import('./model.js').RiskScene,
 *   look: Look, dpr: number }} options `plot` is in this canvas's own coordinates
 */
export function paintRisk(ctx, { plot, size, scene, look, dpr }) {
  fillBackground(ctx, size, look);
  if (plot === null) return;
  if (scene.note) return paintNote(ctx, plot, scene.note, look);
  if (!scene.isPlottable) return;

  const scale = scaleOf(plot, scene.domain, scene.bounds);
  const zero = crisp(scale.y(0), dpr);
  hairlines(ctx, look.colours.grid, dpr, [[plot.left, zero, plot.right, zero]]);
  strokeRuns(ctx, scene.points, (point) => ({ x: scale.x(point.i), y: scale.y(point.v) }), look);
  paintAxis(ctx, { plot, scene, scale, dpr, look });
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function paintPill(ctx, { text, anchorX, anchorY, layout, look }) {
  ctx.font = `${AXIS_FONT_PX}px ${look.mono}`;
  const textWidth = ctx.measureText(text).width;
  const { x, y, width, height } = pillRect({ anchorX, anchorY, textWidth, textHeight: PILL_TEXT_HEIGHT, layout });
  roundedRectPath(ctx, x, y, width, height, PILL_RADIUS);
  ctx.fillStyle = look.colours.panelRaised;
  ctx.fill();
  roundedRectPath(ctx, x + 0.5, y + 0.5, width - 1, height - 1, PILL_RADIUS - 0.5);
  ctx.strokeStyle = look.colours.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = look.colours.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + width / 2, y + height / 2);
}

/**
 * Paints the hover crosshair over the whole stack: a hairline through both plots, a value pill on
 * each line, and the time at the bottom. Draws nothing when no plot is showing data.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ layout: import('./layout.js').StackLayout, crosshair: import('./model.js').Crosshair | null,
 *   scenes: { mid: import('./model.js').MidScene, risk: import('./model.js').RiskScene }, look: Look, dpr: number }} options
 */
export function paintCrosshair(ctx, { layout, crosshair, scenes, look, dpr }) {
  ctx.clearRect(0, 0, layout.width, layout.height);
  if (crosshair === null) return;
  const mid = layout.mid !== null && scenes.mid.isPlottable ? { plot: layout.mid, scene: scenes.mid } : null;
  const risk = layout.risk !== null && scenes.risk.isPlottable ? { plot: layout.risk, scene: scenes.risk } : null;
  const shown = [mid, risk].filter((entry) => entry !== null);
  if (shown.length === 0) return;

  const x = scaleOf(shown[0].plot, shown[0].scene.domain, shown[0].scene.bounds).x(crosshair.index);
  const lineX = crisp(x, dpr);
  const top = Math.min(...shown.map(({ plot }) => plot.top));
  const bottom = Math.max(...shown.map(({ plot }) => plot.bottom));
  hairlines(ctx, look.colours.grid, dpr, [[lineX, top, lineX, bottom]]);

  const pills = [
    { entry: mid, value: crosshair.midClose, text: crosshair.midText },
    { entry: risk, value: crosshair.riskValue, text: crosshair.riskText },
  ];
  for (const { entry, value, text } of pills) {
    if (entry === null || text === null || value === null) continue;
    const { y } = scaleOf(entry.plot, entry.scene.domain, entry.scene.bounds);
    paintPill(ctx, { text, anchorX: x, anchorY: y(value), layout, look });
  }

  if (crosshair.timeText === null) return;
  ctx.font = `${AXIS_FONT_PX}px ${look.mono}`;
  ctx.fillStyle = look.colours.text2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(crosshair.timeText, layout.width / 2, layout.height - TIME_BOTTOM_MARGIN);
}
