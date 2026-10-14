import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCache } from './cache.js';

const at = (hour, minute) => new Date(2026, 9, 14, hour, minute).getTime();

test('the chip reads warm until the TTL ends, then cold with the tokens to re-read', () => {
  const cache = { lastRequestAt: at(9, 42), ttlMinutes: 60, contextTokens: 40600 };

  assert.deepEqual(describeCache(cache, at(9, 50)), { warm: true, text: 'warm until 10:42' });
  assert.equal(describeCache(cache, at(10, 41)).warm, true);
  assert.deepEqual(describeCache(cache, at(10, 42)), { warm: false, text: 'cold · next reply re-reads ~41k tokens' });

  assert.equal(describeCache({ ...cache, contextTokens: 200 }, at(12, 0)).text, 'cold · next reply re-reads ~1k tokens', 'never less than 1k');
  assert.deepEqual(describeCache({ lastRequestAt: null, ttlMinutes: 60, contextTokens: 0 }, at(9, 0)), { warm: false, text: 'cold · nothing cached yet' });
  assert.equal(describeCache({ ...cache, lastRequestAt: at(23, 30) }, at(23, 40)).text, 'warm until 00:30', 'the clock wraps past midnight');
});
