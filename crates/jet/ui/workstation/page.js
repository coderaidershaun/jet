// The workstation page: the grid with a mount point for each area, the store that every area is
// handed, and the loading of the areas. The page draws no numbers itself.
//
// An area is a folder `ui/workstation/<area>/` whose `mount.js` exports `mount({ root, store })`.
// `root` is the area's mount point. `store` has `onFrame(name, fn)` for every line kind and tick
// section, `register(name, painter)` with `painter(nowMs)` called every animation frame (the clock
// of `performance.now()`), `send(command)`, `latest(name)` and `leave()`. Adding an area changes
// no shared file. Until an area's folder exists, its mount point shows the raw sections it will draw.
//
// Mount every area before calling `store.start()`. An area that folds the append-only sections
// (chart, risk and channels) needs the catalog and the full window that arrive right after the start.

import { h } from '../dom.js';
import { createCommandMemory, createFrameStore } from './store.js';

/** The areas in the order they are mounted: the folder, the id of its mount point and the sections shown raw until it exists. */
export const AREAS = [
  { area: 'toolbar', id: 'ws-toolbar', sections: ['catalog', 'view'] },
  { area: 'latency', id: 'ws-latency', sections: ['latency'] },
  { area: 'chart', id: 'ws-charts', sections: ['chart', 'risk'] },
  { area: 'monitor', id: 'ws-monitor', sections: ['account', 'summary', 'features', 'channels'] },
  { area: 'ladder', id: 'ws-ladder', sections: ['ladder'] },
  { area: 'linkbar', id: 'ws-linkbar', sections: ['link', 'bridge'] },
  { area: 'lifecycle', id: 'ws-lifecycle', sections: ['lifecycle'] },
];

const RAW_SECTION_CHARS = 800;

/**
 * Builds the workstation into `root` and returns the store every area is handed.
 * @param {{
 *   root: HTMLElement,
 *   feed: import('../bridge/workstation.js').WorkstationFeed,
 *   onLeave?: () => void,
 *   schedule?: (callback: (nowMs: number) => void) => number,
 *   cancel?: (handle: number) => void,
 * }} options   `onLeave` is the way back to the chat; `schedule` and `cancel` stand for the animation frame
 */
export function createWorkstation({ root, feed, onLeave = () => {}, schedule = requestAnimationFrame, cancel = cancelAnimationFrame }) {
  const frames = createFrameStore();
  const memory = createCommandMemory();
  const page = h('div', { class: 'ws' },
    h('div', { class: 'ws-panel ws-left' }, h('div', { id: 'ws-toolbar' }), h('div', { id: 'ws-latency' }), h('div', { id: 'ws-charts' })),
    h('div', { class: 'ws-panel ws-centre' }, h('div', { id: 'ws-monitor' })),
    h('div', { class: 'ws-panel ws-right' }, h('div', { id: 'ws-ladder' })),
    h('div', { id: 'ws-linkbar' }),
    h('div', { id: 'ws-lifecycle', hidden: true }),
  );
  root.replaceChildren(page);

  // The bridge may be restarting; the view commands repeat after its next hello.
  const quiet = (error) => console.debug('workstation: a command did not reach the bridge:', error);
  let handle = null;
  let painting = false;

  function paintNextFrame() {
    handle = schedule((nowMs) => {
      frames.paint(nowMs);
      if (painting) paintNextFrame();
    });
  }

  function send(command) {
    memory.note(command);
    return feed.command(command).catch(quiet);
  }

  return {
    onFrame: frames.onFrame,
    register: frames.register,
    latest: frames.latest,
    send,

    /** Starts the feed, or starts it again after a settings change, and the painting loop unless it runs. */
    start(workstation) {
      const started = feed.start(workstation, (line) => {
        if (frames.accept(line)) send({ cmd: 'resync' });
        if (line.kind === 'hello') for (const command of memory.replay()) feed.command(command).catch(quiet);
      });
      if (!painting) {
        painting = true;
        paintNextFrame();
      }
      return started;
    },

    stop() {
      painting = false;
      if (handle !== null) cancel(handle);
      handle = null;
      return feed.stop();
    },

    leave: () => onLeave(),
    element: (id) => page.querySelector('#' + id),
  };
}

/** Until an area exists, its mount point shows the latest value of each of its sections as text. */
function showRawSections(area, root, sections, store) {
  const dump = h('pre', { class: 'ws-dump' });
  root.replaceChildren(dump);
  let changed = true;
  for (const name of sections) store.onFrame(name, () => { changed = true; });
  store.register(area + ' raw sections', () => {
    if (!changed) return;
    changed = false;
    dump.textContent = sections
      .filter((name) => store.latest(name) !== undefined)
      .map((name) => name + '\n' + JSON.stringify(store.latest(name), null, 1).slice(0, RAW_SECTION_CHARS))
      .join('\n\n');
  });
}

/**
 * Loads every area's `mount.js` and mounts it. An area that is missing or fails shows its raw
 * sections instead, so one broken area never blanks the page. Never rejects.
 * @param {ReturnType<typeof createWorkstation>} store
 */
export async function mountAreas(store) {
  for (const { area, id, sections } of AREAS) {
    const root = store.element(id);
    try {
      const module = await import(new URL('./' + area + '/mount.js', import.meta.url));
      await module.mount({ root, store });
    } catch (error) {
      console.info('workstation: the ' + area + ' area is not ready, showing its raw sections', error);
      showRawSections(area, root, sections, store);
    }
  }
}
