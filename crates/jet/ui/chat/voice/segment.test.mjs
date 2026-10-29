import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segment, nextBatch, speechText } from './segment.js';

const FENCE = '```js\nlet a = 1. 2.\n```';

/** What each part holds, as text: silent parts and block openers are marked. */
function shown(text, finished) {
  return segment(text, finished).map((part) => (part.silent ? '~' : '') + (part.opensBlock ? '^' : '') + text.slice(part.start, part.end));
}

const CASES = [
  // [name, text, finished, parts]
  ['sentences settle when the next one starts', 'Hello there. How are you? Fine.', false, ['^Hello there.', 'How are you?']],
  ['the last sentence settles when the reply is finished', 'Hello there. How are you? Fine.', true, ['^Hello there.', 'How are you?', 'Fine.']],
  ['a closed paragraph settles', 'One.\n\nTwo. Three', false, ['^One.', '^Two.']],
  ['a bold run is never cut', '**Bold. Still bold.** After. More', false, ['^**Bold. Still bold.**', 'After.']],
  ['an open bold run waits', '**Bold. Still bold', false, []],
  ['code spans, links and TeX are never cut', 'Use `a. b` now. See [Link. Text](https://x.example/a.b) too. It is \\(x. y\\) here. Next', false, ['^Use `a. b` now.', 'See [Link. Text](https://x.example/a.b) too.', 'It is \\(x. y\\) here.']],
  ['decimals and abbreviations are not sentence ends', 'Pi is 3.14. Dr. Smith (e.g. Bob) agrees, etc. Done. Last', false, ['^Pi is 3.14.', 'Dr. Smith (e.g. Bob) agrees, etc. Done.']],
  ['a closing quote or bracket belongs to its sentence', 'He said "go." Then left (quickly.) Done. Last', false, ['^He said "go."', 'Then left (quickly.)', 'Done.']],
  ['an emphasised sentence end settles after the closing mark', '*Done.* Next sentence. More', false, ['^*Done.*', 'Next sentence.']],
  ['a code fence is one silent part, whole', `Intro.\n\n${FENCE}\n\nOutro. Last`, false, ['^Intro.', `~^${FENCE}`, '^Outro.']],
  ['a fence still open waits, and is whole once the reply is finished', 'Intro.\n\n```js\nlet a', false, ['^Intro.']],
  ['a fence cut off by the end of the reply is silent', 'Intro.\n\n```js\nlet a', true, ['^Intro.', '~^```js\nlet a']],
  ['a table, a rule and display math are silent parts', '| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n$$x. y$$\n\n\\[\nz\n\\]\n\nEnd.', true, ['~^| a | b |\n|---|---|\n| 1 | 2 |', '~^---', '~^$$x. y$$', '~^\\[\nz\n\\]', '^End.']],
  ['a heading is one part', '# Title. With a dot\n\nBody. More', false, ['^# Title. With a dot', '^Body.']],
  ['a heading still being written waits', '# Titl', false, []],
  ['list items open blocks, and the marker is not a sentence end', '1. First. Second.\n2. Third\n- Fourth', true, ['^1. First.', 'Second.', '^2. Third', '^- Fourth']],
  ['a quote is prose', '> It is quoted. And more.\n\nAfter.', true, ['^> It is quoted.', 'And more.', '^After.']],
  ['an indented continuation joins its paragraph', 'First line\n  and the second. Third', false, ['^First line\n  and the second.']],
];

test('parts settle at sentence ends and keep formatted runs and silent blocks whole', () => {
  for (const [name, text, finished, expected] of CASES) {
    assert.deepEqual(shown(text, finished), expected, name);
  }

  // The weights of a part's marks: spoken letters and digits, a pause after punctuation, nothing for a URL.
  const text = 'Hello **big world**, see [the docs](https://example.com/x) at https://example.com now. Next';
  const [part] = segment(text, false);
  assert.deepEqual(part.marks.map((mark) => [text.slice(0, mark.end).split(' ').at(-1), mark.weight]), [
    ['Hello', 5], ['world**,', 8 + 3], ['see', 3], ['docs](https://example.com/x)', 7], ['at', 2], ['https://example.com', 0], ['now.', 3 + 6],
  ]);
  assert.equal(segment('# Title\n\nBody.', false)[0].marks.length, 1, 'a heading shows whole');

  // The settled parts of a prefix are the first parts of the whole text, in the same order, so a part never changes as the text grows.
  const documents = [...CASES.map((entry) => entry[1]), text, 'a **b *c* d** e. `x` f? [g](h). \\(i\\). ***j*** k! Done.'];
  for (const full of documents) {
    const whole = segment(full, true);
    for (let length = 0; length <= full.length; length++) {
      const settled = segment(full.slice(0, length), false);
      assert.deepEqual(settled, whole.slice(0, settled.length), JSON.stringify(full.slice(0, length)));
    }
  }
});

test('the first batch is one sentence and later batches hold at most two', () => {
  const long = 'Long sentence '.repeat(10) + 'ends.';
  const text = `One. Two. Three. Four.\n\n\`\`\`\ncode\n\`\`\`\n\nFive. Six.\n\n${long} Short. ${long.replace('ends.', 'also ends.')} ${long}`;
  const parts = segment(text, true);
  const batches = [];
  for (let from = 0, first = true; from < parts.length;) {
    const batch = nextBatch(parts, from, first);
    batches.push(batch.silent ? '~' : speechText(text, parts, from, batch.to));
    first = first && batch.silent;
    from = batch.to;
  }
  assert.deepEqual(batches.slice(0, 5), ['One.', 'Two. Three.', 'Four.', '~', 'Five. Six.']);
  const prose = batches.slice(5);
  assert.equal(prose[0], `${long} Short.`, 'two sentences that fit in 200 characters go together');
  assert.deepEqual(prose.slice(1), [long.replace('ends.', 'also ends.'), long], 'two long sentences do not');
  assert.equal(speechText('  - one\n    two\n\tthree', [{ start: 0, end: 22 }], 0, 1), '- one\ntwo\nthree', 'an indented line is not read as code');
});
