//! Lets the page upload, delete, download and view files.

use super::{About, FileError, FileKind, Files, MAX_FILE_BYTES};
use crate::on_worker;
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, FromRef, Path, Query, State},
    http::{
        HeaderValue, StatusCode,
        header::{
            CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_SECURITY_POLICY, CONTENT_TYPE,
            X_CONTENT_TYPE_OPTIONS,
        },
    },
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;

pub(crate) fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Files: FromRef<S>,
{
    Router::new()
        .route(
            "/api/files",
            post(upload_file).layer(DefaultBodyLimit::max(UPLOAD_BODY_LIMIT)),
        )
        .route("/api/files/{id}", get(download_file).delete(remove_file))
        .route("/api/files/{id}/view", get(view_file))
}

/// A little over the largest file, so that the exact limit is enforced where the file is kept and
/// the page gets its message instead of a bare refusal.
const UPLOAD_BODY_LIMIT: usize = MAX_FILE_BYTES + 64 * 1024;

#[derive(Deserialize)]
struct UploadName {
    name: String,
}
/// Keeps the request body as an upload. The file is hidden from Jet until a message carries it.
// SMELL: each upload is held in memory whole until it is written, and nothing limits how many
// arrive at once, so the server's memory grows with the bytes that visitors are sending.
async fn upload_file(
    State(files): State<Files>,
    Query(query): Query<UploadName>,
    body: Bytes,
) -> Result<Json<About>, FileError> {
    Ok(Json(files.upload(&query.name, Vec::from(body)).await?))
}
/// Deletes an upload that was never sent.
async fn remove_file(
    State(files): State<Files>,
    Path(id): Path<String>,
) -> Result<StatusCode, FileError> {
    on_worker(move || files.remove(&id))
        .await
        .map_err(FileError::Worker)??;
    Ok(StatusCode::NO_CONTENT)
}

/// Even an HTML file opened on Jet's own address can run nothing and load nothing.
const FILE_POLICY: &str = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";

#[derive(Clone, Copy, PartialEq)]
enum Disposition {
    Attachment,
    Inline,
}

async fn download_file(
    State(files): State<Files>,
    Path(id): Path<String>,
) -> Result<Response, FileError> {
    serve_file(files, id, Disposition::Attachment).await
}
async fn view_file(
    State(files): State<Files>,
    Path(id): Path<String>,
) -> Result<Response, FileError> {
    serve_file(files, id, Disposition::Inline).await
}

async fn serve_file(
    files: Files,
    id: String,
    disposition: Disposition,
) -> Result<Response, FileError> {
    let file = on_worker(move || files.open(&id))
        .await
        .map_err(FileError::Worker)??;
    let content_type = match disposition {
        Disposition::Attachment => file.kind.download_type(),
        Disposition::Inline => file.kind.view_type(),
    };
    let headers = [
        (CONTENT_TYPE, HeaderValue::from_static(content_type)),
        (
            CONTENT_DISPOSITION,
            content_disposition(&file.name, disposition).ok_or(FileError::NameNotSendable)?,
        ),
        (X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
        (CACHE_CONTROL, HeaderValue::from_static("private, no-cache")),
    ];
    // A PDF gets no policy because Chrome's PDF viewer stays blank under one. The risk is small:
    // browsers keep a PDF's scripts inside the viewer, this address has no login or cookie, and
    // `nosniff` stops any other file being treated as a PDF.
    let policy = (file.kind != FileKind::Pdf).then(|| {
        [(
            CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(FILE_POLICY),
        )]
    });
    Ok((headers, policy, file.contents).into_response())
}

/// The disposition with a plain ASCII `filename` for old browsers and the exact name in
/// `filename*`, percent-encoded.
fn content_disposition(name: &str, disposition: Disposition) -> Option<HeaderValue> {
    let kind = match disposition {
        Disposition::Attachment => "attachment",
        Disposition::Inline => "inline",
    };
    let is_plain = |c: char| c == ' ' || (c.is_ascii_graphic() && !matches!(c, '"' | '\\'));
    let plain: String = name
        .chars()
        .map(|c| if is_plain(c) { c } else { '_' })
        .collect();
    let mut encoded = String::new();
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    HeaderValue::from_str(&format!(
        "{kind}; filename=\"{plain}\"; filename*=UTF-8''{encoded}"
    ))
    .ok()
}
