//! Keeps the files Jet writes for the user to download, one folder for each file, under the data
//! directory until the user forgets the conversation.

use std::path::{Path, PathBuf};

use export::{Block, Document, Format, Source};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// What the model asks for: the whole document as Markdown, written the way chat maths is
/// written, and the sources it cites in order.
#[derive(Debug, Deserialize)]
pub(crate) struct ExportRequest {
    pub format: FileFormat,
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    pub markdown: String,
    #[serde(default)]
    pub sources: Vec<String>,
}

/// The kinds of file Jet can write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FileFormat {
    Pdf,
    Markdown,
    Html,
}

impl From<FileFormat> for Format {
    fn from(format: FileFormat) -> Format {
        match format {
            FileFormat::Pdf => Format::Pdf,
            FileFormat::Markdown => Format::Markdown,
            FileFormat::Html => Format::Html,
        }
    }
}

impl FileFormat {
    fn of_extension(extension: &str) -> Option<FileFormat> {
        [FileFormat::Pdf, FileFormat::Markdown, FileFormat::Html]
            .into_iter()
            .find(|&format| Format::from(format).extension() == extension)
    }

    /// The `Content-Type` of a download.
    pub fn download_type(self) -> &'static str {
        match self {
            FileFormat::Pdf => "application/pdf",
            FileFormat::Markdown => "text/markdown; charset=utf-8",
            FileFormat::Html => "text/html; charset=utf-8",
        }
    }

    /// The `Content-Type` of a file opened in a tab. Markdown is sent as plain text, because a
    /// browser would save a Markdown file instead of showing it.
    pub fn view_type(self) -> &'static str {
        match self {
            FileFormat::Markdown => "text/plain; charset=utf-8",
            other => other.download_type(),
        }
    }
}

/// A file that has just been written, as the tool call gives it back.
#[derive(Debug, Serialize)]
pub(crate) struct SavedFile {
    pub id: Uuid,
    pub name: String,
    pub title: String,
    pub format: FileFormat,
    pub bytes: u64,
}

/// A saved file, read back to be sent to the browser.
#[derive(Debug)]
pub(crate) struct OpenedFile {
    pub name: String,
    pub format: FileFormat,
    pub contents: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum FileError {
    #[error("no file with id {0:?}")]
    NotFound(String),
    #[error(transparent)]
    Export(#[from] export::ExportError),
    #[error("could not use {}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// The folder `<data>/files/`, holding `<uuid>/<name>` for each file. The name of the download is
/// the name of the file on disk, so nothing else has to be stored.
// SMELL: nothing limits how many files are kept or the disk they take, and one file can be tens
// of megabytes. Only Forget removes them.
#[derive(Clone)]
pub(crate) struct Files {
    root: PathBuf,
}

impl Files {
    pub fn new(data_dir: &Path) -> Files {
        Files {
            root: data_dir.join("files"),
        }
    }

    /// Writes the document into a new folder. The file is written in a `.part` folder that is
    /// renamed when it is whole, so a crash never leaves a half-written file to be served.
    ///
    /// # Errors
    /// - [`FileError::Export`] when the renderer cannot make the file.
    /// - [`FileError::Io`] when the files folder cannot be used.
    pub fn export(&self, request: ExportRequest) -> Result<SavedFile, FileError> {
        let id = Uuid::new_v4();
        let format = request.format;
        let name = Format::from(format).file_name(&request.title);
        let document = Document {
            title: request.title.clone(),
            origin: request.subtitle.unwrap_or_default(),
            blocks: vec![Block::Text {
                markdown: agent::dollar_math(&request.markdown),
                cites: Vec::new(),
            }],
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
        let written = export::write(&document, format.into(), &part.join(&name))
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

    /// Reads the one file in the folder of `id`. The id must be a UUID, so a path can never get
    /// through it.
    ///
    /// # Errors
    /// - [`FileError::NotFound`] when `id` is not a UUID, or no such file is saved.
    /// - [`FileError::Io`] when a saved file cannot be read.
    pub fn open(&self, id: &str) -> Result<OpenedFile, FileError> {
        let not_found = || FileError::NotFound(id.to_owned());
        // Only a missing file is the caller's mistake; any other failure is the server's.
        let read_error = |path: &Path, source: std::io::Error| match source.kind() {
            std::io::ErrorKind::NotFound => not_found(),
            _ => io_error(path)(source),
        };
        let id = Uuid::try_parse(id).map_err(|_| not_found())?;
        let folder = self.root.join(id.to_string());
        let entry = std::fs::read_dir(&folder)
            .map_err(|source| read_error(&folder, source))?
            .flatten()
            .next()
            .ok_or_else(not_found)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let format = Path::new(&name)
            .extension()
            .and_then(|extension| extension.to_str())
            .and_then(FileFormat::of_extension)
            .ok_or_else(not_found)?;
        let path = entry.path();
        let contents = std::fs::read(&path).map_err(|source| read_error(&path, source))?;
        Ok(OpenedFile {
            name,
            format,
            contents,
        })
    }

    /// Removes every file.
    ///
    /// SMELL: an export still running after its turn was stopped can finish after this, and its
    /// file then stays on disk, linked from nowhere, until the next clear.
    ///
    /// # Errors
    /// [`FileError::Io`] when the files folder cannot be removed.
    pub fn clear(&self) -> Result<(), FileError> {
        match std::fs::remove_dir_all(&self.root) {
            Err(source) if source.kind() != std::io::ErrorKind::NotFound => Err(FileError::Io {
                path: self.root.clone(),
                source,
            }),
            _ => Ok(()),
        }
    }
}

fn io_error(path: &Path) -> impl FnOnce(std::io::Error) -> FileError {
    let path = path.to_owned();
    move |source| FileError::Io { path, source }
}
