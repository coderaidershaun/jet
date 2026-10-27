//! Excel workbooks (`.xlsx` only): the size of each sheet, and the rows of one sheet as CSV
//! lines. Cells are streamed one at a time and counted against a budget, so a huge sheet is never
//! held whole.

use std::io::Cursor;

use calamine::{Data, DataRef, Reader, Xlsx};

use super::excerpt::{Excerpt, Wanted};
use super::text::{cleaned, counted, grouped};
use super::{ReadError, Reading, Unit};

/// The cells of a workbook that will be looked at before giving up on its size.
const CELL_BUDGET: usize = 2_000_000;
const NAMED_SHEETS: usize = 5;
const MAX_SHEET_NAMES: usize = 50;
const SHEET_NAME_CHARS: usize = 31;

fn workbook(bytes: &[u8]) -> Result<Xlsx<Cursor<&[u8]>>, ReadError> {
    Ok(calamine::open_workbook_from_rs(Cursor::new(bytes))?)
}

/// A sheet name as it is shown: cleaned and cut short.
fn sheet_title(name: &str) -> String {
    cleaned(name, SHEET_NAME_CHARS)
}

/// `3 sheets: Prices 1,204 × 6, Notes 12 × 2, Q3 40 × 9`.
pub(super) fn describe(bytes: &[u8]) -> Result<String, ReadError> {
    let mut workbook = workbook(bytes)?;
    let names = workbook.sheet_names();
    let mut budget = CELL_BUDGET;
    let mut named = Vec::new();
    for name in names.iter().take(NAMED_SHEETS) {
        let title = sheet_title(name);
        match sheet_size(&mut workbook, name, &mut budget)? {
            Some((rows, columns)) => {
                named.push(format!("{title} {} × {}", grouped(rows), grouped(columns)))
            }
            None => named.push(format!("{title} over {} cells", grouped(CELL_BUDGET))),
        }
    }
    let more = match names.len().saturating_sub(NAMED_SHEETS) {
        0 => String::new(),
        left => format!(", and {left} more"),
    };
    Ok(format!(
        "{}: {}{more}",
        counted(names.len(), "sheet"),
        named.join(", ")
    ))
}

/// The rows and columns of a sheet, counting the cells that hold something, or `None` when the
/// budget of cells for the whole workbook runs out first.
fn sheet_size(
    workbook: &mut Xlsx<Cursor<&[u8]>>,
    name: &str,
    budget: &mut usize,
) -> Result<Option<(usize, usize)>, ReadError> {
    let (mut rows, mut columns) = (0, 0);
    let mut cells = workbook.worksheet_cells_reader(name)?;
    while let Some(cell) = cells.next_cell()? {
        if *budget == 0 {
            return Ok(None);
        }
        *budget -= 1;
        if matches!(cell.get_value(), DataRef::Empty) {
            continue;
        }
        let (row, column) = cell.get_position();
        rows = rows.max(row as usize + 1);
        columns = columns.max(column as usize + 1);
    }
    Ok(Some((rows, columns)))
}

/// The rows of one sheet, the first unless `sheet` names another, with the sheet names beside them.
pub(super) fn read(
    bytes: &[u8],
    sheet: Option<&str>,
    wanted: Wanted,
) -> Result<Reading, ReadError> {
    let mut workbook = workbook(bytes)?;
    let names = workbook.sheet_names();
    let name = find_sheet(&names, sheet)?;
    let mut rows: std::collections::BTreeMap<u32, Vec<(u32, String)>> = Default::default();
    let mut total = 0;
    let mut seen = 0;
    let mut cells = workbook.worksheet_cells_reader(&name)?;
    while let Some(cell) = cells.next_cell()? {
        seen += 1;
        if seen > CELL_BUDGET {
            break;
        }
        let (row, column) = cell.get_position();
        if matches!(cell.get_value(), DataRef::Empty) {
            continue;
        }
        total = total.max(row as usize + 1);
        if wanted.holds(row as usize + 1) {
            rows.entry(row)
                .or_default()
                .push((column, cell_text(cell.get_value())));
        }
    }
    let mut excerpt = Excerpt::new(wanted);
    for number in (wanted.start..=total).take(wanted.count) {
        let line = rows
            .get(&(number as u32 - 1))
            .map_or_else(String::new, |cells| row_line(cells));
        excerpt.push(number, "\n", &line);
    }
    let sheets = names
        .iter()
        .take(MAX_SHEET_NAMES)
        .map(|name| sheet_title(name))
        .collect();
    Ok(excerpt.into_reading(Unit::Rows, total, sheets))
}

/// The sheet asked for by its name or by its shown title, or the first when none is asked for.
fn find_sheet(names: &[String], sheet: Option<&str>) -> Result<String, ReadError> {
    let found = match sheet {
        None => names.first(),
        Some(asked) => names
            .iter()
            .find(|name| name.as_str() == asked || sheet_title(name) == asked),
    };
    found.cloned().ok_or_else(|| ReadError::NoSuchSheet {
        asked: sheet.unwrap_or_default().to_owned(),
        sheets: names
            .iter()
            .map(|name| format!("{:?}", sheet_title(name)))
            .collect::<Vec<_>>()
            .join(", "),
    })
}

/// The cells of a row as one CSV line, with the gaps between them left empty.
fn row_line(cells: &[(u32, String)]) -> String {
    let mut line = String::new();
    let mut column = 0;
    for (at, text) in cells {
        for _ in column..*at {
            line.push(',');
        }
        column = *at;
        if text.contains([',', '"', '\n', '\r']) {
            line.push('"');
            line.push_str(&text.replace('"', "\"\""));
            line.push('"');
        } else {
            line.push_str(text);
        }
    }
    line
}

fn cell_text(value: &DataRef<'_>) -> String {
    match value {
        DataRef::Int(number) => number.to_string(),
        DataRef::Float(number) => number.to_string(),
        DataRef::String(text) => text.clone(),
        DataRef::SharedString(text) => (*text).to_owned(),
        DataRef::Bool(flag) => flag.to_string(),
        DataRef::DateTime(date) => Data::DateTime(*date).to_string(),
        DataRef::DateTimeIso(text) | DataRef::DurationIso(text) => text.clone(),
        DataRef::Error(error) => error.to_string(),
        DataRef::Empty => String::new(),
    }
}
