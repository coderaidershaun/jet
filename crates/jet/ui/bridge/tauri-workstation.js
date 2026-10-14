// The real workstation feed: each method calls a Rust command, and the bridge's lines stream
// back over a Tauri channel. It is built from the Tauri object it is handed, so a test can
// stand in for the window.

import { asBridgeError } from './tauri-agent.js';

/**
 * @param {{
 *   core: { invoke: (command: string, args?: object) => Promise<any>, Channel: new () => { onmessage: (message: any) => void } },
 * }} tauri   `window.__TAURI__`
 * @returns {import('./workstation.js').WorkstationFeed}
 */
export function createTauriWorkstation({ core }) {
  // Tauri runs each async command as its own task, so two invokes can reach Rust in either
  // order; each call therefore starts only after the previous one has settled.
  let queue = Promise.resolve();
  const call = (command, args) => {
    const result = queue.then(() => core.invoke(command, args)).catch((error) => {
      throw asBridgeError(error);
    });
    queue = result.catch(() => {});
    return result;
  };

  // A line of 8 KiB or more travels by a later fetch and can arrive after `stop` or a restart,
  // so lines of any channel but the latest one are dropped.
  let current = null;

  return {
    start(workstation, onLine) {
      const events = new core.Channel();
      current = events;
      events.onmessage = (line) => {
        if (events !== current) return;
        try {
          onLine(line);
        } catch (error) {
          console.error('the listener for the "' + line.kind + '" line threw:', error);
        }
      };
      return call('workstation_start', { workstation, events });
    },
    command: (command) => call('workstation_command', { command }),
    stop() {
      current = null;
      return call('workstation_stop');
    },
  };
}
