// Draws the latency table between the toolbar and the charts, and keeps its numbers in step with the
// bridge. The page only lays out the text the bridge sends.

import { h } from '../../dom.js';
import { linkStylesheet } from '../controls/stylesheet.js';
import { writeAttribute, writeText } from '../controls/write.js';
import { latencyGrid } from './model.js';

const classes = (...names) => names.filter(Boolean).join(' ');

/**
 * Builds the table into `root`.
 * SMELL: nothing is torn down, so a second mount would leave the first one's listener and painter running.
 * @param {{ root: HTMLElement, store: { onFrame: Function, register: Function, latest: Function } }} area
 */
export function mount({ root, store }) {
  linkStylesheet(new URL('./latency.css', import.meta.url).href);
  let section = store.latest('latency');
  let isDirty = true;
  let shape = '';
  /** The cell elements of the current shape, by row and then by column. */
  let cells = [];
  const grid = h('div', { class: 'ws-latency' });
  root.append(grid);

  store.onFrame('latency', (value) => {
    section = value;
    isDirty = true;
  });

  /** Makes the table's elements. `paint` then writes only the values, so new numbers never rebuild it. */
  function build({ header, columns, rows }) {
    const head = columns.map(({ text, isSlots }) => h('div', { class: classes('ws-lat-head', isSlots && 'ws-lat-slots') }, text));
    cells = rows.map(({ cells: rowCells }, row) =>
      rowCells.map(({ isSlots }) => h('div', { class: classes('ws-lat-cell', isSlots && 'ws-lat-slots', row > 0 && 'ws-lat-later') })),
    );
    const lines = rows.map(({ label }, row) => [h('div', { class: classes('ws-lat-label', row > 0 && 'ws-lat-later') }, label), ...cells[row]]);
    grid.style.setProperty('--ws-lat-columns', String(columns.length));
    const title = columns.length > 0 || header !== '' ? [h('div', { class: 'ws-lat-title' }, header)] : [];
    grid.replaceChildren(...title, ...head, ...lines.flat());
  }

  /** Called on every animation frame; changes the page only when a frame brought something new. */
  function paint() {
    if (!isDirty) return;
    isDirty = false;
    const latency = latencyGrid(section);
    const key = JSON.stringify([latency.header, latency.columns, latency.rows.map(({ label }) => label)]);
    if (key !== shape) {
      shape = key;
      build(latency);
    }
    latency.rows.forEach(({ cells: rowCells }, row) =>
      rowCells.forEach(({ text, tone }, column) => {
        writeText(cells[row][column], text);
        writeAttribute(cells[row][column], 'data-tone', tone);
      }),
    );
  }

  store.register('latency', paint);
}
