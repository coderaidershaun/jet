import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultSettings, merge, displayName, loadSettings, saveSettings } from './settings.js';

test('defaults mirror Rust and carry the chat fields, and merge fills gaps from them', async () => {
  const defaults = defaultSettings();
  assert.deepEqual(defaults.persona, { name: 'Jet', jobTitle: 'First-mate', notes: '' });
  assert.equal(defaults.model, 'gpt-6.1-sol');
  assert.equal(defaults.effort, 'medium');
  assert.equal(defaults.turnBudgetUsd, 10);
  assert.equal(defaults.drawerOpen, true);
  assert.equal(defaults.claudePath, null);

  assert.equal(defaults.reducedMotion, false);
  assert.deepEqual(merge(defaults, 'garbage'), defaults);
  assert.notEqual(defaultSettings().persona, defaults.persona, 'each call returns fresh objects');

  const originalFake = globalThis.__JET_FAKE__;
  globalThis.__JET_FAKE__ = true;
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  let saved = JSON.stringify({
    behaviour: { candid: 0.1 },
    expressiveness: { master: 2.5 },
    bodyColour: [12, 200, 99],
    repeat: false,
    page: 'workstation',
    workstation: { bridgePath: '/tmp/polysim-bridge', token: 'old-secret' },
    reducedMotion: true,
    persona: { name: 'Ada' },
  });
  try {
    globalThis.window = {};
    globalThis.localStorage = {
      getItem: () => saved,
      setItem: (_key, value) => { saved = value; },
    };
    const loaded = await loadSettings();
    assert.equal(loaded.reducedMotion, true);
    assert.deepEqual(loaded.persona, { ...defaults.persona, name: 'Ada' });
    assert.equal(loaded.model, 'gpt-6.1-sol');
    await saveSettings(loaded);
    assert.deepEqual(await loadSettings(), loaded);
    for (const key of ['behaviour', 'expressiveness', 'bodyColour', 'repeat', 'page', 'workstation']) {
      assert.equal(Object.hasOwn(loaded, key), false, `removed ${key} was loaded`);
      assert.equal(Object.hasOwn(JSON.parse(saved), key), false, `removed ${key} was saved`);
    }
  } finally {
    globalThis.__JET_FAKE__ = originalFake;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
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
  const originalFake = globalThis.__JET_FAKE__;
  globalThis.__JET_FAKE__ = true;
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
    globalThis.__JET_FAKE__ = originalFake;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  }
});
