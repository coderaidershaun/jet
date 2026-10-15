import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderMarkdown } from './markdown.js';

const { vectors } = JSON.parse(readFileSync(new URL('./fixtures/math-vectors.json', import.meta.url), 'utf8'));

// Newlines beside a tag are only layout, and the two renderers lay them out differently.
const withoutLayoutNewlines = (html) => html.replace(/\n(?=<)|(?<=>)\n/g, '');

test('math and tables match the shared vectors, with no style attribute', () => {
  assert.ok(vectors.length > 0, 'the vector file holds no cases');
  for (const { name, markdown, html } of vectors) {
    const actual = withoutLayoutNewlines(renderMarkdown(markdown));
    assert.equal(actual, html, name);
    assert.doesNotMatch(actual, /<[^>]*\sstyle\s*=/, name);
  }
});
