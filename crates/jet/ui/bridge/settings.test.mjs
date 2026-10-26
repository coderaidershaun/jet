import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSettings } from './settings.js';

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
