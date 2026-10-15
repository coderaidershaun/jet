// The one part of the link bar that deals with the store: the link line in, the commands out,
// and a painter that draws when the line changed.

import { h } from '../../dom.js';
import { linkBarModel } from './chips.js';
import { createLinkBar } from './view.js';

// SMELL: every workstation area carries its own copy of this loader; the page should offer one.
function addStylesheet(href) {
  const existing = [...document.head.querySelectorAll('link[rel="stylesheet"]')].find((link) => link.href === href);
  if (existing?.sheet) return Promise.resolve();
  const link = existing ?? h('link', { rel: 'stylesheet', href });
  return new Promise((resolve) => {
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => {
      console.error('the link bar stylesheet did not load:', href);
      resolve();
    }, { once: true });
    if (!existing) document.head.append(link);
  });
}

/**
 * Builds the link bar into `root`.
 * SMELL: nothing is torn down; mounting the area twice would leave the first one's listeners running.
 * @param {{ root: HTMLElement, store: { onFrame: Function, register: Function, send: Function, latest: Function } }} area
 */
export async function mount({ root, store }) {
  await addStylesheet(new URL('./linkbar.css', import.meta.url).href);
  const bar = createLinkBar({ send: (command) => store.send(command) });
  root.replaceChildren(bar.element);

  let link = store.latest('link') ?? null;
  let isDirty = true;
  store.onFrame('link', (line) => {
    link = line;
    isDirty = true;
  });
  // A bridge line ends the run the link line described, so the bar waits for the new run's first link line.
  store.onFrame('bridge', () => {
    link = null;
    isDirty = true;
  });
  store.register('linkbar', () => {
    if (!isDirty) return;
    isDirty = false;
    bar.paint(linkBarModel(link));
  });
}
