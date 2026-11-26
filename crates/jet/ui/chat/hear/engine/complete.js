// Reads the end of a heard phrase to say whether the thought is probably over. The recogniser may
// punctuate a phrase the speaker has not finished, so a trailing word that opens a thought wins
// over any end mark.

const CLOSERS = /["'”’»)\]]+$/;
const END_MARKS = /[.,?!…]+$/;
const OPEN_WORDS = new Set(['and', 'or', 'but', 'so', 'because', 'then', 'which', 'that', 'if', 'like', 'um', 'uh']);
const OPEN_PAIRS = new Set(['i mean', 'you know']);

function endsOpen(withoutMarks) {
  const words = withoutMarks.toLowerCase().split(/\s+/).filter(Boolean);
  const last = words.at(-1);
  if (last === undefined) return false;
  return OPEN_WORDS.has(last) || OPEN_PAIRS.has(words.slice(-2).join(' '));
}

// The recogniser may put a full stop after an unfinished phrase, which then looks complete and is sent after
// the short wait for a complete one. Speech that resumes reopens the turn, so only a slow speaker is cut off.
/**
 * @param {string} text   the words of the last utterance
 * @returns {'complete' | 'open' | 'neutral'}   a finished sentence, a thought that goes on, or no way to tell
 */
export function judge(text) {
  const trimmed = text.trim().replace(CLOSERS, '');
  if (endsOpen(trimmed.replace(END_MARKS, ''))) return 'open';
  if (/[,;:]$/.test(trimmed)) return 'open';
  if (END_MARKS.test(trimmed)) return 'complete';
  return 'neutral';
}
