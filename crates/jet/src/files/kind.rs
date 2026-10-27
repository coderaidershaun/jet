//! The kinds of file Jet keeps, found from the extension and checked against the first bytes.

use serde::{Deserialize, Serialize};

/// How much of a text file is searched for a NUL byte, which no text file has.
const TEXT_PROBE_BYTES: usize = 8 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// The kinds of file Jet writes and the kinds a user may attach.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FileKind {
    Pdf,
    Markdown,
    Html,
    Xlsx,
    Csv,
    Text,
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl FileKind {
    /// The kind a file name asks for, by its extension in any case.
    pub fn of_name(name: &str) -> Option<FileKind> {
        let (_, extension) = name.rsplit_once('.')?;
        Some(match extension.to_ascii_lowercase().as_str() {
            "pdf" => FileKind::Pdf,
            "md" | "markdown" => FileKind::Markdown,
            "html" | "htm" => FileKind::Html,
            "xlsx" => FileKind::Xlsx,
            "csv" => FileKind::Csv,
            "txt" => FileKind::Text,
            "png" => FileKind::Png,
            "jpg" | "jpeg" => FileKind::Jpeg,
            "gif" => FileKind::Gif,
            "webp" => FileKind::Webp,
            _ => return None,
        })
    }

    /// Whether the first bytes are what this kind starts with, so a renamed file is refused.
    pub fn matches(self, bytes: &[u8]) -> bool {
        match self {
            FileKind::Pdf => bytes.starts_with(b"%PDF-"),
            FileKind::Png => bytes.starts_with(PNG_SIGNATURE),
            FileKind::Jpeg => bytes.starts_with(b"\xff\xd8\xff"),
            FileKind::Gif => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
            FileKind::Webp => {
                bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
            }
            FileKind::Xlsx => bytes.starts_with(b"PK\x03\x04"),
            FileKind::Markdown | FileKind::Html | FileKind::Csv | FileKind::Text => {
                !bytes[..bytes.len().min(TEXT_PROBE_BYTES)].contains(&0)
            }
        }
    }

    /// The same word the kind has in JSON.
    pub fn word(self) -> &'static str {
        match self {
            FileKind::Pdf => "pdf",
            FileKind::Markdown => "markdown",
            FileKind::Html => "html",
            FileKind::Xlsx => "xlsx",
            FileKind::Csv => "csv",
            FileKind::Text => "text",
            FileKind::Png => "png",
            FileKind::Jpeg => "jpeg",
            FileKind::Gif => "gif",
            FileKind::Webp => "webp",
        }
    }

    /// The `Content-Type` of a download.
    pub fn download_type(self) -> &'static str {
        match self {
            FileKind::Pdf => "application/pdf",
            FileKind::Markdown => "text/markdown; charset=utf-8",
            FileKind::Html => "text/html; charset=utf-8",
            FileKind::Xlsx => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            FileKind::Csv => "text/csv; charset=utf-8",
            FileKind::Text => "text/plain; charset=utf-8",
            FileKind::Png => "image/png",
            FileKind::Jpeg => "image/jpeg",
            FileKind::Gif => "image/gif",
            FileKind::Webp => "image/webp",
        }
    }

    /// The `Content-Type` of a file opened in a tab. Markdown and CSV are sent as plain text,
    /// because a browser would save them instead of showing them.
    pub fn view_type(self) -> &'static str {
        match self {
            FileKind::Markdown | FileKind::Csv => "text/plain; charset=utf-8",
            other => other.download_type(),
        }
    }
}
