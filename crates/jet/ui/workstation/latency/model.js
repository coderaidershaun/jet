// The latency grid as the panel draws it: a header, the column names, and each row's cells lined
// up under them, so a test can check the layout of the numbers without a page.

const NO_READING = { text: '--', tone: 'text2' };

/** @param {import('../../bridge/workstation.js').LatencySection | undefined} section */
export function latencyGrid(section) {
  if (section === undefined) return { header: '', columns: [], rows: [] };
  const names = section.columns ?? [];
  // The last column is a queue depth, not a latency, so the panel sets it apart from the microsecond columns.
  const isSlots = (column) => column === names.length - 1;
  const columns = names.map((text, column) => ({ text, isSlots: isSlots(column) }));
  const rows = (section.rows ?? []).map(({ label, cells }) => ({
    label,
    cells: names.map((_, column) => ({ ...(cells?.[column] ?? NO_READING), isSlots: isSlots(column) })),
  }));
  return { header: section.header, columns, rows };
}
