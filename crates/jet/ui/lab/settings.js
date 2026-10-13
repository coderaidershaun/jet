// What the settings look like and what they default to. Loading and saving them
// is a separate job, so this file does no input or output.

/** @typedef {{ candid: number, playful: number }} Behaviour */
/** @typedef {{ shape: number, eyes: number, colour: number, motion: number }} Channels */
/** @typedef {{ shape: boolean, eyes: boolean, colour: boolean, motion: boolean }} Follow */
/** @typedef {{ master: number, channels: Channels, follow: Follow }} Expressiveness */
/** @typedef {{ behaviour: Behaviour, expressiveness: Expressiveness, reducedMotion: boolean, repeat: boolean }} Settings */

/** Mirrors `Settings::default()` on the Rust side. */
export function defaultSettings() {
  return {
    behaviour: { candid: 0.55, playful: 0.35 },
    expressiveness: {
      master: 6,
      channels: { shape: 6, eyes: 4, colour: 6, motion: 6 },
      follow: { shape: true, eyes: false, colour: true, motion: true },
    },
    reducedMotion: false,
    repeat: true,
  };
}

/** Fills gaps in a saved object from the defaults, one level at a time. */
export function merge(base, saved) {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return base;
  const out = { ...base };
  for (const key of Object.keys(base)) {
    const b = base[key];
    const s = saved[key];
    if (s === undefined) continue;
    out[key] = b !== null && typeof b === 'object' ? merge(b, s) : s;
  }
  return out;
}
