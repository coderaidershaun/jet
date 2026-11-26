// Tests that saved model and thinking choices load as a supported pair.
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
      [{ model: 'gemini-4-neon', effort: 'xhigh' }, ['gemini-4-neon', 'xhigh']],
      [{ model: 'gemini-4-neon', effort: 'max' }, ['gemini-4-neon', 'high']],
      [{ model: null, effort: 'unknown' }, ['sonnet', 'high']],
    ]) {
      globalThis.fetch = async () => ({ ok: true, json: async () => saved });
      const settings = await loadSettings({ isAdmin: false });
      assert.deepEqual([settings.model, settings.effort], expected);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
