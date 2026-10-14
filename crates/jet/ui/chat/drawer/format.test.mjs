import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTHING, compactCount, count, dollars, modelAndThinking, seconds, spendText, turnsText } from './format.js';

test('counts group thousands with commas and shorten from 10 000 up, with a dash for a time or a turn count not known yet', () => {
  assert.equal(NOTHING, '—');
  assert.equal(count(0), '0');
  assert.equal(count(1575), '1,575');
  assert.equal(compactCount(9999), '9,999');
  assert.equal(compactCount(12900), '12.9K');
  assert.equal(compactCount(2345678), '2.3M');
  assert.equal(dollars(0), '$0.0000');
  assert.equal(dollars(0.007334), '$0.0073');
  assert.equal(seconds(2168), '2.17 s');
  assert.equal(seconds(null), NOTHING);
  assert.equal(turnsText(1), '1');
  assert.equal(turnsText(null), NOTHING);
});

test('spend reads reported, est., no rate or a dash', () => {
  const reply = { status: 'streaming', model: 'claude-sonnet-5-5', reportedUsd: null, estimateUsd: null };

  assert.equal(spendText({ ...reply, status: 'idle', estimateUsd: 0.007334 }), NOTHING);
  assert.equal(spendText({ ...reply, model: null }), NOTHING);
  assert.equal(spendText({ ...reply, estimateUsd: 0.007334 }), 'est. $0.0073');
  assert.equal(spendText({ ...reply, status: 'done', reportedUsd: 0.0081, estimateUsd: 0.007334 }), '$0.0081 reported');
  assert.equal(spendText({ ...reply, model: 'claude-x-1' }), 'no rate');
});

test('the model line is the short name and the thinking level, or a dash', () => {
  assert.equal(modelAndThinking({ model: null, effort: 'medium' }), NOTHING);
  assert.equal(modelAndThinking({ model: 'claude-sonnet-5-5', effort: null }), 'Sonnet 5.5');
  assert.equal(modelAndThinking({ model: 'claude-sonnet-5-5', effort: 'medium' }), 'Sonnet 5.5\u00A0· medium');
  assert.equal(modelAndThinking({ model: 'claude-x-1', effort: 'high' }), 'claude-x-1\u00A0· high');
});
