// Draws the cards above a Jet reply. This small version draws only the calls that have a
// card of their own in the registry; the other calls show nothing.

import { RESULT_CARDS } from './registry.js';

/**
 * @param {HTMLElement} container   the `.cards` column of one reply
 * @returns {{ sync: (calls: any[]) => void }}
 */
export function createCardList(container) {
  /** @type {Map<string, HTMLElement>} */
  const nodes = new Map();

  return {
    /** Brings the column up to date with the reply's calls. A card is built once for a call. @param {any[]} calls */
    sync(calls) {
      const wanted = [];
      for (const call of calls) {
        const key = call.server + '/' + call.tool;
        const build = RESULT_CARDS[key];
        if (call.ok !== true || !build) continue;
        if (!nodes.has(call.id)) nodes.set(call.id, build({ id: call.id, key, call, state: 'done' }, {}));
        wanted.push(call.id);
      }
      wanted.forEach((id, i) => {
        const node = nodes.get(id);
        if (container.children[i] !== node) container.insertBefore(node, container.children[i] ?? null);
      });
      for (const [id, node] of nodes) {
        if (wanted.includes(id)) continue;
        node.remove();
        nodes.delete(id);
      }
    },
  };
}
