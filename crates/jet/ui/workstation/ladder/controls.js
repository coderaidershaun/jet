// The ladder header's rules, with no DOM: the level stepper's arithmetic and capped readout, and
// the grouping choices the combo lists.

/** The levels range used until hello says otherwise. */
export const DEFAULT_LEVELS = { min: 12, max: 30, default: 12 };

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** The level after a step, kept inside the range. */
export function stepLevel(value, step, range) {
  return clamp(value + step, range.min, range.max);
}

/** The level a click or drag at `fraction` (0 = left end, 1 = right end) of the track chooses. */
export function levelAt(fraction, range) {
  return clamp(range.min + Math.round(clamp(fraction, 0, 1) * (range.max - range.min)), range.min, range.max);
}

/** The share of the track that is filled for a level. */
export function levelFill(value, range) {
  return clamp((value - range.min) / Math.max(range.max - range.min, 1), 0, 1);
}

/**
 * What the stepper reads: the level asked for, then in brackets how many rows fit when that is
 * fewer. `fit` is null until the body has been measured.
 */
export function levelReadout(value, fit) {
  return { value: String(value), capped: fit !== null && fit < value ? '(' + fit + ')' : null };
}

function commandOf(unit, entry) {
  return unit === 'ticks'
    ? { cmd: 'dom_grouping', unit, perBucket: entry.perBucket }
    : { cmd: 'dom_grouping', unit, numerator: entry.numerator, denominator: entry.denominator };
}

function isSameGrouping(unit, entry, grouping) {
  if (grouping?.unit !== unit) return false;
  return unit === 'ticks' ? entry.perBucket === grouping.perBucket : entry.numerator === grouping.numerator && entry.denominator === grouping.denominator;
}

/**
 * The combo's choices for the unit the view is in (bps before the first view), each with the
 * command it sends, and the index of the choice the view has now, or -1.
 * @param {import('../../bridge/workstation.js').HelloLine['groupings'] | undefined} groupings
 * @param {import('../../bridge/workstation.js').ViewSection | undefined} view
 */
export function groupingChoices(groupings, view) {
  const unit = view?.domUnit ?? 'bps';
  const list = groupings?.[unit] ?? [];
  return {
    options: list.map((entry) => ({ label: entry.label, command: commandOf(unit, entry) })),
    selected: list.findIndex((entry) => isSameGrouping(unit, entry, view?.domGrouping)),
  };
}
