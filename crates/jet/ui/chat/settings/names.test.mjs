import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fillName } from './names.js';

test('a named text takes the persona name wherever {name} stands', () => {
  assert.equal(fillName('How should {name} talk to you?', 'Neo'), 'How should Neo talk to you?');
  assert.equal(fillName("Reset to {name}'s coral", 'Jet'), "Reset to Jet's coral");
});
