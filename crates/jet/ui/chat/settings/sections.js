// The sections of the settings window in menu order. A new section is one entry here and one module beside it.

import { buildForget, buildPrograms } from './claude.js';
import { buildGithub } from './github.js';
import { buildMcp } from './mcp.js';
import { buildMemory } from './memory.js';
import { buildModel } from './model.js';
import { buildMotion } from './motion.js';
import { buildPersona } from './persona.js';
import { buildVoice } from './voice.js';

/**
 * @typedef {object} SettingsSection
 * @property {string} id   the name the window opens it by, e.g. "claude"
 * @property {string} label   its words in the menu
 * @property {(ctx: import('./window.js').SettingsContext) => { el: Node, refresh?: () => unknown }} build
 *   makes the section once; the window calls `refresh` each time it opens
 * @property {boolean} [savesWithButtons]   the section saves only when a button is pressed, so the window does not
 *   say that changes save as you type
 */

/** @type {readonly SettingsSection[]} */
export const SECTIONS = Object.freeze([
  { id: 'persona', label: 'Persona', build: (ctx) => ({ el: buildPersona(ctx) }) },
  { id: 'model', label: 'Model and thinking', build: buildModel },
  { id: 'voice', label: 'Voice', build: buildVoice },
  { id: 'motion', label: 'Motion', build: buildMotion },
  { id: 'memory', label: 'Memory', build: buildMemory },
  { id: 'github', label: 'GitHub', build: (ctx) => ({ el: buildGithub(ctx) }) },
  { id: 'mcp', label: 'MCP', build: buildMcp, savesWithButtons: true },
  { id: 'claude', label: 'Agent programs', build: buildPrograms },
  { id: 'forget', label: 'Forget this conversation', build: buildForget },
].map((section) => Object.freeze(section)));
