// What the settings look like, what they default to, and how they are saved.
// Inside Tauri the Rust side owns the file; in a plain browser they go to
// localStorage under the same key the lab uses, so both pages share them.

/** @typedef {{ candid: number, playful: number }} Behaviour */
/** @typedef {{ shape: number, eyes: number, colour: number, motion: number }} Channels */
/** @typedef {{ shape: boolean, eyes: boolean, colour: boolean, motion: boolean }} Follow */
/** @typedef {{ master: number, channels: Channels, follow: Follow }} Expressiveness */
/** @typedef {{ name: string, jobTitle: string, notes: string }} Persona */
/**
 * @typedef {object} Settings
 * @property {Behaviour} behaviour
 * @property {Expressiveness} expressiveness
 * @property {boolean} reducedMotion
 * @property {boolean} repeat
 * @property {Persona} persona
 * @property {[number, number, number] | null} bodyColour   null = the rig's rest colour
 * @property {'fable' | 'opus' | 'sonnet' | 'haiku'} model
 * @property {'low' | 'medium' | 'high' | 'xhigh' | 'max'} effort
 * @property {number} turnBudgetUsd
 * @property {boolean} drawerOpen
 * @property {string | null} claudePath   null = find Claude Code on its own
 */

const STORAGE_KEY = 'jet.settings';

/** The behaviour chips of the lab, as positions on the wheel. */
export const PRESETS = Object.freeze([
  { name: 'Neutral', candid: 0, playful: 0 },
  { name: 'Butler', candid: -0.45, playful: -0.5 },
  { name: 'Deckhand', candid: -0.5, playful: 0.45 },
  { name: 'Shipmate', candid: 0.55, playful: 0.35 },
  { name: 'Quartermaster', candid: 0.6, playful: -0.55 },
]);

/** Mirrors `Settings::default()` on the Rust side. @returns {Settings} */
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
    persona: { name: 'Jet', jobTitle: 'First-mate', notes: '' },
    bodyColour: null,
    model: 'sonnet',
    effort: 'medium',
    turnBudgetUsd: 10,
    drawerOpen: true,
    claudePath: null,
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
    out[key] = b !== null && typeof b === 'object' && !Array.isArray(b) ? merge(b, s) : s;
  }
  return out;
}

function tauri() {
  return /** @type {any} */ (window).__TAURI__?.core ?? null;
}

/** @returns {Promise<Settings>} */
export async function loadSettings() {
  const defaults = defaultSettings();
  try {
    const bridge = tauri();
    if (bridge) return merge(defaults, await bridge.invoke('load_settings'));
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? merge(defaults, JSON.parse(raw)) : defaults;
  } catch (error) {
    console.warn('settings could not be loaded, using defaults:', error);
    return defaults;
  }
}

/** @param {Settings} settings */
export async function saveSettings(settings) {
  try {
    const bridge = tauri();
    if (bridge) await bridge.invoke('save_settings', { settings });
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn('settings could not be saved:', error);
  }
}

/** The name the page shows for Jet: the persona's name, or Jet while it is blank. */
export function displayName(settings) {
  return settings.persona.name.trim() || 'Jet';
}
