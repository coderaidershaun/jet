// The newest rows of each monitor channel. The bridge sends only the rows that are new, so the
// page keeps a ring of its own for each channel and lays every delta on top of it.

/** The channels, in tab order. */
export const CHANNELS = ['system', 'orders', 'trades', 'fills'];
const RING_ROWS = 256;

/** A value has changed only when it is known on both sides and differs; a section the tick left out says nothing. */
const differs = (known, remembered) => known !== undefined && remembered !== undefined && known !== remembered;

/**
 * Each ring holds `rows` newest first, `appended` (the bridge's running count for the channel) and
 * `epoch`, which goes up every time the ring starts over, so a painter can tell new rows on top
 * from a different set.
 * @returns {{
 *   restart(): void,
 *   fold(line: object): boolean,
 *   ring(name: string): { rows: object[], appended: number, epoch: number },
 * }}
 */
export function createChannelRings() {
  const rings = new Map(CHANNELS.map((name) => [name, { rows: [], appended: 0, epoch: 0 }]));
  /** What the last tick said about its session, generation and instrument, or null before the first tick. */
  let last = null;

  function startOver(ring) {
    ring.rows = [];
    ring.epoch += 1;
  }

  /** Works out whether this tick begins a new set of rows, and remembers what it said. */
  function beginsNewSet(line) {
    const generation = line.chart?.generation ?? line.risk?.generation;
    const instrument = line.view?.instrument;
    const isNew = last === null
      || line.session !== last.session
      || differs(generation, last.generation)
      || differs(instrument, last.instrument);
    last = { session: line.session, generation: generation ?? last?.generation, instrument: instrument ?? last?.instrument };
    return isNew;
  }

  return {
    /** The next tick starts every ring over: a new bridge run counts again from zero. */
    restart() {
      last = null;
    },

    /** Takes a whole tick line. Returns true when any ring changed. */
    fold(line) {
      const newSet = beginsNewSet(line);
      let changed = newSet;
      if (newSet) for (const ring of rings.values()) startOver(ring);
      for (const name of CHANNELS) {
        const section = line.channels?.[name];
        if (!section) continue;
        const ring = rings.get(name);
        if (section.full === true && !newSet) startOver(ring);
        ring.rows = [...section.rows, ...ring.rows].slice(0, RING_ROWS);
        ring.appended = section.appended;
        changed = true;
      }
      return changed;
    },

    ring: (name) => rings.get(name),
  };
}
