// The link bar's rules, with no DOM: what the bar says for the latest link line.

const NO_ENGINE = 'no engine attached';
export const NEXT_PEER_TIP = 'attach to the next trading engine';

/**
 * The engine chip is clickable when the bridge allows it; a click attaches the next engine.
 * @param {import('../../bridge/workstation.js').LinkLine | null} link
 * @returns {{
 *   note: string | null,
 *   chips: { text: string, tone: string, isClickable: boolean }[],
 *   button: { label: string, command: { cmd: 'assert', state: 'running' | 'idle' } } | null,
 * }}
 */
export function linkBarModel(link) {
  if (!link) return { note: NO_ENGINE, chips: [], button: null };
  return {
    note: null,
    chips: link.chips.map((chip, index) => ({ text: chip.text, tone: chip.tone, isClickable: index === 0 && link.peerClickable === true })),
    button: { label: link.button.label, command: { cmd: 'assert', state: link.button.assert } },
  };
}
