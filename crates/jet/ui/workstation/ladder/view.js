// The ladder's body: 30 rows a side, built once and patched in place, and the overlays on them.
// Every write checks first, so a frame that changes nothing touches nothing.

import { h } from '../../chat/dom.js';
import { MAX_ROWS, SEPARATOR_SHARE, chevronsOf, readoutLines, readoutPosition, rowGeometry, strategyCell } from './rows.js';

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function setData(element, name, value) {
  if (value === null || value === undefined) element.removeAttribute(name);
  else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setHidden(element, hidden) {
  if (element.hidden !== hidden) element.hidden = hidden;
}

function setVar(element, name, value) {
  if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
}

function createRow(side) {
  const qty = h('span', { class: 'ladder-qty' });
  const tag = h('span', { class: 'ladder-tag' });
  const strategy = h('div', { class: 'ladder-cell ladder-strategy' }, qty, tag);
  const price = h('div', { class: 'ladder-cell ladder-price' });
  const publicSize = h('div', { class: 'ladder-cell ladder-public' });
  const cells = side === 'ask' ? [strategy, price, publicSize] : [publicSize, price, strategy];
  return { element: h('div', { class: 'ladder-row', 'data-side': side }, ...cells), strategy, qty, tag, price, publicSize };
}

function createChevron(direction) {
  const text = h('span', { class: 'ladder-chevron-text' });
  return { element: h('div', { class: 'ladder-chevron', 'data-direction': direction, hidden: true }, h('span', { class: 'ladder-arrow' }), text), text };
}

function paintRow(row, data, isHovered) {
  const cell = strategyCell(data);
  setText(row.price, data?.price ?? '');
  setData(row.price, 'data-ring', data?.ring ?? null);
  setText(row.publicSize, data?.public ?? '');
  setText(row.qty, cell?.qty ?? '');
  setText(row.tag, cell?.word ?? '');
  setData(row.strategy, 'data-tone', cell?.tone ?? null);
  setData(row.element, 'data-hover', isHovered ? 'true' : null);
}

/**
 * @returns {{
 *   element: HTMLElement,
 *   paint: (state: { ladder: object | null, height: number, hover: { side: 'ask' | 'bid', index: number } | null, pointer: { x: number, y: number } | null }) => void,
 * }}
 */
export function createLadderBody() {
  const sides = {
    ask: Array.from({ length: MAX_ROWS }, () => createRow('ask')),
    bid: Array.from({ length: MAX_ROWS }, () => createRow('bid')),
  };
  const midText = h('span', { class: 'ladder-mid' });
  const up = createChevron('up');
  const down = createChevron('down');
  const readout = h('div', { class: 'ladder-readout', hidden: true });
  const pill = h('div', { class: 'ladder-pill', hidden: true });
  // Overlays come in the order they are drawn: chevrons, then the readout, then the pill on top.
  const element = h('div', { class: 'ladder-body' },
    h('div', { class: 'ladder-side ladder-asks' }, ...sides.ask.map((row) => row.element)),
    h('div', { class: 'ladder-separator' }, h('span', { class: 'ladder-mid-label' }, 'MID'), midText),
    h('div', { class: 'ladder-side ladder-bids' }, ...sides.bid.map((row) => row.element)),
    up.element, down.element, readout, pill,
  );
  // The layout and the hover maths must split the body the same way, so the share has one source.
  element.style.setProperty('--ladder-separator-share', SEPARATOR_SHARE * 100 + '%');

  function paintGeometry(height, rows) {
    const geometry = rowGeometry(height, rows);
    setVar(element, '--ladder-cell-font', geometry.cellFont + 'px');
    if (geometry.tagFont !== null) setVar(element, '--ladder-tag-font', geometry.tagFont + 'px');
    setVar(element, '--ladder-grid-fade', String(geometry.gridFade));
    setVar(element, '--ladder-ring-scale', String(geometry.scale));
    setVar(element, '--ladder-chevron-h', geometry.chevronHeight + 'px');
    setData(element, 'data-tags', geometry.tagFont === null ? 'hidden' : null);
  }

  function paintReadout(row, pointer, height) {
    if (!row || !pointer) {
      setHidden(readout, true);
      return;
    }
    setText(readout, readoutLines(row).join('\n'));
    setHidden(readout, false);
    const { left, top } = readoutPosition(pointer, { width: readout.offsetWidth, height: readout.offsetHeight }, { width: element.clientWidth, height });
    setVar(readout, '--ladder-readout-x', left + 'px');
    setVar(readout, '--ladder-readout-y', top + 'px');
  }

  function paintOverlays(ladder) {
    const chevrons = chevronsOf(ladder);
    for (const [chevron, text] of [[up, chevrons.up], [down, chevrons.down]]) {
      setHidden(chevron.element, text === null);
      setText(chevron.text, text ?? '');
    }
    setHidden(pill, !ladder.pill);
    setText(pill, ladder.pill?.text ?? '');
    setData(pill, 'data-tone', ladder.pill?.tone ?? null);
  }

  function hideEverything() {
    for (const row of [...sides.ask, ...sides.bid]) setHidden(row.element, true);
    setText(midText, '');
    setHidden(up.element, true);
    setHidden(down.element, true);
    setHidden(readout, true);
    setHidden(pill, true);
  }

  return {
    element,

    /** `height` is the body's measured height; `hover` and `pointer` are worked out by the caller from the pointer's position. */
    paint({ ladder, height, hover, pointer }) {
      if (!ladder) {
        hideEverything();
        return;
      }
      const rows = Math.min(ladder.rows, MAX_ROWS);
      setData(element, 'data-status', ladder.status);
      setData(element, 'data-muted', String(ladder.muted));
      paintGeometry(height, rows);
      for (const [side, list] of [['ask', ladder.asks], ['bid', ladder.bids]]) {
        sides[side].forEach((row, index) => {
          setHidden(row.element, index >= rows);
          if (index < rows) paintRow(row, list[index], hover?.side === side && hover.index === index);
        });
      }
      setText(midText, ladder.mid.text);
      setData(midText, 'data-tone', ladder.mid.tone);
      paintOverlays(ladder);
      const hovered = hover ? (hover.side === 'ask' ? ladder.asks : ladder.bids)[hover.index] : null;
      paintReadout(hovered, pointer, height);
    },
  };
}
