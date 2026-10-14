// The raw stream-json lines Claude Code sends, kept for the drawer: the last
// 500 of this page session, each tagged by its type and ready to pretty-print.

const KEEP = 500;
const KNOWN = new Set(['system', 'stream_event', 'assistant', 'result']);

/**
 * @typedef {object} LogLine
 * @property {'system' | 'stream_event' | 'assistant' | 'result' | 'other'} type
 * @property {'ok' | 'danger' | null} tone   set on result lines only
 * @property {string} raw
 * @property {string} pretty
 */

export function createLog() {
  /** @type {LogLine[]} */
  let lines = [];

  return {
    /** @param {string} raw @returns {LogLine} */
    add(raw) {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A line that is not JSON is still shown as it came.
      }
      const type = parsed && KNOWN.has(parsed.type) ? parsed.type : 'other';
      const tone = type === 'result' ? (parsed.is_error ? 'danger' : 'ok') : null;
      const line = { type, tone, raw, pretty: parsed === null ? raw : JSON.stringify(parsed, null, 2) };
      lines.push(line);
      if (lines.length > KEEP) lines = lines.slice(lines.length - KEEP);
      return line;
    },

    lines() {
      return lines;
    },

    clear() {
      lines = [];
    },

    /** Every line, one per row, for the Copy button. */
    text() {
      return lines.map((line) => line.raw).join('\n');
    },
  };
}
