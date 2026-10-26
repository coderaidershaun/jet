import { MODELS, effortsFor } from './models.js';
import { requestJson } from './browser-agent.js';

/** @typedef {{ name: string, jobTitle: string, notes: string }} Persona */
/**
 * @typedef {object} Settings
 * @property {boolean} reducedMotion
 * @property {Persona} persona
 * @property {string} model
 * @property {'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'} effort
 * @property {number} turnBudgetUsd
 * @property {string | null} codexPath   null = find Codex automatically
 * @property {string | null} claudePath   null = find Claude Code on its own
 */

/** Mirrors `Settings::default()` on the Rust side. @returns {Settings} */
function defaultSettings() {
  return {
    reducedMotion: false,
    persona: { name: 'Jet', jobTitle: 'First-mate', notes: '' },
    model: 'gpt-6.1-sol',
    effort: 'medium',
    turnBudgetUsd: 10,
    claudePath: null,
    codexPath: null,
  };
}

/** Fills gaps in a saved object from the defaults, one level at a time. */
function merge(base, saved) {
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
  const settings = merge(defaults, await requestJson('/api/settings'));
  if (!MODELS.some(([model]) => model === settings.model)) settings.model = defaults.model;
  if (!effortsFor(settings.model).includes(settings.effort)) settings.effort = 'high';
  return settings;
}

/** @param {Settings} settings */
export async function saveSettings(settings) {
  await requestJson('/api/settings', settings, 'PUT');
}

/** The name the page shows for Jet: the persona's name, or Jet while it is blank. */
export function displayName(settings) {
  return settings.persona.name.trim() || 'Jet';
}
