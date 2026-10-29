// Cuts a streaming reply into the sentences, headings and silent blocks that Jet speaks one at a
// time, and marks where each word ends. A part is returned only once its end cannot change, so a
// part found while the reply streams is also a part of the finished reply.
//
// SMELL: indented code, headings underlined with = or -, and tables with no leading | are not
// recognised. A wrong cut costs only a pause, but indented code is read aloud. Replies from the
// model fence their code, so this is accepted.

const MAX_BATCH_CHARACTERS = 200;
const PAUSE_AFTER_SENTENCE = 6;
const PAUSE_AFTER_COMMA = 3;
const ABBREVIATIONS = new Set(['e.g.', 'i.e.', 'etc.', 'vs.', 'mr.', 'mrs.', 'ms.', 'dr.', 'st.']);

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MATH = /^ {0,3}(\$\$|\\\[)/;
const TABLE = /^ {0,3}\|/;
const HEADING = /^ {0,3}#{1,6}[ \t]+/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/**
 * @typedef {{ end: number, weight: number }} Mark   a word, or a formatted run, that ends at `end`
 * @typedef {{ start: number, end: number, silent: boolean, opensBlock: boolean, marks: Mark[] }} Part
 * @typedef {{ tag: string, weight: number }} Cue   a vocal tag such as `<laugh>`, and the letters of time the voice takes to perform it
 */

/**
 * @param {string} text
 * @param {boolean} finished   no more text will come, so the last part is settled too
 * @param {Cue[]} [cues]   the server's list of vocal cues; a listed cue takes time and shows no letters
 * @returns {Part[]}
 */
export function segment(text, finished, cues = []) {
  return blocksOf(text, cues).flatMap((block) => partsOf(text, block, finished, cues));
}

/** The text without the listed cues, for a screen reader that would read `<laugh>` out. */
export function withoutCues(text, cues) {
  if (cues.length === 0) return text;
  const tags = cues.map((cue) => cue.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text.replace(new RegExp(`[ \\t]?(?:${tags.join('|')})`, 'g'), '');
}

// SMELL: a part is never split, so a part too long for one request (about a thousand characters,
// or the server's limit of 2,000) always fails and shows without sound. Two in a row end the voice.
/**
 * The next piece to send to the voice: a silent part alone, otherwise one sentence for the first
 * piece of a reply and at most two sentences of one block after that.
 * @param {Part[]} parts
 * @param {number} from   index of the first part that is not in a batch yet
 * @param {boolean} isFirst   no spoken batch has been made yet
 * @returns {{ to: number, silent: boolean }}   the batch is parts[from] up to, not including, parts[to]
 */
export function nextBatch(parts, from, isFirst) {
  if (parts[from].silent) return { to: from + 1, silent: true };
  let to = from + 1;
  while (!isFirst && to < parts.length && to - from < 2 && joins(parts, from, to)) to++;
  return { to, silent: false };
}

function joins(parts, from, to) {
  const next = parts[to];
  return !next.silent && !next.opensBlock && next.end - parts[from].start <= MAX_BATCH_CHARACTERS;
}

/** The Markdown of parts[from] to parts[to - 1], without the indentation that would read as code. */
export function speechText(text, parts, from, to) {
  return text
    .slice(parts[from].start, parts[to - 1].end)
    .split('\n')
    .map((line) => line.trimStart())
    .join('\n');
}

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isLetterOrDigit = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isPunctuation = (c) => c !== undefined && /[\p{P}\p{S}]/u.test(c);

function linesOf(text) {
  const lines = [];
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    lines.push({ start, end, complete: newline !== -1 });
    start = end + 1;
  }
  return lines;
}

function firstNonSpace(text, from, to) {
  while (from < to && isSpace(text[from])) from++;
  return from;
}

function trimEnd(text, from, to) {
  while (to > from && isSpace(text[to - 1])) to--;
  return to;
}

/** The kind of block a line starts, or null when the line only continues a paragraph. */
function startOf(line, complete) {
  if (FENCE.test(line)) return 'fence';
  if (MATH.test(line)) return 'math';
  if (TABLE.test(line)) return 'table';
  if (HEADING.test(line)) return 'heading';
  if (complete && RULE.test(line)) return 'rule';
  if (QUOTE.test(line)) return 'quote';
  if (ITEM.test(line)) return 'item';
  return null;
}

function contentStartOf(kind, line) {
  const pattern = { heading: HEADING, quote: QUOTE, item: ITEM }[kind];
  return pattern ? pattern.exec(line)[0].length : firstNonSpace(line, 0, line.length);
}

const CONTINUES = new Set(['paragraph', 'item', 'quote']);

/** True when the line holds only listed cues and spaces. */
function isCueLine(line, cues) {
  let rest = line.trim();
  if (rest === '' || cues.length === 0) return false;
  while (rest !== '') {
    const cue = cues.find(({ tag }) => rest.startsWith(tag));
    if (!cue) return false;
    rest = rest.slice(cue.tag.length).trimStart();
  }
  return true;
}

// SMELL: this copies the server's rule that a line of only cues joins the next line with words, so that
// Markdown does not read it as an HTML block. The server's other rule, joining the line before when none
// follows, is not copied, because that line may already be spoken. So a cue line before a code fence, or
// at the very end, is its own part and is not performed.
/**
 * @returns {{ kind: string, start: number, end: number, contentStart: number, closed: boolean, awaitingWords: boolean }[]}
 *   `closed` is true when nothing more can join the block; `awaitingWords` is true while the block is only cues
 */
function blocksOf(text, cues) {
  const blocks = [];
  let open = null;
  let ending = null;
  for (const line of linesOf(text)) {
    const lineText = text.slice(line.start, line.end);
    if (ending) {
      open.end = line.end;
      if (ending(lineText, line.complete)) {
        open.closed = true;
        open = ending = null;
      }
      continue;
    }
    if (line.complete && lineText.trim() === '') {
      if (open?.awaitingWords) continue;
      if (open) open.closed = true;
      open = null;
      continue;
    }
    if (open?.awaitingWords && !FENCE.test(lineText)) {
      open.end = line.end;
      open.awaitingWords = line.complete && isCueLine(lineText, cues);
      continue;
    }
    const kind = startOf(lineText, line.complete);
    const continues = kind === null ? CONTINUES.has(open?.kind) : kind === open?.kind && (kind === 'table' || kind === 'quote');
    if (continues) {
      open.end = line.end;
      continue;
    }
    if (open) open.closed = true;
    open = {
      kind: kind ?? 'paragraph',
      start: firstNonSpace(text, line.start, line.end),
      end: line.end,
      contentStart: line.start + contentStartOf(kind, lineText),
      closed: false,
      awaitingWords: kind === null && line.complete && isCueLine(lineText, cues),
    };
    blocks.push(open);
    if (kind === 'heading' || kind === 'rule') {
      open.closed = line.complete;
      open = null;
    } else if (kind === 'fence') {
      const fence = FENCE.exec(lineText)[1];
      const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
      ending = (later, complete) => complete && closing.test(later);
    } else if (kind === 'math') {
      const opener = MATH.exec(lineText)[1];
      const closer = opener === '$$' ? '$$' : '\\]';
      ending = (later, complete) => complete && later.includes(closer);
      if (line.complete && lineText.slice(lineText.indexOf(opener) + 2).includes(closer)) {
        open.closed = true;
        open = ending = null;
      }
    }
  }
  return blocks;
}

const isSilent = (kind) => kind === 'fence' || kind === 'math' || kind === 'table' || kind === 'rule';

function partsOf(text, block, finished, cues) {
  const closed = block.closed || finished;
  if (isSilent(block.kind)) return closed ? [silentPart(text, block)] : [];
  if (block.kind === 'heading') return closed ? [headingPart(text, block, cues)] : [];
  return proseParts(text, block, closed, cues);
}

function silentPart(text, block) {
  const end = trimEnd(text, block.start, block.end);
  return { start: block.start, end, silent: true, opensBlock: true, marks: [{ end, weight: 0 }] };
}

/** A heading shows whole, so it has one mark, and the voice pauses after it. */
function headingPart(text, block, cues) {
  const end = trimEnd(text, block.start, block.end);
  const units = scanUnits(text, block.contentStart, end, cues);
  const spoken = units.reduce((sum, unit) => sum + unit.weight, 0);
  const pause = units.length > 0 && units.at(-1).pause === 0 ? PAUSE_AFTER_SENTENCE : 0;
  return { start: block.start, end, silent: false, opensBlock: true, marks: [{ end, weight: spoken + pause }] };
}

function proseParts(text, block, closed, cues) {
  const units = scanUnits(text, block.contentStart, trimEnd(text, block.start, block.end), cues);
  // The voice pauses after a list item even when it has no end mark.
  if (closed && block.kind === 'item' && units.length > 0 && units.at(-1).pause === 0) units.at(-1).weight += PAUSE_AFTER_SENTENCE;
  const parts = [];
  let first = 0;
  const cut = (last) => {
    const group = units.slice(first, last + 1);
    const opensBlock = parts.length === 0;
    parts.push({
      start: opensBlock ? block.start : group[0].start,
      end: group.at(-1).end,
      silent: false,
      opensBlock,
      marks: group.map(({ end, weight }) => ({ end, weight })),
    });
    first = last + 1;
  };
  units.forEach((unit, index) => {
    if (unit.endsSentence && index < units.length - 1) cut(index);
  });
  if (closed && first < units.length) cut(units.length - 1);
  return parts;
}

/** A unit is one word, or a whole formatted run with what touches it: `**big world**,` is one unit, and so is a link. */
function scanUnits(text, from, to, cues) {
  const units = [];
  let i = from;
  while (i < to) {
    if (isSpace(text[i])) {
      i++;
      continue;
    }
    const start = i;
    const weigher = createWeigher();
    while (i < to && !isSpace(text[i])) i = step(text, i, to, weigher, cues);
    const word = text.slice(start, i);
    const pause = pauseAfter(word);
    units.push({ start, end: i, weight: weigher.total() + pause, pause, endsSentence: endsSentence(word) });
  }
  return units;
}

/** Moves past one character or one whole construct, and counts what is spoken in it. */
function step(text, i, to, weigher, cues) {
  const found = constructAt(text, i, to, cues);
  if (found) {
    weigher.construct(text, found, cues);
    return found.end;
  }
  if (text[i] === '\\' && i + 1 < to) {
    weigher.plain(text[i + 1]);
    return i + 2;
  }
  weigher.plain(text[i]);
  return i + 1;
}

// SMELL: these rules copy the server's rules for what is spoken, so a change there must be made here too.
/** Counts the letters and digits that are spoken: not those of a web address, a `[1]` marker or a link's address. */
function createWeigher() {
  let weight = 0;
  let pending = '';
  const settle = () => {
    for (const word of pending.replace(/\[[\d,-]+\]/g, '').split(/\s+/)) {
      if (!word.includes('://') && !/^[^\p{L}\p{N}]*www\./u.test(word)) weight += (word.match(/[\p{L}\p{N}]/gu) ?? []).length;
    }
    pending = '';
  };
  return {
    plain(c) {
      pending += c;
    },
    construct(text, found, cues) {
      settle();
      weight += constructWeight(text, found, cues);
    },
    total() {
      settle();
      return weight;
    },
  };
}

function weighRegion(text, from, to, cues) {
  const weigher = createWeigher();
  for (let i = from; i < to;) i = step(text, i, to, weigher, cues);
  return weigher.total();
}

function constructWeight(text, found, cues) {
  switch (found.kind) {
    case 'code':
    case 'math': {
      const inner = text.slice(found.from, found.to);
      return /^[\p{L}\p{N} -]+$/u.test(inner) ? (inner.match(/[\p{L}\p{N}]/gu) ?? []).length : 0;
    }
    case 'emphasis':
    case 'link':
      return weighRegion(text, found.from, found.to, cues);
    case 'cue':
      return found.weight;
    default:
      return 0;
  }
}

/** The word without the quotes, brackets and emphasis marks that close it. */
const coreOf = (word) => word.replace(/["'”’)\]}»*_~`]+$/u, '');

function pauseAfter(word) {
  const last = coreOf(word).at(-1);
  if (last !== undefined && '.!?…'.includes(last)) return PAUSE_AFTER_SENTENCE;
  if (last !== undefined && ',;:–—'.includes(last)) return PAUSE_AFTER_COMMA;
  return 0;
}

function endsSentence(word) {
  const core = coreOf(word);
  if (!/[.!?]$/.test(core)) return false;
  return !ABBREVIATIONS.has(core.replace(/^[^\p{L}]+/u, '').toLowerCase());
}

/**
 * A formatted run, code span, link or TeX that starts at `i`. One that never closes runs to the
 * end of the block, so it holds the rest of the block back.
 * @returns {{ end: number, kind: string, from?: number, to?: number } | null}
 *   `from` and `to` mark what is inside; null when the character starts no construct
 */
function constructAt(text, i, to, cues) {
  const c = text[i];
  if (c === '<') return cueAt(text, i, to, cues);
  if (c === '`') return codeAt(text, i, to);
  if (c === '\\' && (text[i + 1] === '(' || text[i + 1] === '[')) return mathAt(text, i, to, text[i + 1] === '(' ? '\\)' : '\\]');
  if (c === '$' && text[i + 1] === '$') return mathAt(text, i, to, '$$');
  if (c === '!' && text[i + 1] === '[') {
    const link = linkAt(text, i + 1, to);
    return link && { end: link.end, kind: 'image' };
  }
  if (c === '[') return linkAt(text, i, to);
  if (c === '*' || c === '_') return emphasisAt(text, i, to);
  return null;
}

/** A listed cue that starts at `i` and ends inside the block. A cue still arriving is not one yet. */
function cueAt(text, i, to, cues) {
  const cue = cues.find(({ tag }) => i + tag.length <= to && text.startsWith(tag, i));
  return cue ? { end: i + cue.tag.length, kind: 'cue', weight: cue.weight } : null;
}

function runOf(text, i, to, c) {
  let length = 1;
  while (i + length < to && text[i + length] === c) length++;
  return length;
}

function codeAt(text, i, to) {
  const length = runOf(text, i, to, '`');
  for (let j = i + length; j < to;) {
    if (text[j] !== '`') {
      j++;
      continue;
    }
    const found = runOf(text, j, to, '`');
    if (found === length) return { end: j + found, kind: 'code', from: i + length, to: j };
    j += found;
  }
  return { end: to, kind: 'code', from: i + length, to };
}

function mathAt(text, i, to, closer) {
  const at = text.indexOf(closer, i + 2);
  return at !== -1 && at + closer.length <= to
    ? { end: at + closer.length, kind: 'math', from: i + 2, to: at }
    : { end: to, kind: 'math', from: i + 2, to };
}

/** `[text](address)`. A `[` that closes without an address is just a bracket, and null. */
function linkAt(text, i, to) {
  let depth = 0;
  let close = i;
  for (; close < to; close++) {
    if (text[close] === '\\') close++;
    else if (text[close] === '[') depth++;
    else if (text[close] === ']' && --depth === 0) break;
  }
  if (close >= to) return { end: to, kind: 'link', from: i + 1, to };
  // A `]` at the very end may still gain an address, so it holds the rest like an open link.
  if (close + 1 >= to) return { end: to, kind: 'link', from: i + 1, to: close };
  if (text[close + 1] !== '(') return null;
  let parens = 1;
  let end = close + 2;
  for (; end < to; end++) {
    if (text[end] === '\\') end++;
    else if (text[end] === '(') parens++;
    else if (text[end] === ')' && --parens === 0) break;
  }
  return { end: Math.min(end + 1, to), kind: 'link', from: i + 1, to: close };
}

function emphasisAt(text, i, to) {
  const c = text[i];
  const length = runOf(text, i, to, c);
  const before = text[i - 1];
  const after = i + length < to ? text[i + length] : undefined;
  // Close to CommonMark: a run opens before a word and closes after one, and `_` never does either inside a word.
  const opens = after !== undefined && !isSpace(after) && !(isPunctuation(after) && isLetterOrDigit(before)) && (c === '*' || !isLetterOrDigit(before));
  if (length > 3 || !opens) return { end: i + length, kind: 'mark' };
  for (let j = i + length; j < to;) {
    if (text[j] === '\\') {
      j += 2;
    } else if (text[j] === '`') {
      j = codeAt(text, j, to).end;
    } else if (text[j] === c) {
      const found = runOf(text, j, to, c);
      const next = j + found < to ? text[j + found] : undefined;
      const closes = found === length && !isSpace(text[j - 1]) && (c === '*' || !isLetterOrDigit(next));
      if (closes) return { end: j + found, kind: 'emphasis', from: i + length, to: j };
      j += found;
    } else {
      j++;
    }
  }
  return { end: to, kind: 'emphasis', from: i + length, to };
}
