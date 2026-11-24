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
 * @property {string | null} [codexPath]   admin only; null = find Codex automatically
 * @property {string | null} [agyPath]   admin only; null = find agy automatically
 * @property {string | null} [claudePath]   admin only; null = find Claude Code on its own
 */

/**
 * Mirrors `Settings::default()` on the Rust side. The program paths decide which program the
 * server runs, so only an admin's settings carry them.
 * @returns {Settings}
 */
function defaultSettings(isAdmin) {
  return {
    reducedMotion: false,
    persona: { name: 'Jet', jobTitle: 'First-mate', notes: '' },
    model: 'sonnet',
    effort: 'medium',
    turnBudgetUsd: 10,
    ...(isAdmin ? { claudePath: null, codexPath: null, agyPath: null } : {}),
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

/**
 * @param {{ isAdmin: boolean }} user   who is signed in
 * @returns {Promise<Settings>}
 */
export async function loadSettings({ isAdmin }) {
  const defaults = defaultSettings(isAdmin);
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
