// The arithmetic behind the settings sheet: colours, counters, and the rules by
// which the expressiveness master moves its channels. No DOM, so the sheet only
// reads and writes fields.

import { PRESETS } from '../../bridge/settings.js';

const HEX = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** @param {string} text @returns {[number, number, number] | null}  null when it is not six hex digits */
export function hexToRgb(text) {
  const match = HEX.exec(text.trim());
  return match ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)] : null;
}

/** @param {number[]} rgb */
export function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/** Characters as a person counts them, and as the Rust limit counts them. @param {string} text */
export function countCodePoints(text) {
  return [...text].length;
}

/**
 * The master moves every channel that follows it.
 * @param {import('../../bridge/settings.js').Expressiveness} expressiveness
 * @param {number} value
 * @returns {import('../../bridge/settings.js').Expressiveness}
 */
export function moveMaster(expressiveness, value) {
  const master = clamp(Math.round(value * 10) / 10, 0, 10);
  const channels = { ...expressiveness.channels };
  for (const name of Object.keys(channels)) if (expressiveness.follow[name]) channels[name] = master;
  return { master, channels, follow: { ...expressiveness.follow } };
}

/** Moving a channel by hand takes it off the master. */
export function takeOverChannel(expressiveness, channel, value) {
  return {
    master: expressiveness.master,
    channels: { ...expressiveness.channels, [channel]: clamp(value, 0, 10) },
    follow: { ...expressiveness.follow, [channel]: false },
  };
}

/** A channel that follows again jumps to the master. */
export function setFollow(expressiveness, channel, follows) {
  return {
    master: expressiveness.master,
    channels: { ...expressiveness.channels, [channel]: follows ? expressiveness.master : expressiveness.channels[channel] },
    follow: { ...expressiveness.follow, [channel]: follows },
  };
}

/** The word under the master slider. @param {number} master */
export function masterWord(master) {
  return master < 1 ? 'still' : master < 3.5 ? 'subtle' : master < 6.5 ? 'expressive' : master < 9 ? 'theatrical' : 'cartoon';
}

/** The preset that matches the behaviour, else "Custom". @param {{ candid: number, playful: number }} behaviour */
export function presetFor({ candid, playful }) {
  const match = PRESETS.find((preset) => Math.abs(preset.candid - candid) < 0.005 && Math.abs(preset.playful - playful) < 0.005);
  return match ? match.name : 'Custom';
}
