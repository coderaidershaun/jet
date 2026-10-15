// Builds the strip above the left panel and keeps it in step with the bridge: the way back to the
// chat, the instrument and chart mode choices, the strategy name and the execution badge.

import { h } from '../../chat/dom.js';
import { createSegmented } from '../controls/segmented.js';
import { linkStylesheet } from '../controls/stylesheet.js';
import { writeAttribute, writeText } from '../controls/write.js';
import { MISSING, toolbarModel } from './model.js';

/**
 * Builds the toolbar into `root`.
 * SMELL: nothing is torn down, so a second mount would leave the first one's listeners and painter running.
 * @param {{ root: HTMLElement, store: { onFrame: Function, register: Function, latest: Function, send: Function, leave: Function } }} area
 */
export function mount({ root, store }) {
  linkStylesheet(new URL('./toolbar.css', import.meta.url).href);
  let catalog = store.latest('catalog');
  let view = store.latest('view');
  let isDirty = true;
  let shownInstruments = '';

  // Without this blank choice the browser would show the first instrument before the bridge has picked one.
  const placeholder = h('option', { value: '', disabled: true, hidden: true }, MISSING);
  const select = h('select', {
    'aria-label': 'Instrument',
    disabled: true,
    onChange: () => store.send({ cmd: 'select', instrument: Number(select.value) }),
  }, placeholder);
  const chartMode = createSegmented({
    label: 'Chart mode',
    options: [['line', 'Line'], ['candles', 'Candles']],
    onPick: (mode) => store.send({ cmd: 'chart_mode', mode }),
  });
  const strategy = h('span', { class: 'ws-strategy' });
  const badge = h('span', { class: 'ws-badge' });

  root.append(
    h('div', { class: 'ws-tools' },
      h('button', { type: 'button', class: 'ws-esc', 'aria-label': 'Esc, back to the chat', onClick: () => store.leave() }, 'Esc'),
      h('label', { class: 'ws-instrument' }, select),
      h('div', { class: 'ws-tool-mode' }, chartMode.element),
      strategy,
      badge,
    ),
  );

  store.onFrame('catalog', (line) => {
    catalog = line;
    isDirty = true;
  });
  store.onFrame('view', (section) => {
    view = section;
    isDirty = true;
  });

  /** The options are rebuilt only when the list changed, because rebuilding closes an open menu. */
  function showInstruments({ instruments, instrumentId }) {
    const key = JSON.stringify(instruments);
    if (key !== shownInstruments) {
      shownInstruments = key;
      select.replaceChildren(placeholder, ...instruments.map(({ id, display }) => h('option', { value: String(id) }, display)));
    }
    select.disabled = instruments.length === 0;
    select.value = instruments.some(({ id }) => id === instrumentId) ? String(instrumentId) : '';
  }

  /** Called on every animation frame; changes the page only when a frame brought something new. */
  function paint() {
    if (!isDirty) return;
    isDirty = false;
    const toolbar = toolbarModel({ catalog, view });
    showInstruments(toolbar);
    chartMode.show(toolbar.chartMode);
    writeText(strategy, toolbar.strategyId);
    writeText(badge, toolbar.badge.text);
    writeAttribute(badge, 'data-fill', toolbar.badge.fill);
    writeAttribute(badge, 'data-ink', toolbar.badge.ink);
  }

  store.register('toolbar', paint);
}
