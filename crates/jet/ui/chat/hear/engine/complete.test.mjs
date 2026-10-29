import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from './complete.js';

test('the ending of the words decides how long the send waits', () => {
  const endings = [
    ['What time is it in Lisbon?', 'complete'],
    ['Yes.', 'complete'],
    ['Stop it!', 'complete'],
    ['Well…', 'complete'],
    ['He said "go home."', 'complete'],
    ['(see the notes.)', 'complete'],
    ['I was wondering about,', 'open'],
    ['First this;', 'open'],
    ['Here is the list:', 'open'],
    ['I like cats and', 'open'],
    ['I like cats and,', 'open'],
    ['I think so.', 'open'],
    ['Um…', 'open'],
    ['It was, you know', 'open'],
    ['Right, I mean.', 'open'],
    ['Check the one that', 'open'],
    ['Open the file if', 'open'],
    ['open the Settings', 'neutral'],
    ['the time in Lisbon', 'neutral'],
    ['', 'neutral'],
  ];
  for (const [text, expected] of endings) assert.equal(judge(text), expected, text);
});
