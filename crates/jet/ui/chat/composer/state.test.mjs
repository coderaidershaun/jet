import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposer } from './state.js';

const key = (overrides = {}) => ({ shiftKey: false, isComposing: false, ...overrides });

test('the composer is centred until the first send, and Send becomes Stop while a reply runs', () => {
  const composer = createComposer({ empty: true });
  assert.equal(composer.layout, 'centred');
  assert.equal(composer.button(''), 'disabled');
  assert.equal(composer.button('  \n '), 'disabled');
  assert.equal(composer.button('hello'), 'send');

  composer.sent();
  assert.equal(composer.layout, 'bottom');

  composer.replying = true;
  assert.equal(composer.button(''), 'stop', 'Stop stays even when the field is empty');
  assert.equal(composer.button('typed meanwhile'), 'stop');
  composer.replying = false;
  assert.equal(composer.button('hello'), 'send');

  composer.reset();
  assert.equal(composer.layout, 'centred', 'forgetting the conversation brings the empty state back');
  assert.equal(createComposer({ empty: false }).layout, 'bottom', 'a restored conversation starts at the bottom');
});

test('Enter sends unless composing, Shift+Enter does not, and Esc closes the sheet, then stops', () => {
  const composer = createComposer({ empty: false });
  assert.equal(composer.enter(key(), 'hello'), 'send');
  assert.equal(composer.enter(key({ shiftKey: true }), 'hello'), 'newline');
  assert.equal(composer.enter(key({ isComposing: true }), 'hello'), 'newline', 'Enter confirms an input method candidate');
  assert.equal(composer.enter(key(), '   '), 'ignore', 'an empty message is not sent');

  composer.replying = true;
  assert.equal(composer.enter(key(), 'one more thing'), 'hold');
  assert.equal(composer.enter(key(), ''), 'ignore');

  assert.equal(composer.escape({ sheetOpen: true }), 'closeSheet');
  assert.equal(composer.escape({ sheetOpen: false }), 'stop');
  composer.replying = false;
  assert.equal(composer.escape({ sheetOpen: false }), 'none');
});
