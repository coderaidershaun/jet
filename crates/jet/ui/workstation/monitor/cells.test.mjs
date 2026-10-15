import { test } from 'node:test';
import assert from 'node:assert/strict';
import { featureRow, sideRow, statusRow } from './cells.js';

const account = (gate, haltReason = null, reject = { text: '--', tone: 'text2' }) => ({ gate, haltReason, reject });

test('the status row: a halt takes the row with its reason, otherwise the last refusal beside ARMED or --', () => {
  const refusal = { text: 'gate underfunded', tone: 'warning' };
  assert.deepEqual(statusRow(account('halted', 'order flood', refusal)), { halted: true, banner: 'HALTED  order flood' }, 'a halt shows its reason and hides the refusal');
  assert.deepEqual(statusRow(account('halted')), { halted: true, banner: 'HALTED' }, 'a halt with no reason is just the word');
  assert.deepEqual(statusRow(account('armed', null, refusal)), {
    halted: false,
    reject: refusal,
    gate: { text: 'ARMED', tone: 'positive' },
  });
  assert.deepEqual(statusRow(account(null)).gate, { text: '--', tone: 'text2' }, 'no word about the gate is not ARMED');
});

test('side counts: lost turns invalid above zero, a leak shows +N', () => {
  assert.deepEqual(sideRow({ open: 1, inflight: 0, lost: 0, leaked: 0 }), {
    leaked: '',
    counts: [{ text: '1', tone: 'text' }, { text: '0', tone: 'text' }, { text: '0', tone: 'text2' }],
  }, 'a real zero still shows, and lost at zero is quiet');
  assert.deepEqual(sideRow({ open: 0, inflight: 2, lost: 3, leaked: 2 }), {
    leaked: '+2',
    counts: [{ text: '0', tone: 'text' }, { text: '2', tone: 'text' }, { text: '3', tone: 'invalid' }],
  });
});

test('a feature row: changed shows the bar, stale dims the name and greys the value', () => {
  const feature = (changed, stale) => ({ name: 'obi_half_bp', value: '-0.1234', changed, stale, hover: 'obi_half_bp  =  -0.1234' });
  const plain = featureRow(feature(false, false));
  assert.deepEqual(plain, { name: 'obi_half_bp', value: '-0.1234', title: 'obi_half_bp  =  -0.1234', bar: false, dim: false, valueTone: 'text' });
  assert.deepEqual(featureRow(feature(true, false)), { ...plain, bar: true }, 'a change shows the bar and nothing else');
  assert.deepEqual(featureRow(feature(false, true)), { ...plain, dim: true, valueTone: 'text2' }, 'a stale feature dims its name and greys its value');
  assert.deepEqual(featureRow(feature(true, true)), { ...plain, bar: true, dim: true, valueTone: 'text2' }, 'a feature can be both');
});
