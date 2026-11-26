//! Lets the page upload, list, change, delete, download and view the signed-in user's files,
//! across all of their chats.

use super::{About, Artifact, FileError, FileKind, Files, Library, OpenedFile};
use crate::{
    account::SignedIn,
    chat::Chats,
    on_worker,
    store::{ChatId, UserId},
};
use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{FromRef, Path, Query, State},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{
            CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_SECURITY_POLICY, CONTENT_TYPE, LOCATION,
            X_CONTENT_TYPE_OPTIONS,
        },
    },
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

pub(crate) fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Files: FromRef<S>,
    Arc<Chats>: FromRef<S>,
{
    Router::new()
        .route("/api/files", post(upload_file).get(list_files))
        .route("/api/files/archive", get(archive_all).post(archive_chosen))
        .route(
            "/api/files/{id}",
            get(download_file).delete(delete_file).patch(rename_file),
        )
        .route("/api/files/{id}/view", get(view_file))
        .route("/api/files/{id}/frame", get(frame_file))
        .route("/api/files/{id}/chats", post(add_to_chat))
        .route("/api/files/{id}/chats/{chat}", delete(remove_from_chat))
        .route("/api/files/{id}/versions", get(versions))
        .route("/api/files/{id}/restore", post(restore))
}

#[derive(Deserialize)]
struct UploadName {
    name: String,
}
/// Keeps the request body as an upload. The file is hidden from Jet until a message carries it.
async fn upload_file(
    State(files): State<Files>,
    signed_in: SignedIn,
    Query(query): Query<UploadName>,
    body: Body,
) -> Result<Json<About>, FileError> {
    let user = signed_in.user.id;
    Ok(Json(files.upload_body(user, &query.name, body).await?))
}
/// Runs a change on a worker and, when it worked, tells the user's pages that their files changed.
async fn change<T: Send + 'static>(
    (files, chats): (Files, Arc<Chats>),
    user: UserId,
    call: impl FnOnce(&Files) -> Result<T, FileError> + Send + 'static,
) -> Result<T, FileError> {
    let done = on_worker(move || call(&files))
        .await
        .map_err(FileError::Worker)??;
    chats.pane_changed(user);
    Ok(done)
}

/// Every file of the user that Jet can see, across all chats, and the room they take.
async fn list_files(
    State(files): State<Files>,
    signed_in: SignedIn,
) -> Result<Json<Library>, FileError> {
    let user = signed_in.user.id;
    let library = on_worker(move || files.library(user))
        .await
        .map_err(FileError::Worker)??;
    Ok(Json(library))
}

/// Deletes the user's file from every chat that holds it, or an upload that was never sent.
async fn delete_file(
    State(files): State<Files>,
    State(chats): State<Arc<Chats>>,
    signed_in: SignedIn,
    Path(id): Path<String>,
) -> Result<StatusCode, FileError> {
    let user = signed_in.user.id;
    change((files, chats), user, move |files| files.delete(user, &id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct NewName {
    name: String,
}
/// Renames the user's file, keeping its kind.
async fn rename_file(
    State(files): State<Files>,
    State(chats): State<Arc<Chats>>,
    signed_in: SignedIn,
    Path(id): Path<String>,
    Json(request): Json<NewName>,
) -> Result<Json<Artifact>, FileError> {
    let user = signed_in.user.id;
    let renamed = change((files, chats), user, move |files| {
        let keeper = files.keeper(user, &id)?;
        files.rename(user, keeper, &id, &request.name)
    });
    Ok(Json(renamed.await?.0))
}

#[derive(Deserialize)]
struct ToChat {
    chat: i64,
}
/// Lets another chat of the user hold the user's file too. Only the user's own request does this.
async fn add_to_chat(
    State(files): State<Files>,
    State(chats): State<Arc<Chats>>,
    signed_in: SignedIn,
    Path(id): Path<String>,
    Json(request): Json<ToChat>,
) -> Result<Json<Artifact>, FileError> {
    let (user, to) = (signed_in.user.id, ChatId(request.chat));
    let shared = change((files, chats), user, move |files| {
        files.share(user, to, &id, to)
    });
    Ok(Json(shared.await?.0))
}

/// Takes the user's file out of one chat, but not out of the last chat that holds it.
async fn remove_from_chat(
    State(files): State<Files>,
    State(chats): State<Arc<Chats>>,
    signed_in: SignedIn,
    Path((id, chat)): Path<(String, i64)>,
) -> Result<Json<Artifact>, Response> {
    let user = signed_in.user.id;
    let removed = change((files, chats), user, move |files| {
        files.remove_from(user, &id, ChatId(chat))
    });
    match removed.await {
        Ok(file) => Ok(Json(file)),
        Err(error @ FileError::LastChat) => {
            let body = json!({"kind": "conflict", "message": error.to_string()});
            Err((StatusCode::CONFLICT, Json(body)).into_response())
        }
        Err(error) => Err(error.into_response()),
    }
}

/// The current version of the user's file and the earlier ones kept, newest first.
async fn versions(
    State(files): State<Files>,
    signed_in: SignedIn,
    Path(id): Path<String>,
) -> Result<Response, FileError> {
    let user = signed_in.user.id;
    let versions = on_worker(move || files.versions(user, &id))
        .await
        .map_err(FileError::Worker)??;
    Ok(Json(versions).into_response())
}

#[derive(Deserialize)]
struct Restore {
    version: u32,
}
/// Brings an earlier version of the user's file back as its newest version.
async fn restore(
    State(files): State<Files>,
    State(chats): State<Arc<Chats>>,
    signed_in: SignedIn,
    Path(id): Path<String>,
    Json(request): Json<Restore>,
) -> Result<Json<Artifact>, FileError> {
    let user = signed_in.user.id;
    let keeper = {
        let (files, id) = (files.clone(), id.clone());
        on_worker(move || files.keeper(user, &id))
            .await
            .map_err(FileError::Worker)??
    };
    let (file, _) = files
        .restore(user, keeper, &id, Some(request.version))
        .await?;
    chats.pane_changed(user);
    Ok(Json(file))
}

/// Every file of the user that Jet can see, as one zip.
async fn archive_all(
    State(files): State<Files>,
    signed_in: SignedIn,
) -> Result<Response, FileError> {
    archive(files, signed_in.user.id, None).await
}

#[derive(Deserialize)]
struct Chosen {
    ids: Vec<String>,
}
/// The chosen files of the user as one zip. One id that is not the user's refuses them all.
async fn archive_chosen(
    State(files): State<Files>,
    signed_in: SignedIn,
    Json(request): Json<Chosen>,
) -> Result<Response, FileError> {
    archive(files, signed_in.user.id, Some(request.ids)).await
}

async fn archive(
    files: Files,
    user: UserId,
    ids: Option<Vec<String>>,
) -> Result<Response, FileError> {
    let (name, zip) = files.zip(user, ids).await?;
    let headers = [
        (CONTENT_TYPE, HeaderValue::from_static("application/zip")),
        (
            CONTENT_DISPOSITION,
            content_disposition(&name, Disposition::Attachment)
                .ok_or(FileError::NameNotSendable)?,
        ),
        (CACHE_CONTROL, HeaderValue::from_static("private, no-cache")),
    ];
    Ok((headers, Body::from_stream(chunks_of(zip))).into_response())
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

/// The file's bytes a piece at a time, so a zip is sent from disk and not held in memory. Each
/// piece is a short read of a local file, quick enough to do here.
fn chunks_of(
    mut file: std::fs::File,
) -> impl tokio_stream::Stream<Item = std::io::Result<Vec<u8>>> {
    const PIECE_BYTES: usize = 64 * 1024;
    tokio_stream::iter(std::iter::from_fn(move || {
        let mut piece = vec![0; PIECE_BYTES];
        match std::io::Read::read(&mut file, &mut piece) {
            Ok(0) => None,
            Ok(read) => {
                piece.truncate(read);
                Some(Ok(piece))
            }
            Err(error) => Some(Err(error)),
        }
    }))
}
