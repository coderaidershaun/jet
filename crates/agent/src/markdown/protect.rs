//! Cuts math out of a reply before the Markdown parser reads it, so the parser never rewrites a
//! formula. Each formula leaves a marker behind that stands for it until the events are restored.

// Private-use characters that bracket a marker. A reply's own copies are replaced first, so every
// one that reaches the parser was written here.
pub(super) const OPEN: char = '\u{E000}';
pub(super) const CLOSE: char = '\u{E001}';

/// The reply with its math cut out, and what each cut-out marker stands for.
pub(super) struct Protected {
    pub(super) text: String,
    pub(super) markers: Vec<Marker>,
}

pub(super) struct Marker {
    pub(super) source: String,
    /// `None` for a delimiter that did not open math; it comes back as the text it was.
    pub(super) math: Option<Math>,
}

pub(super) struct Math {
    pub(super) tex: String,
    pub(super) display: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Money {
    Plain,
    Escaped,
}

#[derive(Clone, Copy, PartialEq)]
enum Delimiter {
    Paren,
    Bracket,
    Dollars,
}

impl Delimiter {
    fn closer(self) -> Option<u8> {
        match self {
            Delimiter::Paren => Some(b')'),
            Delimiter::Bracket => Some(b']'),
            Delimiter::Dollars => None,
        }
    }

    fn is_display(self) -> bool {
        self != Delimiter::Paren
    }
}

impl Protected {
    /// Replaces each formula (`\( .. \)`, `\[ .. \]`, `$$ .. $$`) outside code with a marker. A
    /// single `$` is money, never math. A delimiter that does not open math also becomes a marker,
    /// so the parser cannot swallow its backslash.
    pub(super) fn new(text: &str) -> Protected {
        Protected::scan(text, Money::Plain)
    }

    /// Like [`Protected::new`], but each single `$` outside code is written as `\$` into the
    /// text, so a Markdown reader that reads `$` as math sees money.
    pub(super) fn with_money_escaped(text: &str) -> Protected {
        Protected::scan(text, Money::Escaped)
    }

    fn scan(text: &str, money: Money) -> Protected {
        let text = text.replace([OPEN, CLOSE], "\u{FFFD}");
        let mut scanner = Scanner {
            text: &text,
            bytes: text.as_bytes(),
            at: 0,
            out: String::with_capacity(text.len()),
            markers: Vec::new(),
            no_closer_before: [0; 3],
            money,
        };
        scanner.run();
        Protected {
            text: scanner.out,
            markers: scanner.markers,
        }
    }
}

/// Every special character is ASCII, so `at` only ever stops where a character starts.
struct Scanner<'t> {
    text: &'t str,
    bytes: &'t [u8],
    at: usize,
    out: String,
    markers: Vec<Marker>,
    /// For each delimiter, where its last search for a closer ran out. A later opener of the same
    /// kind before that point cannot close either, so a paragraph full of unclosed openers is
    /// searched once and not once for each opener.
    no_closer_before: [usize; 3],
    money: Money,
}

impl Scanner<'_> {
    fn run(&mut self) {
        while let Some(&byte) = self.bytes.get(self.at) {
            let starts_line = self.at == 0 || self.bytes[self.at - 1] == b'\n';
            if starts_line && self.copy_fence() {
                continue;
            }
            match byte {
                b'`' => self.copy_code_span(),
                b'\\' => self.backslash(),
                b'$' if self.bytes.get(self.at + 1) == Some(&b'$') => self.dollars(),
                b'$' if self.money == Money::Escaped => {
                    self.out.push_str("\\$");
                    self.at += 1;
                }
                _ => self.copy_to(self.at + self.width_at(self.at)),
            }
        }
    }

    fn backslash(&mut self) {
        match self.bytes.get(self.at + 1) {
            Some(b'(') => self.math_or_literal(Delimiter::Paren),
            Some(b'[') => self.math_or_literal(Delimiter::Bracket),
            Some(b')' | b']') => self.hold_literal(),
            Some(_) => self.copy_to(self.at + 1 + self.width_at(self.at + 1)),
            None => self.copy_to(self.at + 1),
        }
    }

    fn dollars(&mut self) {
        if !self.take_math(Delimiter::Dollars) {
            self.copy_to(self.at + 2);
        }
    }

    fn math_or_literal(&mut self, delimiter: Delimiter) {
        if !self.take_math(delimiter) {
            self.hold_literal();
        }
    }

    /// Turns the formula that opens at `at` into a marker. False when it never closes or is empty.
    fn take_math(&mut self, delimiter: Delimiter) -> bool {
        let kind = delimiter as usize;
        if self.at < self.no_closer_before[kind] {
            return false;
        }
        let content_start = self.at + 2;
        let (content_end, end) = match self.math_end(content_start, delimiter) {
            Ok(closer) => closer,
            Err(stop) => {
                self.no_closer_before[kind] = stop;
                return false;
            }
        };
        let text = self.text;
        let tex = text[content_start..content_end].trim();
        if tex.is_empty() {
            return false;
        }
        let math = Math {
            tex: tex.to_string(),
            display: delimiter.is_display(),
        };
        self.hold(&text[self.at..end], Some(math));
        self.at = end;
        true
    }

    /// The start and end of the closer of a formula whose content starts at `from`. A backslash
    /// pair is skipped whole, so `\\)` is not a closer. A paragraph break or the end of the text
    /// ends the search, and the error says where.
    fn math_end(&self, from: usize, delimiter: Delimiter) -> Result<(usize, usize), usize> {
        let mut at = from;
        while at < self.bytes.len() {
            match (self.bytes[at], self.bytes.get(at + 1)) {
                (b'\\', Some(&next)) => {
                    if Some(next) == delimiter.closer() {
                        return Ok((at, at + 2));
                    }
                    at += 2;
                    continue;
                }
                (b'$', Some(b'$')) if delimiter == Delimiter::Dollars => return Ok((at, at + 2)),
                (b'\n', _) if self.paragraph_break_after(at) => return Err(at),
                _ => {}
            }
            at += 1;
        }
        Err(self.bytes.len())
    }

    fn hold_literal(&mut self) {
        let text = self.text;
        self.hold(&text[self.at..self.at + 2], None);
        self.at += 2;
    }

    fn hold(&mut self, source: &str, math: Option<Math>) {
        self.out.push(OPEN);
        self.out.push_str(&self.markers.len().to_string());
        self.out.push(CLOSE);
        self.markers.push(Marker {
            source: source.to_string(),
            math,
        });
    }

    /// Copies a whole code fence. Anything inside is code, whatever its indentation.
    fn copy_fence(&mut self) -> bool {
        let Some(opening) = self.fence_opening(self.at) else {
            return false;
        };
        let end = self.fence_end(opening);
        self.copy_to(end);
        true
    }

    /// The fence a line opens: its character and length. An opening line made of backticks may
    /// not hold another backtick, or it is inline code.
    fn fence_opening(&self, line_start: usize) -> Option<(u8, usize)> {
        let line = &self.bytes[line_start..self.line_end(line_start)];
        let indent = indent_of(line);
        let fence = *line.get(indent).filter(|&&b| b == b'`' || b == b'~')?;
        let length = line[indent..].iter().take_while(|&&b| b == fence).count();
        let inline_code = fence == b'`' && line[indent + length..].contains(&b'`');
        (length >= 3 && !inline_code).then_some((fence, length))
    }

    /// Just after the line that closes the fence opened on the line at `at`, or the end of the
    /// text when it never closes (a reply cut off while streaming).
    fn fence_end(&self, (fence, length): (u8, usize)) -> usize {
        let mut newline = self.line_end(self.at);
        while newline < self.bytes.len() {
            let line_start = newline + 1;
            let line_end = self.line_end(line_start);
            let line = &self.bytes[line_start..line_end];
            let indent = indent_of(line);
            let run = line[indent..].iter().take_while(|&&b| b == fence).count();
            if run >= length && is_blank(&line[indent + run..]) {
                return (line_end + 1).min(self.bytes.len());
            }
            newline = line_end;
        }
        self.bytes.len()
    }

    /// Copies a code span whole, or just its opening backticks when nothing closes it.
    fn copy_code_span(&mut self) {
        let run = self.run_of(self.at, b'`');
        let after_run = self.at + run;
        let end = self.code_span_end(after_run, run).unwrap_or(after_run);
        self.copy_to(end);
    }

    fn code_span_end(&self, from: usize, run: usize) -> Option<usize> {
        let mut at = from;
        while at < self.bytes.len() {
            match self.bytes[at] {
                b'\n' if self.paragraph_break_after(at) => return None,
                b'`' => {
                    let found = self.run_of(at, b'`');
                    if found == run {
                        return Some(at + found);
                    }
                    at += found;
                    continue;
                }
                _ => {}
            }
            at += 1;
        }
        None
    }

    /// True when the line after the newline at `newline` is blank or opens a code fence.
    fn paragraph_break_after(&self, newline: usize) -> bool {
        let start = newline + 1;
        let end = self.line_end(start);
        let blank = end < self.bytes.len() && is_blank(&self.bytes[start..end]);
        blank || self.fence_opening(start).is_some()
    }

    fn line_end(&self, from: usize) -> usize {
        self.bytes[from..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(self.bytes.len(), |offset| from + offset)
    }

    fn run_of(&self, from: usize, byte: u8) -> usize {
        self.bytes[from..]
            .iter()
            .take_while(|&&b| b == byte)
            .count()
    }

    fn width_at(&self, at: usize) -> usize {
        self.text[at..].chars().next().map_or(0, char::len_utf8)
    }

    fn copy_to(&mut self, end: usize) {
        self.out.push_str(&self.text[self.at..end]);
        self.at = end;
    }
}

fn indent_of(line: &[u8]) -> usize {
    line.iter()
        .take_while(|&&b| b == b' ' || b == b'\t')
        .count()
}

/// A `\r` counts as blank because a Windows line end reaches the scanner unchanged.
fn is_blank(bytes: &[u8]) -> bool {
    bytes.iter().all(|&b| matches!(b, b' ' | b'\t' | b'\r'))
}
