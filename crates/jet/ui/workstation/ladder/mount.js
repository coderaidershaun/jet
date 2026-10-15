// The one part of the ladder that deals with the store, the pointer and resizing. Lines and
// events only note what changed; the painter, once per animation frame, draws what did.

import { h } from '../../chat/dom.js';
import { createLadderHeader } from './header.js';
import { MAX_ROWS, hoveredRow, rowsThatFit } from './rows.js';
import { createLadderBody } from './view.js';

// SMELL: every workstation area carries its own copy of this loader; the page should offer one.
function addStylesheet(href) {
  const existing = [...document.head.querySelectorAll('link[rel="stylesheet"]')].find((link) => link.href === href);
  if (existing?.sheet) return Promise.resolve();
  const link = existing ?? h('link', { rel: 'stylesheet', href });
  return new Promise((resolve) => {
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => {
      console.error('the ladder stylesheet did not load:', href);
      resolve();
    }, { once: true });
    if (!existing) document.head.append(link);
  });
}

/**
 * Builds the ladder into `root`.
 * SMELL: nothing is torn down; mounting the area twice would leave the first one's listeners and observer running.
 * @param {{ root: HTMLElement, store: { onFrame: Function, register: Function, send: Function, latest: Function } }} area
 */
export async function mount({ root, store }) {
  await addStylesheet(new URL('./ladder.css', import.meta.url).href);
  const header = createLadderHeader({ send: (command) => store.send(command) });
  const body = createLadderBody();

  let hello = store.latest('hello') ?? null;
  let view = store.latest('view') ?? null;
  let ladder = store.latest('ladder') ?? null;
  let fit = null;
  let height = 0;
  let client = null;
  let isHeaderDirty = true;
  let isBodyDirty = true;

  const ladderElement = h('div', {
    class: 'ladder',
    onPointermove: (event) => {
      client = { clientX: event.clientX, clientY: event.clientY };
      isBodyDirty = true;
    },
    onPointerleave: () => {
      client = null;
      isBodyDirty = true;
    },
  }, header.element, body.element);
  root.replaceChildren(ladderElement);

  store.onFrame('hello', (line) => {
    hello = line;
    isHeaderDirty = true;
  });
  store.onFrame('view', (section) => {
    view = section;
    isHeaderDirty = true;
  });
  store.onFrame('ladder', (section) => {
    ladder = section;
    isBodyDirty = true;
  });
  // A bridge line means the run that sent this book has ended or is starting again; a frozen book must never read as live.
  store.onFrame('bridge', () => {
    ladder = null;
    isBodyDirty = true;
  });

  new ResizeObserver((entries) => {
    const measured = entries.at(-1).contentRect.height;
    // A hidden page measures zero; the bridge must not hear that no rows fit.
    if (measured <= 0) return;
    height = measured;
    isBodyDirty = true;
    const next = rowsThatFit(measured);
    if (next === fit) return;
    fit = next;
    isHeaderDirty = true;
    store.send({ cmd: 'dom_fit', rows: fit });
  }).observe(body.element);

  /** The pointer in the body's own coordinates, or null when it is outside the body. */
  function pointerInBody() {
    if (!client) return null;
    const rect = body.element.getBoundingClientRect();
    const x = client.clientX - rect.left;
    const y = client.clientY - rect.top;
    return x >= 0 && x < rect.width && y >= 0 && y < rect.height ? { x, y } : null;
  }

  store.register('ladder', () => {
    if (isHeaderDirty) {
      isHeaderDirty = false;
      header.paint({ hello, view, fit });
    }
    if (isBodyDirty) {
      isBodyDirty = false;
      const pointer = pointerInBody();
      const hover = pointer && ladder ? hoveredRow({ y: pointer.y, height, rows: Math.min(ladder.rows, MAX_ROWS) }) : null;
      body.paint({ ladder, height, hover, pointer });
    }
  });
}
