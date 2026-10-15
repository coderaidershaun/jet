// The one part of the chart area that deals with the store, the pointer, resizing and paint timing,
// so the rest of the area stays plain maths and drawing.

import { h } from '../../chat/dom.js';
import { createSegmented } from '../controls/segmented.js';
import { linkStylesheet, whenStyled } from '../controls/stylesheet.js';
import { writeAttribute, writeText } from '../controls/write.js';
import { STRIP_HEIGHT, fractionAt, legibleTickCeiling, stackLayout } from './layout.js';
import { createChartModel } from './model.js';
import { fitCanvas, paintCrosshair, paintMid, paintRisk, readLook } from './view.js';

const SECTIONS = ['hello', 'catalog', 'view', 'chart', 'risk'];

// A frame that comes a little early still counts, because animation frame times jitter.
const MIN_PAINT_GAP_MS = 1000 / 60 - 2;

/** Calls `onChange` each time the screen's pixel density changes, for instance on another monitor. */
function watchPixelDensity(onChange) {
  const listen = () => {
    const query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    query.addEventListener(
      'change',
      () => {
        onChange();
        listen();
      },
      { once: true },
    );
  };
  listen();
}

/** The rect moved up by `top`, into the coordinates of a canvas that starts there. */
const withinCanvas = (rect, top) => rect && { ...rect, top: rect.top - top, bottom: rect.bottom - top };

/**
 * Builds the area into `root`. Mount before the store starts, or the first frames are missed.
 * SMELL: nothing is torn down. That is fine while the page lives as long as the app, but a second
 * mount would leave the first one's listeners running.
 * @param {{ root: HTMLElement, store: { onFrame: Function, register: Function, send: Function } }} area
 */
export function mount({ root, store }) {
  const model = createChartModel();
  let layout = null;
  let width = 0;
  let height = 0;
  let dpr = devicePixelRatio;
  let pointerX = null;
  let scenes = { mid: model.mid, risk: model.risk };
  let sentCeilings = null;
  let isDataDirty = true;
  let isPointerDirty = false;
  let lastPaintMs = -Infinity;

  const trackPointer = (event) => {
    pointerX = event.clientX - stack.getBoundingClientRect().left;
    isPointerDirty = true;
  };
  const losePointer = () => {
    pointerX = null;
    isPointerDirty = true;
  };
  const pointerHandlers = { onPointerMove: trackPointer, onPointerLeave: losePointer };

  const midCanvas = h('canvas', { class: 'ws-chart-plot ws-chart-mid', role: 'img', 'aria-label': 'Mid price chart', ...pointerHandlers });
  const riskCanvas = h('canvas', { class: 'ws-chart-plot ws-chart-risk', role: 'img', 'aria-label': 'Risk chart', ...pointerHandlers });
  const crossCanvas = h('canvas', { class: 'ws-chart-cross', 'aria-hidden': 'true' });
  const latest = h('span', { class: 'ws-chart-latest' });
  const seriesToggle = createSegmented({
    label: 'Risk series',
    options: [['exposure', 'EXPOSURE'], ['pnl', 'PNL']],
    onPick: (series) => store.send({ cmd: 'risk_series', series }),
  });
  seriesToggle.show(model.riskSeries);
  const stack = h(
    'div',
    { class: 'ws-chart-stack' },
    midCanvas,
    h('div', { class: 'ws-chart-sub' }, seriesToggle.element, latest),
    riskCanvas,
    crossCanvas,
  );
  stack.style.setProperty('--ws-chart-strip', `${STRIP_HEIGHT}px`);
  const link = linkStylesheet(new URL('./chart.css', import.meta.url).href);
  root.append(stack);
  const look = readLook(stack);

  /** The bridge draws the axis for the label count we last asked for, so we ask again when it changes. */
  function sendCeilings() {
    const ceilingOf = (plot) => (plot === null ? 0 : legibleTickCeiling(plot.bottom - plot.top));
    const ceilings = { mid: ceilingOf(layout.mid), risk: ceilingOf(layout.risk) };
    if (sentCeilings?.mid === ceilings.mid && sentCeilings?.risk === ceilings.risk) return;
    sentCeilings = ceilings;
    store.send({ cmd: 'chart_ticks', ...ceilings });
  }

  function paintCharts() {
    scenes = { mid: model.mid, risk: model.risk };
    const midSize = { width, height: layout.split };
    const riskSize = { width, height: Math.max(0, height - layout.riskTop) };
    paintMid(fitCanvas(midCanvas, midSize, dpr), { plot: layout.mid, size: midSize, scene: scenes.mid, look, dpr });
    const riskPlot = withinCanvas(layout.risk, layout.riskTop);
    paintRisk(fitCanvas(riskCanvas, riskSize, dpr), { plot: riskPlot, size: riskSize, scene: scenes.risk, look, dpr });

    seriesToggle.show(model.riskSeries);
    const reading = scenes.risk.latest;
    writeText(latest, reading?.text ?? '');
    writeAttribute(latest, 'data-tone', reading?.tone ?? null);
  }

  function paintPointer() {
    const fraction = pointerX === null ? null : fractionAt(pointerX, layout);
    const context = fitCanvas(crossCanvas, { width, height }, dpr);
    paintCrosshair(context, { layout, crosshair: model.crosshair(fraction), scenes, look, dpr });
  }

  /** Called on every animation frame; paints only when something changed, and at most 60 times a second. */
  function paint(nowMs) {
    if (!isDataDirty && !isPointerDirty) return;
    if (layout === null || width === 0 || height === 0) return;
    if (nowMs - lastPaintMs < MIN_PAINT_GAP_MS) return;
    lastPaintMs = nowMs;
    if (isDataDirty) paintCharts();
    paintPointer();
    isDataDirty = false;
    isPointerDirty = false;
  }

  for (const name of SECTIONS) {
    store.onFrame(name, (value) => {
      model.apply(name, value);
      isDataDirty = true;
    });
  }

  const sizeWatcher = new ResizeObserver(([entry]) => {
    width = entry.contentRect.width;
    height = entry.contentRect.height;
    layout = stackLayout(width, height);
    stack.style.setProperty('--ws-chart-split', `${layout.split}px`);
    isDataDirty = true;
    // A hidden page reports no size; asking for no labels then would blank the axes on return.
    if (width > 0 && height > 0) sendCeilings();
  });
  // Until the stylesheet applies, a canvas shows at its backing size, which would make the stack grow.
  whenStyled(link, () => sizeWatcher.observe(stack));

  watchPixelDensity(() => {
    dpr = devicePixelRatio;
    isDataDirty = true;
  });
  store.register('chart', paint);
}
