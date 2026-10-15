// The real agent: each Agent method calls a Rust command, and a reply streams back
// over a Tauri channel. It is built from the Tauri object it is handed, so a test
// can stand in for the window.

/**
 * Every failure reaches the page as { kind, message }. The Rust side already sends that
 * shape; a bare string or an Error from the bridge itself becomes kind "io".
 */
export function asBridgeError(error) {
  if (error && typeof error.kind === 'string' && typeof error.message === 'string') return error;
  if (error instanceof Error) return { kind: 'io', message: error.message };
  return { kind: 'io', message: String(error) };
}

/**
 * @param {{
 *   core: { invoke: (command: string, args?: object) => Promise<any>, Channel: new () => { onmessage: (message: any) => void } },
 *   event: { listen: (name: string, handler: (event: { payload: any }) => void) => Promise<() => void> },
 * }} tauri   `window.__TAURI__`
 * @returns {import('./agent.js').Agent}
 */
export function createTauriAgent({ core, event }) {
  const call = async (command, args) => {
    try {
      return await core.invoke(command, args);
    } catch (error) {
      throw asBridgeError(error);
    }
  };

  return {
    status: () => call('agent_status'),
    history: () => call('load_history'),
    stop: () => call('stop_reply'),
    forget: () => call('forget_conversation'),
    loadMemory: () => call('load_memory'),
    saveMemory: ({ memory, user, recent }) => call('save_memory', { notes: { memory, user, recent } }),
    renderMarkdown: (text) => call('render_markdown', { text }),
    openLink: (url) => call('open_link', { url }),
    mcpCall: (server, tool, args) => call('mcp_call', { server, tool, args }),
    reloadLibraries: () => call('mcp_reload'),

    send(request, onEvent) {
      const events = new core.Channel();
      events.onmessage = (message) => {
        try {
          onEvent(message);
        } catch (error) {
          console.error('the listener for the "' + message.kind + '" event threw:', error);
        }
      };
      return call('send_message', { request, events });
    },

    onMemoryUpdated(listener) {
      let unlisten = null;
      let stopped = false;
      event.listen('memory-updated', (updated) => {
        // Tauri can still deliver an update when the stop came before `listen` was ready.
        if (!stopped) listener(updated.payload);
      }).then(
        (stop) => {
          if (stopped) stop();
          else unlisten = stop;
        },
        (error) => console.error('could not listen for memory updates:', error),
      );
      return () => {
        stopped = true;
        if (unlisten) unlisten();
        unlisten = null;
      };
    },
  };
}
