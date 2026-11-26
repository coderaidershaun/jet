// Tests the browser's live words with a stand-in recognizer: a refused one does not count as supported.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveWords } from './live-words.js';

/** A recognizer that the test drives by hand, and that can be made to refuse to start. */
function fakeRecognition({ failToStart = false } = {}) {
  const made = [];
  globalThis.SpeechRecognition = class {
    constructor() { made.push(this); }
    start() { if (failToStart) throw new Error('refused'); }
    abort() {}
  };
  return made;
}

afterEach(() => { delete globalThis.SpeechRecognition; });

test('a browser with no recognizer, or one that refuses to run, does not count as giving live words', () => {
  assert.equal(createLiveWords({ onWords() {} }).supported, false);

  const blocked = fakeRecognition();
  const denied = createLiveWords({ onWords() {} });
  denied.start();
  assert.equal(denied.supported, true);
  blocked[0].onerror({ error: 'not-allowed' });
  assert.equal(denied.supported, false);

  fakeRecognition({ failToStart: true });
  const broken = createLiveWords({ onWords() {} });
  broken.start();
  assert.equal(broken.supported, false);
});
