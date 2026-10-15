import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESETS, defaultSettings, merge, displayName, loadSettings } from './settings.js';

test('defaults mirror Rust and carry the chat fields, and merge fills gaps from them', () => {
  const defaults = defaultSettings();
  assert.deepEqual(defaults.behaviour, { candid: 0.55, playful: 0.35 });
  assert.equal(defaults.expressiveness.master, 6);
  assert.deepEqual(defaults.expressiveness.follow, { shape: true, eyes: false, colour: true, motion: true });
  assert.equal(defaults.repeat, true);
  assert.deepEqual(defaults.persona, { name: 'Jet', jobTitle: 'First-mate', notes: '' });
  assert.equal(defaults.bodyColour, null);
  assert.equal(defaults.model, 'gpt-6.1-sol');
  assert.equal(defaults.effort, 'medium');
  assert.equal(defaults.turnBudgetUsd, 10);
  assert.equal(defaults.drawerOpen, true);
  assert.equal(defaults.claudePath, null);
  assert.deepEqual(PRESETS.map((preset) => preset.name), ['Neutral', 'Butler', 'Deckhand', 'Shipmate', 'Quartermaster']);

  const oldLabSave = { behaviour: { candid: 0.1 }, reducedMotion: true };
  const merged = merge(defaults, oldLabSave);
  assert.equal(merged.behaviour.candid, 0.1);
  assert.equal(merged.behaviour.playful, 0.35);
  assert.equal(merged.reducedMotion, true);
  assert.deepEqual(merged.persona, defaults.persona);
  assert.equal(merged.model, 'gpt-6.1-sol');

  assert.deepEqual(merge(defaults, { bodyColour: [10, 20, 30] }).bodyColour, [10, 20, 30]);
  assert.deepEqual(merge(defaults, 'garbage'), defaults);
  assert.equal(defaultSettings().behaviour !== defaults.behaviour, true, 'each call returns fresh objects');
});

test('defaults_match_the_rust_fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('./default-settings.json', import.meta.url), 'utf8'));
  assert.deepEqual(defaultSettings(), fixture);
});

test('the shown name is the persona name, or Jet while it is blank', () => {
  const settings = defaultSettings();
  assert.equal(displayName(settings), 'Jet');
  settings.persona.name = '  Neo ';
  assert.equal(displayName(settings), 'Neo');
  settings.persona.name = '   ';
  assert.equal(displayName(settings), 'Jet');
});


test('saved model and thinking choices load as a supported pair', async () => {
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  try {
    globalThis.window = {};
    for (const [saved, expected] of [
      [{ model: 'gpt-6-luna', effort: 'ultra' }, ['gpt-6-luna', 'high']],
      [{ model: 'sonnet', effort: 'ultra' }, ['sonnet', 'high']],
      [{ model: 'gpt-6.1-sol', effort: 'ultra' }, ['gpt-6.1-sol', 'ultra']],
      [{ model: null, effort: 'unknown' }, ['gpt-6.1-sol', 'high']],
    ]) {
      globalThis.localStorage = { getItem: () => JSON.stringify(saved) };
      const settings = await loadSettings();
      assert.deepEqual([settings.model, settings.effort], expected);
    }
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
});
