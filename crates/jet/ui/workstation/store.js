// What the workstation page keeps of the bridge's lines, and the painters that draw it. The
// store holds the newest value of every line kind and every tick section, tells listeners
// the moment one arrives, and runs every painter once per animation frame. It also remembers
// the view commands the page has sent, to repeat after the bridge restarts. No DOM, no timers.

/** The tick sections, in the order the bridge writes them and listeners hear them. */
const SECTIONS = ['view', 'ladder', 'summary', 'account', 'features', 'channels', 'latency', 'chart', 'risk', 'gaps'];
const TICK_FIELDS = new Set(['kind', 'session', 'seq', ...SECTIONS]);

export function createFrameStore() {
  const values = new Map();
  /** @type {Map<string, Set<(value: any, line: object) => void>>} */
  const listeners = new Map();
  /** @type {Set<{ name: string, painter: (nowMs: number) => void }>} */
  const painters = new Set();
  let previous = null;

  function store(name, value, line) {
    values.set(name, value);
    for (const listener of [...(listeners.get(name) ?? [])]) {
      try {
        listener(value, line);
      } catch (error) {
        console.error('a listener for "' + name + '" threw:', error);
      }
    }
  }

  return {
    /**
     * Stores a line under its kind; a tick is stored as `tick` (its session and seq) and then
     * section by section. Returns true when the tick shows that lines were lost: the same
     * session, and a seq that is not the one after the last.
     * @param {{ kind: string, [key: string]: any }} line
     */
    accept(line) {
      if (line.kind !== 'tick') {
        if (line.kind === 'hello') previous = null;
        store(line.kind, line, line);
        return false;
      }
      const gap = previous !== null && previous.session === line.session && line.seq !== previous.seq + 1;
      previous = { session: line.session, seq: line.seq };
      store('tick', { session: line.session, seq: line.seq }, line);
      for (const name of SECTIONS) if (name in line) store(name, line[name], line);
      for (const name of Object.keys(line)) if (!TICK_FIELDS.has(name)) store(name, line[name], line);
      return gap;
    },

    /**
     * The newest value stored under a name, or undefined. `chart`, `risk` and `channels` are
     * deltas, so an area that draws them folds them together through `onFrame`.
     * @param {string} name
     */
    latest: (name) => values.get(name),

    /**
     * Calls `listener(value, line)` whenever a value is stored under `name`. Returns the way to stop.
     * @param {string} name
     * @param {(value: any, line: object) => void} listener
     */
    onFrame(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
      return () => listeners.get(name).delete(listener);
    },

    /**
     * Adds a painter that runs on every frame. Returns the way to remove it.
     * @param {string} name   shown in the log when the painter throws
     * @param {(nowMs: number) => void} painter
     */
    register(name, painter) {
      const entry = { name, painter };
      painters.add(entry);
      return () => painters.delete(entry);
    },

    /** Runs every painter, in the order they were added. A painter that throws is logged and dropped. */
    paint(nowMs) {
      for (const entry of [...painters]) {
        try {
          entry.painter(nowMs);
        } catch (error) {
          painters.delete(entry);
          console.error('the "' + entry.name + '" painter threw and was removed:', error);
        }
      }
    },
  };
}

const VIEW_COMMANDS = new Set(['select', 'chart_mode', 'dom_unit', 'dom_grouping', 'dom_levels', 'dom_fit', 'chart_ticks', 'risk_series']);

/**
 * Remembers the commands that make the view what it is, so they can be sent again to a bridge
 * that restarted. A grouping also sets the unit, so each unit has its own grouping slot; the
 * latest pause or resume is kept apart and replayed last.
 */
export function createCommandMemory() {
  const kept = new Map();
  let pauseOrResume = null;
  return {
    note(command) {
      if (command.cmd === 'pause' || command.cmd === 'resume') {
        pauseOrResume = command;
        return;
      }
      if (!VIEW_COMMANDS.has(command.cmd)) return;
      const key = command.cmd === 'dom_grouping' ? 'dom_grouping:' + command.unit : command.cmd;
      kept.delete(key);
      kept.set(key, command);
    },

    /** The remembered commands in the order each was last sent. */
    replay: () => (pauseOrResume ? [...kept.values(), pauseOrResume] : [...kept.values()]),
  };
}
