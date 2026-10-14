// The workstation as the chat window shows it: its own header, the setup card,
// and the workstation itself, loaded the first time its page opens. Its feed is
// paused while the chat is up.

import { h } from '../chat/dom.js';

const RESTART_AFTER_EDIT_MS = 800;
const DEFAULT_TITLE = 'Workstation';

/** Adds a stylesheet and settles when it has loaded. @param {string} href */
function addStylesheet(href) {
  return new Promise((resolve, reject) => {
    document.head.append(h('link', {
      rel: 'stylesheet',
      href,
      onLoad: resolve,
      onError: () => reject(new Error('the stylesheet ' + href + ' could not be loaded')),
    }));
  });
}

/**
 * @param {{
 *   body: HTMLElement, title: HTMLElement, link: HTMLElement,
 *   setup: HTMLElement, setupDetail: HTMLElement, setupButton: HTMLElement,
 *   settings: import('../bridge/settings.js').Settings,
 *   openSettings: () => void, onLeave: () => void,
 * }} parts
 */
export function createWorkstationShell({ body, title, link, setup, setupDetail, setupButton, settings, openSettings, onLeave }) {
  let store = null;
  let loading = null;
  let shown = false;
  let restartTimer = 0;
  setupButton.addEventListener('click', openSettings);

  async function start() {
    try {
      await store.start(settings.workstation);
    } catch (error) {
      console.warn('the workstation feed could not start:', error);
    }
    if (!shown) store.send({ cmd: 'pause' });
  }

  const paintCatalog = (line) => {
    title.textContent = line.title || DEFAULT_TITLE;
  };
  const paintLink = (line) => {
    link.hidden = false;
    link.textContent = line.connection.toUpperCase();
    link.dataset.connection = line.connection;
  };
  const paintBridge = (line) => {
    const missing = line.status === 'missing';
    // No link is known while the bridge starts, restarts or is gone.
    link.hidden = true;
    setup.hidden = !missing;
    body.hidden = missing;
    setupDetail.textContent = missing ? line.detail : '';
    if (missing) title.textContent = DEFAULT_TITLE;
  };

  async function load() {
    try {
      // One after the other, so a build without the workstation asks for one missing file, not two.
      const page = await import('./page.js');
      const bridge = await import('../bridge/workstation.js');
      await addStylesheet(new URL('./workstation.css', import.meta.url).href);
      const next = page.createWorkstation({ root: body, feed: bridge.connectWorkstation(), onLeave });
      next.onFrame('catalog', paintCatalog);
      next.onFrame('link', paintLink);
      next.onFrame('bridge', paintBridge);
      await page.mountAreas(next);
      store = next;
    } catch (error) {
      console.warn('the workstation could not be loaded:', error);
      body.replaceChildren(h('p', { class: 'workstation-notice', text: 'Workstation not installed' }));
      return;
    }
    await start();
  }

  return {
    show() {
      shown = true;
      if (store) store.send({ cmd: 'resume' });
      else loading ??= load();
    },

    hide() {
      shown = false;
      store?.send({ cmd: 'pause' });
    },

    /** The settings changed: the workstation starts again with them a moment after the last edit. */
    settingsChanged() {
      clearTimeout(restartTimer);
      if (store) restartTimer = setTimeout(start, RESTART_AFTER_EDIT_MS);
    },
  };
}
