// A small Markdown renderer for the browser fallback. The Rust side renders in
// the app; this one only has to be safe and good enough for a demo reply.
// Every character that could open a tag or an attribute is escaped first, and
// the output has no style attributes, so the page's content rules hold.
// Math is cut out before the Markdown is read and comes back as inert `.math`
// elements that carry the TeX, for the page to typeset. The rules are the ones
// the Rust renderer follows, and one shared set of cases checks both.

const SAFE_LINK = /^(https?:|mailto:)/i;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
// TeX keeps its apostrophes, which are part of the formula.
const escapeTex = (text) => text.replace(/[&<>"]/g, (c) => ESCAPES[c]);
const link = (whole, label, url) => (SAFE_LINK.test(url) ? '<a href="' + url + '" rel="noopener noreferrer">' + label + '</a>' : label);

function inline(text) {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part) => {
      if (/^`[^`\n]+`$/.test(part)) return '<code>' + escapeHtml(part.slice(1, -1)) + '</code>';
      return escapeHtml(part)
        .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, link)
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
    })
    .join('');
}

// Private-use characters that bracket a marker. A reply's own copies are replaced first, so every
// one that reaches the line loop was written by `protect`.
const OPEN = '\uE000';
const CLOSE = '\uE001';
const MARKER = /\uE000(\d+)\uE001/g;

const PAREN = { closer: ')', display: false };
const BRACKET = { closer: ']', display: true };
const DOLLARS = { closer: null, display: true };

const lineEnd = (text, from) => {
  const newline = text.indexOf('\n', from);
  return newline < 0 ? text.length : newline;
};
const isBlank = (text) => /^[ \t\r]*$/.test(text);

function runOf(text, from, char) {
  let end = from;
  while (text[end] === char) end++;
  return end - from;
}

// The fence a line opens: its character and length. An opening line made of backticks may not
// hold another backtick, or it is inline code.
function fenceOpening(text, lineStart) {
  const line = text.slice(lineStart, lineEnd(text, lineStart));
  const match = /^[ \t]*(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  const [indentAndFence, fence] = match;
  if (fence[0] === '`' && line.includes('`', indentAndFence.length)) return null;
  return { char: fence[0], length: fence.length };
}

// Just after the line that closes the fence, or the end of the text when it never closes (a reply
// cut off while streaming).
function fenceEnd(text, lineStart, { char, length }) {
  const closing = new RegExp('^[ \\t]*' + char + '{' + length + ',}[ \\t\\r]*$');
  let newline = lineEnd(text, lineStart);
  while (newline < text.length) {
    const start = newline + 1;
    const end = lineEnd(text, start);
    if (closing.test(text.slice(start, end))) return Math.min(end + 1, text.length);
    newline = end;
  }
  return text.length;
}

// True when the line after the newline at `newline` is blank or opens a code fence.
function paragraphBreakAfter(text, newline) {
  const start = newline + 1;
  const end = lineEnd(text, start);
  return (end < text.length && isBlank(text.slice(start, end))) || fenceOpening(text, start) !== null;
}

function codeSpanEnd(text, from, run) {
  for (let at = from; at < text.length; at++) {
    if (text[at] === '\n' && paragraphBreakAfter(text, at)) return null;
    if (text[at] !== '`') continue;
    const found = runOf(text, at, '`');
    if (found === run) return at + found;
    at += found - 1;
  }
  return null;
}

// The start and end of the closer of a formula whose content starts at `from`. A backslash pair
// is skipped whole, so `\\)` is not a closer. A paragraph break or the end of the text ends the
// search, and then `stop` says where.
function mathEnd(text, from, delimiter) {
  for (let at = from; at < text.length; at++) {
    if (text[at] === '\\' && at + 1 < text.length) {
      if (text[at + 1] === delimiter.closer) return { contentEnd: at, end: at + 2 };
      at++;
    } else if (delimiter === DOLLARS && text[at] === '$' && text[at + 1] === '$') {
      return { contentEnd: at, end: at + 2 };
    } else if (text[at] === '\n' && paragraphBreakAfter(text, at)) {
      return { stop: at };
    }
  }
  return { stop: text.length };
}

// Replaces each formula (`\( .. \)`, `\[ .. \]`, `$$ .. $$`) outside code with a marker. A single
// `$` is money, never math. A delimiter that does not open math also becomes a marker, so the
// Markdown rules cannot swallow its backslash.
function protect(reply) {
  const text = reply.replace(/[\uE000\uE001]/g, '\uFFFD');
  const markers = [];
  let out = '';
  let at = 0;
  // For each delimiter, where its last search for a closer ran out. A later opener of the same
  // kind before that point cannot close either, so a paragraph full of unclosed openers is
  // searched once and not once for each opener.
  const noCloserBefore = new Map();

  const copyTo = (end) => {
    out += text.slice(at, end);
    at = end;
  };
  const hold = (source, math) => {
    out += OPEN + markers.length + CLOSE;
    markers.push({ source, math });
  };
  const holdLiteral = () => {
    hold(text.slice(at, at + 2), null);
    at += 2;
  };
  const takeMath = (delimiter) => {
    if (at < (noCloserBefore.get(delimiter) ?? 0)) return false;
    const found = mathEnd(text, at + 2, delimiter);
    if (found.stop !== undefined) {
      noCloserBefore.set(delimiter, found.stop);
      return false;
    }
    const tex = text.slice(at + 2, found.contentEnd).trim();
    if (tex === '') return false;
    hold(text.slice(at, found.end), { tex, display: delimiter.display });
    at = found.end;
    return true;
  };

  while (at < text.length) {
    const opening = (at === 0 || text[at - 1] === '\n') && fenceOpening(text, at);
    if (opening) {
      copyTo(fenceEnd(text, at, opening));
    } else if (text[at] === '`') {
      const run = runOf(text, at, '`');
      copyTo(codeSpanEnd(text, at + run, run) ?? at + run);
    } else if (text[at] === '\\') {
      const next = text[at + 1];
      if (next === '(' || next === '[') {
        if (!takeMath(next === '(' ? PAREN : BRACKET)) holdLiteral();
      } else if (next === ')' || next === ']') {
        holdLiteral();
      } else {
        copyTo(Math.min(at + 2, text.length));
      }
    } else if (text[at] === '$' && text[at + 1] === '$') {
      if (!takeMath(DOLLARS)) copyTo(at + 2);
    } else {
      copyTo(at + 1);
    }
  }
  return { text: out, markers };
}

const NUMBER = /^[+\-\u2212]?[$€£¥]?\d[\d,.]*%?$/;
const withoutTags = (html) => html.replace(/<[^>]*>/g, '').trim();

// A column of numbers: at least one body cell is filled in, and every filled-in one is a number.
function isNumberColumn(cellHtml) {
  const filled = cellHtml.map(withoutTags).filter((text) => text !== '');
  return filled.length > 0 && filled.every((text) => NUMBER.test(text));
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\' && row[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (row[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += row[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

const isDelimiterRow = (cells) => cells.every((cell) => /^:?-+:?$/.test(cell));

// A table starts at a header row that holds a `|` when the next line is a delimiter row with the
// same number of cells. Returns the header cells, or null.
function tableHeader(line, nextLine) {
  if (nextLine === undefined || !line.includes('|') || !nextLine.includes('|')) return null;
  const header = splitRow(line);
  const delimiter = splitRow(nextLine);
  return delimiter.length === header.length && isDelimiterRow(delimiter) ? header : null;
}

function renderTable(header, rows) {
  const head = header.map(inline);
  const body = rows.map((row) => head.map((_, k) => inline(row[k] ?? '')));
  const numeric = head.map((_, k) => isNumberColumn(body.map((row) => row[k])));
  const cell = (tag, html, k) => '<' + tag + (numeric[k] ? ' class="num"' : '') + '>' + html + '</' + tag + '>';
  return '<table><thead><tr>' + head.map((html, k) => cell('th', html, k)).join('') + '</tr></thead><tbody>'
    + body.map((row) => '<tr>' + row.map((html, k) => cell('td', html, k)).join('') + '</tr>').join('')
    + '</tbody></table>';
}

function mathElement(tag, { tex, display }) {
  const escaped = escapeTex(tex);
  return '<' + tag + ' class="' + (display ? 'math math-display' : 'math') + '" data-tex="' + escaped + '">' + escaped + '</' + tag + '>';
}

// Puts the math back. Inside a tag or a code element the original source comes back, because the
// line rules here find code differently from `protect`.
function restore(html, markers) {
  const bare = (index) => {
    const { source, math } = markers[index];
    return math ? mathElement('span', math) : escapeHtml(source);
  };
  const sourceBack = (text) => text.replace(MARKER, (whole, index) => escapeHtml(markers[index].source));
  return html.replace(/<code[^>]*>[\s\S]*?<\/code>|<p>\uE000(\d+)\uE001<\/p>|<[^>]*>|\uE000(\d+)\uE001/g, (whole, alone, inText) => {
    if (alone !== undefined) {
      const { math } = markers[alone];
      return math && math.display ? mathElement('div', math) : '<p>' + bare(alone) + '</p>';
    }
    if (inText !== undefined) return bare(inText);
    return sourceBack(whole);
  });
}

/**
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdown(text) {
  const protectedText = protect(text.replace(/\r\n/g, '\n'));
  const lines = protectedText.text.split('\n');
  const out = [];
  let paragraph = [];
  let list = null;

  const endParagraph = () => {
    if (paragraph.length) out.push('<p>' + paragraph.map(inline).join('\n') + '</p>');
    paragraph = [];
  };
  const endList = () => {
    if (list) out.push('<' + list.tag + '>' + list.items.map((item) => '<li>' + inline(item) + '</li>').join('') + '</' + list.tag + '>');
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      endParagraph();
      endList();
      const code = [];
      while (++i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i]);
      const language = fence[1] ? ' class="language-' + fence[1].toLowerCase() + '"' : '';
      out.push('<pre><code' + language + '>' + escapeHtml(code.join('\n')) + '</code></pre>');
      continue;
    }
    const header = tableHeader(line, lines[i + 1]);
    if (header) {
      endParagraph();
      endList();
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim() !== ''; i++) rows.push(splitRow(lines[i]));
      i--;
      out.push(renderTable(header, rows));
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      endParagraph();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) endList();
      list = list || { tag, items: [] };
      list.items.push((bullet || numbered)[1]);
      continue;
    }
    endList();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      endParagraph();
      const level = Math.min(6, heading[1].length + 2);
      out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
    } else if (line.trim() === '') {
      endParagraph();
    } else {
      paragraph.push(line);
    }
  }
  endParagraph();
  endList();
  return restore(out.join(''), protectedText.markers);
}
