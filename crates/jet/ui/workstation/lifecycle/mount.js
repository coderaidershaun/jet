// The overlay over the three panels while the workstation is not live: starting, draining or
// stopped. The state lives in `mount`, so two workstations on one page never share a screen.

import { h } from '../../chat/dom.js';
import { createLifecycleView } from './view.js';

const STYLESHEET = new URL('./lifecycle.css', import.meta.url).href;

function addStylesheet() {
  const added = [...document.head.querySelectorAll('link[rel="stylesheet"]')].some((link) => link.href === STYLESHEET);
  if (!added) document.head.append(h('link', { rel: 'stylesheet', href: STYLESHEET }));
}

/** @param {{ root: HTMLElement, store: ReturnType<typeof import('../page.js').createWorkstation> }} area */
export function mount({ root, store }) {
  addStylesheet();
  const view = createLifecycleView(root);
  let latest = store.latest('lifecycle');
  let dirty = latest !== undefined;
  store.onFrame('lifecycle', (line) => {
    latest = line;
    dirty = true;
  });
  store.register('lifecycle', () => {
    if (!dirty) return;
    dirty = false;
    view.paint(latest);
  });
}
