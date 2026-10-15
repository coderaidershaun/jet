// Runs the chart area alone on a made-up bridge, so it can be worked on and screenshotted without the
// engine or the rest of the workstation. `?mode=candles` and `?series=pnl` set the first view, and
// `?hover=0.6` puts the pointer over the mid chart.

import { createFrameStore } from '../store.js';
import { createDevFeed, mulberry32 } from './dev-feed.js';
import { mount } from './mount.js';

const params = new URLSearchParams(location.search);
const view = {
  chartMode: params.get('mode') === 'candles' ? 'candles' : 'line',
  riskSeries: params.get('series') === 'pnl' ? 'pnl' : 'exposure',
};
const frames = createFrameStore();
const feed = createDevFeed({ nowMs: Date.now, random: mulberry32(2026), onLine: (line) => frames.accept(line), view });
const store = {
  onFrame: frames.onFrame,
  register: frames.register,
  latest: frames.latest,
  send: (command) => feed.command(command),
  leave() {},
};

const root = document.getElementById('ws-charts');
mount({ root, store });
feed.start();

const paintFrame = (nowMs) => {
  frames.paint(nowMs);
  requestAnimationFrame(paintFrame);
};
requestAnimationFrame(paintFrame);

for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('click', () => {
    const name = button.dataset.command;
    store.send(name === 'resync' ? { cmd: 'resync' } : { cmd: 'chart_mode', mode: name });
  });
}

/** A real pointer event, so the screenshot shows the crosshair the way a mouse would. */
function hover(fraction) {
  const stack = root.querySelector('.ws-chart-stack').getBoundingClientRect();
  const canvas = root.querySelector('.ws-chart-mid').getBoundingClientRect();
  const init = { clientX: stack.left + stack.width * fraction, clientY: canvas.top + canvas.height / 2, bubbles: true };
  root.querySelector('.ws-chart-mid').dispatchEvent(new PointerEvent('pointermove', init));
}

if (params.has('hover')) requestAnimationFrame(() => requestAnimationFrame(() => hover(Number(params.get('hover')))));
