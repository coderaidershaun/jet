import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latencyGrid } from './model.js';

const cell = (text, tone = 'text') => ({ text, tone });

test("the latency grid puts the bridge's rows under its column headers, keeps each cell's tone and sets the slot column apart", () => {
  assert.deepEqual(latencyGrid(undefined), { header: '', columns: [], rows: [] }, 'before the first section the panel is empty');

  const section = {
    header: 'LATENCY  us',
    columns: ['EXCH>RECV', 'PROCESS', 'SLOTS'],
    rows: [
      { label: 'MARKET DATA', cells: [cell('900'), cell('80'), cell('--', 'text2')] },
      { label: 'HOT PATH', cells: [cell('400'), cell('--', 'text2'), cell('4')] },
    ],
  };
  assert.deepEqual(latencyGrid(section), {
    header: 'LATENCY  us',
    columns: [{ text: 'EXCH>RECV', isSlots: false }, { text: 'PROCESS', isSlots: false }, { text: 'SLOTS', isSlots: true }],
    rows: [
      { label: 'MARKET DATA', cells: [{ ...cell('900'), isSlots: false }, { ...cell('80'), isSlots: false }, { ...cell('--', 'text2'), isSlots: true }] },
      { label: 'HOT PATH', cells: [{ ...cell('400'), isSlots: false }, { ...cell('--', 'text2'), isSlots: false }, { ...cell('4'), isSlots: true }] },
    ],
  }, 'the header, the column names and the rows come as sent, each cell keeping its tone; only the last column holds slots');

  const ragged = latencyGrid({
    header: 'LATENCY  us',
    columns: ['A', 'B', 'SLOTS'],
    rows: [
      { label: 'SHORT', cells: [cell('1')] },
      { label: 'LONG', cells: [cell('1'), cell('2'), cell('3'), cell('4')] },
    ],
  });
  assert.deepEqual(ragged.rows[0].cells, [
    { ...cell('1'), isSlots: false },
    { text: '--', tone: 'text2', isSlots: false },
    { text: '--', tone: 'text2', isSlots: true },
  ], 'a short row is padded with no reading');
  assert.deepEqual(ragged.rows[1].cells.map(({ text }) => text), ['1', '2', '3'], 'a long row is cut at the last column');
  assert.deepEqual(ragged.rows[1].cells.map(({ isSlots }) => isSlots), [false, false, true]);
  assert.deepEqual(latencyGrid({ header: 'x', columns: [], rows: [{ label: 'R', cells: [cell('1')] }] }).rows, [{ label: 'R', cells: [] }], 'no columns, no cells');
  assert.deepEqual(latencyGrid({ header: 'x' }), { header: 'x', columns: [], rows: [] }, 'a section without columns or rows lays out nothing');
});
