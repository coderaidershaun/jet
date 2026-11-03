//! Writing the documents Jet composes for the user: a PDF, a Markdown file or an HTML page.

use export::{Document, Format, Source};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{FileError, Files, io_error};

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
    /// Writes the document into a new folder. The file is written in a `.part` folder that is
    /// renamed when it is whole, so a crash never leaves a half-written file to be served.
    ///
    /// # Errors
    /// - [`FileError::Export`] when the renderer cannot make the file.
    /// - [`FileError::Io`] when the files folder cannot be used.
    pub fn export(&self, request: ExportRequest) -> Result<SavedFile, FileError> {
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
        let part = self.root.join(format!("{id}.part"));
        let folder = self.root.join(id.to_string());
        std::fs::create_dir_all(&part).map_err(io_error(&part))?;
        let written = export::write(&document, format, &part.join(&name))
            .map_err(FileError::from)
            .and_then(|()| std::fs::rename(&part, &folder).map_err(io_error(&folder)));
        if let Err(error) = written {
            // A `.part` folder is never served, so a failed clean-up leaves nothing to reach.
            let _ = std::fs::remove_dir_all(&part);
            return Err(error);
        }
        let saved = folder.join(&name);
        let bytes = std::fs::metadata(&saved).map_err(io_error(&saved))?.len();
        Ok(SavedFile {
            id,
            name,
            title: request.title,
            format,
            bytes,
        })
    }
}
