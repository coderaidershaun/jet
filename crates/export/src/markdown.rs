//! A document as a Markdown file: the text as it was given, formulas between dollar signs.

use crate::Document;
use crate::document::one_line;

pub(crate) fn render(document: &Document) -> String {
    let mut parts = vec![format!("# {}", one_line(&document.title))];
    if !document.origin.is_empty() {
        parts.push(format!("> {}", one_line(&document.origin)));
    }
    parts.push(document.markdown.trim_end().to_owned());
    if !document.sources.is_empty() {
        let lines: Vec<String> = document
            .sources
            .iter()
            .map(|source| format!("- [{}] {}", source.number, one_line(&source.text)))
            .collect();
        parts.push(format!("## Sources\n\n{}", lines.join("\n")));
    }
    let mut text = parts.join("\n\n");
    text.push('\n');
    text
}
