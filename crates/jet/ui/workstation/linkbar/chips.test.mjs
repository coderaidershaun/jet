import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkBarModel } from './chips.js';

const link = (changes = {}) => ({
  kind: 'link',
  peer: '127.0.0.1:9311',
  peerIndex: 0,
  peerCount: 2,
  session: 1,
  chips: [
    { text: 'engine 127.0.0.1:9311 [1/2]', tone: 'text' },
    { text: 'LIVE', tone: 'positive' },
    { text: 'ready', tone: 'text2' },
    { text: 'run RUNNING', tone: 'positive' },
    { text: 'control none', tone: 'text2' },
  ],
  peerClickable: true,
  button: { label: 'STOP', assert: 'idle' },
  connection: 'live',
  ...changes,
});

test('the link bar reads "no engine attached" until a link line, then its chips in order, the peer chip clickable only when the bridge allows, and a button that asserts the next state', () => {
  assert.deepEqual(linkBarModel(null), { note: 'no engine attached', chips: [], button: null });

  const model = linkBarModel(link());
  assert.equal(model.note, null);
  assert.deepEqual(model.chips.map((chip) => chip.text), ['engine 127.0.0.1:9311 [1/2]', 'LIVE', 'ready', 'run RUNNING', 'control none'], 'chips keep the bridge order');
  assert.deepEqual(model.chips.map((chip) => chip.tone), ['text', 'positive', 'text2', 'positive', 'text2']);
  assert.deepEqual(model.chips.map((chip) => chip.isClickable), [true, false, false, false, false], 'only the engine chip steps to the next peer');
  assert.deepEqual(model.button, { label: 'STOP', command: { cmd: 'assert', state: 'idle' } });

  const single = linkBarModel(link({ peerClickable: false, button: { label: 'START', assert: 'running' } }));
  assert.equal(single.chips[0].isClickable, false, 'one engine, nothing to step to');
  assert.deepEqual(single.button, { label: 'START', command: { cmd: 'assert', state: 'running' } });
});
