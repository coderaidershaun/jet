import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionFor } from './caption.js';

test('the gear caption reads the model word and the thinking level', () => {
  assert.equal(captionFor('sonnet', 'medium'), 'Sonnet · medium');
  assert.equal(captionFor('fable', 'xhigh'), 'Fable · xhigh');
});
