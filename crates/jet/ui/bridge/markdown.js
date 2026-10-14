// A small Markdown renderer for the browser fallback. The Rust side renders in
// the app; this one only has to be safe and good enough for a demo reply.
// Every character that could open a tag or an attribute is escaped first, and
// the output has no style attributes, so the page's content rules hold.

const SAFE_LINK = /^(https?:|mailto:)/i;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
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

/**
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdown(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
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
  return out.join('');
}
