//! Writing the documents Jet composes for the user: a PDF, a Markdown file or an HTML page.

use export::{Document, Format, Source};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{About, FileError, FileKind, Files, Origin};
use crate::store::ChatId;
use crate::store::UserId;

/// What the model asks for: the whole document as Markdown, written the way chat maths is
/// written, and the sources it cites in order.
#[derive(Debug, Deserialize)]
pub(crate) struct ExportRequest {
    pub format: Format,
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    pub markdown: String,
    #[serde(default)]
    pub sources: Vec<String>,
    /// One or two sentences on what the file is, kept as its note.
    #[serde(default)]
    pub context: Option<String>,
}

/// A file that has just been written, as the tool call gives it back.
#[derive(Debug, Serialize)]
pub(crate) struct SavedFile {
    pub id: Uuid,
    pub name: String,
    pub title: String,
    pub format: Format,
    pub bytes: u64,
}

impl Files {
    /// Writes the document and keeps it among the user's files. The renderer writes to a path, so
    /// the file is made in a private temporary folder that is gone when this returns.
    ///
    /// # Errors
    /// - [`FileError::Export`] when the renderer cannot make the file.
    /// - [`FileError::Scratch`] when the temporary folder cannot be used.
    /// - [`FileError::StoreFull`] when it would take the store past 2 GiB.
    /// - [`FileError::UserFull`] when it would take the user's files past their limit.
    pub fn export(
        &self,
        user: UserId,
        chat: ChatId,
        request: ExportRequest,
    ) -> Result<SavedFile, FileError> {
        let id = Uuid::new_v4();
        let format = request.format;
        let name = format.file_name(&request.title);
        let document = Document {
            title: request.title.clone(),
            origin: request.subtitle.unwrap_or_default(),
            markdown: agent::dollar_math(&request.markdown),
            sources: request
                .sources
                .into_iter()
                .enumerate()
                .map(|(index, text)| Source {
                    number: index + 1,
                    text,
                })
                .collect(),
        };
        let scratch = tempfile::tempdir().map_err(FileError::Scratch)?;
        let path = scratch.path().join(&name);
        export::write(&document, format, &path)?;
        let contents = std::fs::read(&path).map_err(FileError::Scratch)?;
        let kind = FileKind::of_name(&name).ok_or_else(|| FileError::Unsupported(name.clone()))?;
        let mut about = About::new(
            name.clone(),
            kind,
            &contents,
            Origin::Export,
            agent::now_ms(),
        );
        about.id = id;
        about.context = request
            .context
            .as_deref()
            .map(super::artifacts::cap_context)
            .unwrap_or_default();
        self.keep(user, Some(chat), &about, &contents)?;
        Ok(SavedFile {
            id,
            name,
            title: request.title,
            format,
            bytes: about.bytes,
        })
    }
}
