// Lets an area load its own stylesheet, so a page that mounts the area needs no change to its head.

import { h } from '../../chat/dom.js';

/** Adds a stylesheet link to the page's head, or returns the one already there. */
export function linkStylesheet(href) {
  const existing = [...document.head.querySelectorAll('link[rel="stylesheet"]')].find((link) => link.href === href);
  return existing ?? document.head.appendChild(h('link', { rel: 'stylesheet', href }));
}

/** Runs `callback` once the stylesheet has applied, or failed to load: the page still has to work. */
export function whenStyled(link, callback) {
  if (link.sheet !== null) {
    callback();
    return;
  }
  link.addEventListener('load', callback, { once: true });
  link.addEventListener('error', callback, { once: true });
}
