// Says whether the prompt cache is still warm, in the words the drawer shows.
// A cold cache means the next reply pays to read the whole conversation again.

import { clockTime } from '../clock.js';

const MINUTE_MS = 60 * 1000;

/**
 * @param {{ lastRequestAt: number | null, ttlMinutes: number, contextTokens: number }} cache
 * @param {number} now   ms
 * @returns {{ warm: boolean, text: string }}
 */
export function describeCache({ lastRequestAt, ttlMinutes, contextTokens }, now) {
  if (lastRequestAt === null) return { warm: false, text: 'cold · nothing cached yet' };
  const expiresAt = lastRequestAt + ttlMinutes * MINUTE_MS;
  if (now < expiresAt) return { warm: true, text: 'warm until ' + clockTime(expiresAt) };
  const thousands = Math.max(1, Math.round(contextTokens / 1000));
  return { warm: false, text: 'cold · next reply re-reads ~' + thousands + 'k tokens' };
}
