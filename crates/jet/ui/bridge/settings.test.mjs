import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultSettings, merge, displayName, loadSettings } from './settings.js';

test('defaults mirror Rust and carry the chat fields, and merge fills gaps from them', () => {
  const defaults = defaultSettings();
  assert.deepEqual(defaults.persona, { name: 'Jet', jobTitle: 'First-mate', notes: '' });
  assert.equal(defaults.model, 'gpt-6.1-sol');
  assert.equal(defaults.effort, 'medium');
  assert.equal(defaults.turnBudgetUsd, 10);
  assert.equal(defaults.claudePath, null);

  assert.equal(defaults.reducedMotion, false);
  assert.deepEqual(merge(defaults, 'garbage'), defaults);
  assert.notEqual(defaultSettings().persona, defaults.persona, 'each call returns fresh objects');

  const loaded = merge(defaults, {
    behaviour: { candid: 0.1 },
    expressiveness: { master: 2.5 },
    bodyColour: [12, 200, 99],
    repeat: false,
    page: 'workstation',
    workstation: { bridgePath: '/tmp/polysim-bridge', token: 'old-secret' },
    drawerOpen: false,
    reducedMotion: true,
    persona: { name: 'Ada' },
  });
  assert.equal(loaded.reducedMotion, true);
  assert.deepEqual(loaded.persona, { ...defaults.persona, name: 'Ada' });
  assert.equal(loaded.model, 'gpt-6.1-sol');
  for (const key of ['behaviour', 'expressiveness', 'bodyColour', 'repeat', 'page', 'workstation', 'drawerOpen']) {
    assert.equal(Object.hasOwn(loaded, key), false, `removed ${key} was loaded`);
  }
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
  const originalFetch = globalThis.fetch;
  try {
    for (const [saved, expected] of [
      [{ model: 'gpt-6-luna', effort: 'ultra' }, ['gpt-6-luna', 'high']],
      [{ model: 'sonnet', effort: 'ultra' }, ['sonnet', 'high']],
      [{ model: 'gpt-6.1-sol', effort: 'ultra' }, ['gpt-6.1-sol', 'ultra']],
      [{ model: null, effort: 'unknown' }, ['gpt-6.1-sol', 'high']],
    ]) {
      globalThis.fetch = async () => ({ ok: true, json: async () => saved });
      const settings = await loadSettings();
      assert.deepEqual([settings.model, settings.effort], expected);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
