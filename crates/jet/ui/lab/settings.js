// Where the lab's state comes from and goes to. Inside Tauri the Rust side owns
// the settings file and the rig; in a plain browser the page falls back to
// localStorage and a relative fetch so the lab still runs for development.

const STORAGE_KEY = 'jet.settings';

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

function tauri() {
  return /** @type {any} */ (window).__TAURI__?.core ?? null;
}

/** Fills gaps in a saved object from the defaults, one level at a time. */
function merge(base, saved) {
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

/** @returns {Promise<import('../jet/rig.js').Rig>} */
export async function loadRig() {
  const bridge = tauri();
  if (bridge) return JSON.parse(await bridge.invoke('rig'));
  const response = await fetch('../rig/jet.json');
  if (!response.ok) throw new Error('could not load the rig (' + response.status + ')');
  return response.json();
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
