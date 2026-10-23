import { MODELS, effortsFor } from './models.js';
import { requestJson } from './browser-agent.js';

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
        enabled: false,
        command: '',
        cwd: null,
      },
      polysim: {
        enabled: false,
        command: '',
        cwd: null,
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

/** @returns {Promise<Settings>} */
export async function loadSettings() {
  const defaults = defaultSettings();
  try {
    const saved = globalThis.__JET_FAKE__ === true
      ? JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
      : await requestJson('/api/settings');
    const settings = merge(defaults, saved);
    if (!MODELS.some(([model]) => model === settings.model)) settings.model = defaults.model;
    if (!effortsFor(settings.model).includes(settings.effort)) settings.effort = 'high';
    return settings;
  } catch (error) {
    if (globalThis.__JET_FAKE__ !== true) throw error;
    console.warn('settings could not be loaded, using defaults:', error);
    return defaults;
  }
}

/** @param {Settings} settings */
export async function saveSettings(settings) {
  try {
    if (globalThis.__JET_FAKE__ === true) localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    else await requestJson('/api/settings', settings, 'PUT');
  } catch (error) {
    console.warn('settings could not be saved:', error);
  }
}

/** The name the page shows for Jet: the persona's name, or Jet while it is blank. */
export function displayName(settings) {
  return settings.persona.name.trim() || 'Jet';
}
