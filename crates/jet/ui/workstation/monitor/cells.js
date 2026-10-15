// What the account and feature rows of the monitor show, decided from the bridge's sections. The
// bridge words every text; these only choose between the words it gave and a few fixed ones.

const UNKNOWN_GATE = { text: '--', tone: 'text2' };
const ARMED_GATE = { text: 'ARMED', tone: 'positive' };
// The bridge writes a feature that was never sent as this dash and gives it no tone of its own.
const NEVER_SENT = '--';

/**
 * The last row of the account band. A halt takes the whole row, since a refusal beside it would
 * collide exactly when the halt matters; otherwise the last refusal sits beside the gate.
 * @param {import('../../bridge/workstation.js').AccountSection} account
 */
export function statusRow(account) {
  if (account.gate === 'halted') {
    return { halted: true, banner: account.haltReason ? 'HALTED  ' + account.haltReason : 'HALTED' };
  }
  return { halted: false, reject: account.reject, gate: account.gate === 'armed' ? ARMED_GATE : UNKNOWN_GATE };
}

/**
 * The counts of one side's orders: open, in flight and lost. A real zero still shows, but a leak
 * marks the side itself, so its marker shows only above zero.
 * @param {import('../../bridge/workstation.js').AccountSide} side
 */
export function sideRow(side) {
  return {
    leaked: side.leaked > 0 ? '+' + side.leaked : '',
    counts: [
      { text: String(side.open), tone: 'text' },
      { text: String(side.inflight), tone: 'text' },
      { text: String(side.lost), tone: side.lost > 0 ? 'invalid' : 'text2' },
    ],
  };
}

/**
 * One line of the feature list. A feature that has gone stale still shows the bar of a recent change.
 * A value that was never sent is grey like a stale one, but its name stays bright.
 * @param {import('../../bridge/workstation.js').FeatureRow} row
 */
export function featureRow(row) {
  const dim = row.stale === true;
  const isValueGrey = dim || row.value === NEVER_SENT;
  return { name: row.name, value: row.value, title: row.hover, bar: row.changed === true, dim, valueTone: isValueGrey ? 'text2' : 'text' };
}
