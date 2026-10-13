// Where the lab's state comes from and goes to. Inside Tauri the Rust side owns
// the settings file and the rig; in a plain browser the page falls back to
// localStorage and a relative fetch so the lab still runs for development.

import { defaultSettings, merge } from './settings.js';

const STORAGE_KEY = 'jet.settings';

function tauri() {
  return /** @type {any} */ (window).__TAURI__?.core ?? null;
}

/** @returns {Promise<import('../jet/rig.js').Rig>} */
export async function loadRig() {
  const bridge = tauri();
  if (bridge) return JSON.parse(await bridge.invoke('rig'));
  const response = await fetch('../rig/jet.json');
  if (!response.ok) throw new Error('could not load the rig (' + response.status + ')');
  return response.json();
}

/** @returns {Promise<import('./settings.js').Settings>} */
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

/** @param {import('./settings.js').Settings} settings */
export async function saveSettings(settings) {
  try {
    const bridge = tauri();
    if (bridge) await bridge.invoke('save_settings', { settings });
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn('settings could not be saved:', error);
  }
}
