// The workstation's centre panel. Every piece of its state is made inside `mount`, so two
// workstations on one page never share rows.

import { h } from '../../dom.js';
import { createChannelRings } from './channels.js';
import { createMonitorView } from './view.js';

const STYLESHEET = new URL('./monitor.css', import.meta.url).href;

function addStylesheet() {
  const added = [...document.head.querySelectorAll('link[rel="stylesheet"]')].some((link) => link.href === STYLESHEET);
  if (!added) document.head.append(h('link', { rel: 'stylesheet', href: STYLESHEET }));
}

/** @param {{ root: HTMLElement, store: ReturnType<typeof import('../page.js').createWorkstation> }} area */
export function mount({ root, store }) {
  addStylesheet();
  const rings = createChannelRings();
  const view = createMonitorView(root, rings);
  store.onFrame('hello', () => rings.restart());
  // Every tick is folded, not only those with rows, because a new session or generation
  // starts the rings over even when no rows come with it.
  store.onFrame('tick', (_, line) => {
    if (rings.fold(line)) view.changed('channels');
  });
  for (const band of ['account', 'summary', 'features']) store.onFrame(band, () => view.changed(band));
  store.register('monitor', () => view.paint(store));
}
