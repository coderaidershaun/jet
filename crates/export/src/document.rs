//! What one exported file holds, and the kinds of file it can be written as. A document is not
//! tied to what its text is about: every file is a title, Markdown and the sources it cites.

/// The longest generated file name before its extension.
const FILE_NAME_LENGTH: usize = 80;
/// Most file systems allow at most this many bytes in one file name, and eighty letters of four
/// bytes each, such as emoji, would pass it.
const FILE_NAME_BYTES: usize = 255;

/// What one file holds, in the order it holds it.
#[derive(
    serde::Serialize,
    serde::Deserialize,
    Debug,
    Clone,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Default,
)]
pub struct Document {
    pub title: String,
    /// The one line under the title that says where the text comes from, such as the question it
    /// answers. Empty means no line.
    pub origin: String,
    /// CommonMark with GitHub tables, `$…$` and `$$…$$` formulas and footnote marks.
    pub markdown: String,
    /// The sources the text cites, listed at the end under "Sources". Empty means no list.
    pub sources: Vec<Source>,
}

/// The words of `text` on one line, with a single space between them.
pub(crate) fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(
    serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord,
)]
pub struct Source {
    pub number: usize,
    /// The document and the page as printed, such as "Hull, chapter 2: Options, p. 7 — Figure 2.1".
    pub text: String,
}

/// The kinds of file a document is written as. Written as `"pdf"`, `"markdown"` and `"html"`.
#[derive(
    serde::Serialize, serde::Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord,
)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Pdf,
    Markdown,
    Html,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Pdf => "pdf",
            Format::Markdown => "md",
            Format::Html => "html",
        }
    }

    /// Builds a file name with at most 80 characters before its extension and at most 255 bytes
    /// in all, removing forbidden characters. Uses `Document` when nothing is left.
    pub fn file_name(self, words: &str) -> String {
        let spaced: String = words
            .chars()
            .filter(|character| !r#"/\:*?"<>|"#.contains(*character))
            .map(|character| {
                if character.is_whitespace() {
                    ' '
                } else {
                    character
                }
            })
            .filter(|character| !character.is_control())
            .collect();
        let single_spaced = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
        let room = FILE_NAME_BYTES - ".".len() - self.extension().len();
        let cut: String = single_spaced
            .char_indices()
            .take(FILE_NAME_LENGTH)
            .take_while(|(at, character)| at + character.len_utf8() <= room)
            .map(|(_, character)| character)
            .collect();
        let stem = cut.trim_matches(|character: char| character == '.' || character == ' ');
        let stem = if stem.is_empty() { "Document" } else { stem };
        format!("{stem}.{}", self.extension())
    }
}
