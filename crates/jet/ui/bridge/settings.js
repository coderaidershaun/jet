// Loads the user's settings with gaps filled from the defaults, and saves them, keeping what another tab saved.

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
 * @property {'gemini' | 'browser' | 'phonon2'} hearingEngine   the engine the user chose to hear them
 * @property {'fast' | 'exact' | 'cpu'} phonon2Mode   how Phonon-2 decodes
 * @property {'gemini' | 'browser' | 'phonon'} speakingEngine   the engine the user chose to speak Jet's replies
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
    hearingEngine: 'gemini',
    phonon2Mode: 'fast',
    speakingEngine: 'gemini',
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

/**
 * The settings saved now with this page's edits on top. An edit is a field that differs between `known`, the copy
 * this page last read or saved, and `edited`; every other field keeps what was saved, perhaps by another tab.
 * @template T
 * @param {T} saved
 * @param {T} known
 * @param {T} edited
 * @returns {T}
 */
export function withEdits(saved, known, edited) {
  const out = { ...saved };
  for (const key of Object.keys(edited)) {
    const value = edited[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) out[key] = withEdits(saved[key] ?? {}, known[key] ?? {}, value);
    else if (JSON.stringify(value) !== JSON.stringify(known[key])) out[key] = value;
  }
  return out;
}

/** @param {Settings} settings */
export async function saveSettings(settings) {
  await requestJson('/api/settings', settings, 'PUT');
}

/** Saves while the page goes away: the browser finishes the request after the page is gone. */
export function saveSettingsAsPageGoes(settings) {
  globalThis.fetch('/api/settings', { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })
    .catch((error) => console.warn('the settings could not be saved as the page went:', error));
}

/** The name the page shows for Jet: the persona's name, or Jet while it is blank. */
export function displayName(settings) {
  return settings.persona.name.trim() || 'Jet';
}
