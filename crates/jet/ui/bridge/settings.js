import { MODELS, effortsFor } from './models.js';

/** @typedef {{ name: string, jobTitle: string, notes: string }} Persona */
/** @typedef {{ enabled: boolean, command: string, cwd: string | null }} McpServer */
/**
 * @typedef {object} Settings
 * @property {boolean} reducedMotion
 * @property {Persona} persona
 * @property {string} model
 * @property {'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'} effort
 * @property {number} turnBudgetUsd
 * @property {boolean} drawerOpen
 * @property {string | null} codexPath   null = find Codex automatically
 * @property {string | null} claudePath   null = find Claude Code on its own
 * @property {{ quanty: McpServer, polysim: McpServer }} mcp   the libraries Jet's agent may use
 */

const STORAGE_KEY = 'jet.settings';

/** Mirrors `Settings::default()` on the Rust side. @returns {Settings} */
export function defaultSettings() {
  return {
    reducedMotion: false,
    persona: { name: 'Jet', jobTitle: 'First-mate', notes: '' },
    model: 'gpt-6.1-sol',
    effort: 'medium',
    turnBudgetUsd: 10,
    drawerOpen: true,
    claudePath: null,
    codexPath: null,
    mcp: {
      quanty: {
        enabled: true,
        command: '/Users/shaun/Code/DEVELOPMENT/quanty/target/release/quanty-mcp',
        cwd: '/Users/shaun/Code/DEVELOPMENT/quanty',
      },
      polysim: {
        enabled: true,
        command: '/Users/shaun/Code/DEVELOPMENT/polysim/target/release/polysim-mcp',
        cwd: '/Users/shaun/Code/DEVELOPMENT/polysim',
      },
    },
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
    const saved = bridge
      ? await bridge.invoke('load_settings')
      : JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    const settings = merge(defaults, saved);
    if (!MODELS.some(([model]) => model === settings.model)) settings.model = defaults.model;
    if (!effortsFor(settings.model).includes(settings.effort)) settings.effort = 'high';
    return settings;
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
