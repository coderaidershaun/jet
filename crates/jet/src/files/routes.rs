//! Lets the page upload, delete, download and view files.

use super::{About, FileError, FileKind, Files, MAX_FILE_BYTES, OpenedFile};
use crate::{account::SignedIn, on_worker};
use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, FromRef, Path, Query, State},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{
            CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_SECURITY_POLICY, CONTENT_TYPE, LOCATION,
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
        .route("/api/files/{id}/frame", get(frame_file))
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
    signed_in: SignedIn,
    Query(query): Query<UploadName>,
    body: Bytes,
) -> Result<Json<About>, FileError> {
    let user = signed_in.user.id;
    Ok(Json(
        files.upload(user, &query.name, Vec::from(body)).await?,
    ))
}
/// Deletes an upload that was never sent.
async fn remove_file(
    State(files): State<Files>,
    signed_in: SignedIn,
    Path(id): Path<String>,
) -> Result<StatusCode, FileError> {
    let user = signed_in.user.id;
    on_worker(move || files.remove(user, &id))
        .await
        .map_err(FileError::Worker)??;
    Ok(StatusCode::NO_CONTENT)
}

/// Even a file opened on Jet's own address can run nothing and load nothing.
const FILE_POLICY: &str = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/// A page Jet wrote may run its own inline scripts, and nothing else. With `sandbox` and no
/// `allow-same-origin` the page has an opaque origin, so it cannot read Jet's page or cookies; the
/// browser sends Jet's `SameSite` cookies with none of its requests, and the guard refuses a
/// cross-site request anyway; and `default-src 'none'` leaves it nothing to load or call. Only the
/// frame that holds it (see `view_file`) stops it sending its own frame to another site.
const PAGE_POLICY: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

#[derive(Clone, Copy, PartialEq)]
enum Disposition {
    Attachment,
    Inline,
}

/// A signed-in user gets only their own files. A request with no sign-in got past the guard only
/// with the proof that names this one file, which Jet gave an app for a tool call.
async fn download_file(
    State(files): State<Files>,
    signed_in: Option<Extension<SignedIn>>,
    Path(id): Path<String>,
) -> Result<Response, FileError> {
    let user = signed_in.map(|Extension(signed_in)| signed_in.user.id);
    send(open(files, user, id).await?, Disposition::Attachment)
}
/// The page's own headers stop it loading or calling anything, but a script could still send its
/// own frame to another site. So a tab never holds the bare page: a top-level navigation to an
/// HTML file is sent to its frame, and the frame's `frame-src 'self'` stops the page leaving. On
/// Jet's own address the frame's request carries no cookie, and the guard refuses it.
async fn view_file(
    State(files): State<Files>,
    signed_in: SignedIn,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, FileError> {
    let file = open(files, Some(signed_in.user.id), id).await?;
    let is_tab = headers
        .get("sec-fetch-dest")
        .is_some_and(|dest| dest == "document");
    if is_tab && file.kind == FileKind::Html {
        let to = format!("/api/files/{}/frame", file.id);
        return Ok((StatusCode::SEE_OTHER, [(LOCATION, to)]).into_response());
    }
    send(file, Disposition::Inline)
}

/// What the frame of a page says about itself: nothing of the user's or the file's, only its id.
/// The wrapper is Jet's own inert page, and the file inside keeps the sandbox of its own response.
const FRAME_POLICY: &str =
    "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors 'self'";

/// The page that holds an HTML file in a sandboxed frame, for a tab. Anything but the signed-in
/// user's own HTML file is as missing as a missing file.
async fn frame_file(
    State(files): State<Files>,
    signed_in: SignedIn,
    Path(id): Path<String>,
) -> Result<Response, FileError> {
    let file = open(files, Some(signed_in.user.id), id).await?;
    if file.kind != FileKind::Html {
        return Err(FileError::NotFound(file.id.to_string()));
    }
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>File</title><style>html,body,iframe{{display:block;width:100%;height:100%;margin:0;border:0}}</style><iframe sandbox=\"allow-scripts\" src=\"/api/files/{}/view\"></iframe>",
        file.id
    );
    let headers = [
        (CONTENT_TYPE, "text/html; charset=utf-8"),
        (X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (CACHE_CONTROL, "private, no-cache"),
        (CONTENT_SECURITY_POLICY, FRAME_POLICY),
    ];
    Ok((headers, body).into_response())
}

/// Reads the file on a worker: the user's own, or with no user the one a proof names.
async fn open(
    files: Files,
    user: Option<crate::store::UserId>,
    id: String,
) -> Result<OpenedFile, FileError> {
    on_worker(move || files.open(user, &id))
        .await
        .map_err(FileError::Worker)?
}

fn send(file: OpenedFile, disposition: Disposition) -> Result<Response, FileError> {
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
    // browsers keep a PDF's scripts inside the viewer, away from the page and its sign-in, and
    // `nosniff` stops any other file being treated as a PDF.
    let policy = match file.kind {
        FileKind::Pdf => None,
        FileKind::Html => Some(PAGE_POLICY),
        _ => Some(FILE_POLICY),
    }
    .map(|policy| [(CONTENT_SECURITY_POLICY, HeaderValue::from_static(policy))]);
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
