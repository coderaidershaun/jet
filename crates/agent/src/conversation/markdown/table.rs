//! Writes each table cell's tag itself, so a column of numbers can be right-aligned with a class
//! instead of the inline style the page's content rules block.

use pulldown_cmark::{Event, Tag, TagEnd};

struct Cell {
    open_at: usize,
    in_head: bool,
    column: usize,
    text: String,
}

/// Replaces every cell tag with plain HTML, giving the `num` class to each column whose body
/// cells are all numbers.
pub(super) fn mark_number_columns(events: Vec<Event<'_>>) -> Vec<Event<'_>> {
    let mut out = Vec::with_capacity(events.len());
    let mut rest = events.into_iter();
    while let Some(event) = rest.next() {
        if !matches!(event, Event::Start(Tag::Table(_))) {
            out.push(event);
            continue;
        }
        let mut table = vec![event];
        for inner in rest.by_ref() {
            let ends = matches!(inner, Event::End(TagEnd::Table));
            table.push(inner);
            if ends {
                break;
            }
        }
        out.extend(write_cells(table));
    }
    out
}

fn write_cells(table: Vec<Event<'_>>) -> Vec<Event<'_>> {
    let mut out = Vec::with_capacity(table.len());
    let mut cells = Vec::new();
    let mut current: Option<Cell> = None;
    let (mut in_head, mut column) = (false, 0);
    for event in table {
        match &event {
            Event::Start(Tag::TableHead) => {
                in_head = true;
                column = 0;
            }
            Event::End(TagEnd::TableHead) => in_head = false,
            Event::Start(Tag::TableRow) => column = 0,
            Event::Start(Tag::TableCell) => {
                current = Some(Cell {
                    open_at: out.len(),
                    in_head,
                    column,
                    text: String::new(),
                });
                out.push(open_tag(in_head, false));
                continue;
            }
            Event::End(TagEnd::TableCell) => {
                cells.extend(current.take());
                column += 1;
                out.push(close_tag(in_head));
                continue;
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some(cell) = current.as_mut() {
                    cell.text.push_str(text);
                }
            }
            _ => {}
        }
        out.push(event);
    }

    let columns = cells.iter().map(|cell| cell.column + 1).max().unwrap_or(0);
    for column in (0..columns).filter(|&column| is_number_column(&cells, column)) {
        for cell in cells.iter().filter(|cell| cell.column == column) {
            out[cell.open_at] = open_tag(cell.in_head, true);
        }
    }
    out
}

/// A column of numbers: at least one body cell is filled in, and every filled-in one is a number.
fn is_number_column(cells: &[Cell], column: usize) -> bool {
    let mut filled = cells
        .iter()
        .filter(|cell| cell.column == column && !cell.in_head)
        .map(|cell| cell.text.trim())
        .filter(|text| !text.is_empty())
        .peekable();
    filled.peek().is_some() && filled.all(is_number)
}

/// An optional sign, an optional currency sign, a digit, more digits, commas or dots, and an
/// optional percent sign. "1,200.50", "-0.25", "$5" and "5%" are numbers; "n/a" is not.
fn is_number(text: &str) -> bool {
    let text = text.strip_prefix(['+', '-', '\u{2212}']).unwrap_or(text);
    let text = text.strip_prefix(['$', '€', '£', '¥']).unwrap_or(text);
    let text = text.strip_suffix('%').unwrap_or(text);
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_digit() || c == ',' || c == '.')
}

fn open_tag(in_head: bool, is_number: bool) -> Event<'static> {
    let tag = match (in_head, is_number) {
        (true, false) => "<th>",
        (true, true) => r#"<th class="num">"#,
        (false, false) => "<td>",
        (false, true) => r#"<td class="num">"#,
    };
    Event::InlineHtml(tag.into())
}

fn close_tag(in_head: bool) -> Event<'static> {
    Event::InlineHtml(if in_head { "</th>" } else { "</td>" }.into())
}
