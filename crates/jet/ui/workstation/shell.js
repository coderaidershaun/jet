// The workstation as the chat window shows it: its own header, the setup card,
// and the workstation itself, built and its feed started the first time its page
// opens. The feed is paused while the chat is up.

import { connectWorkstation } from '../bridge/workstation.js';
import { createWorkstation, mountAreas } from './page.js';

const RESTART_AFTER_EDIT_MS = 800;
const DEFAULT_TITLE = 'Workstation';

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

  async function mount() {
    store = createWorkstation({ root: body, feed: connectWorkstation(), onLeave });
    store.onFrame('catalog', paintCatalog);
    store.onFrame('link', paintLink);
    store.onFrame('bridge', paintBridge);
    await mountAreas(store);
    await start();
  }

  return {
    show() {
      shown = true;
      if (store) store.send({ cmd: 'resume' });
      else mount();
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
