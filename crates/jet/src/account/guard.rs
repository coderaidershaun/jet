//! The guard in front of every route: it lets a request through only with a sign-in, an app's
//! proof or a file's proof, except on the few paths the sign-in page needs.

use super::{AccountError, Accounts, SIGNIN_SECONDS, SignedIn, cookies, token};
use axum::{
    extract::{Request, State},
    http::{
        HeaderMap, Method, StatusCode,
        header::{HOST, LOCATION, ORIGIN},
    },
    middleware::Next,
    response::{IntoResponse, Response},
};
use token::Grant;

/// Where a browser that is not signed in is sent.
const SIGNIN_PAGE: &str = "/signin/";
/// The sign-in page, the files it loads, and its endpoints. A path that ends in `/` opens every
/// path below it.
const OPEN_PATHS: [&str; 8] = [
    "/signin",
    "/signin/",
    "/jet/",
    "/dom.js",
    "/chat.css",
    "/api/auth/signin",
    "/api/auth/refresh",
    "/api/auth/signout",
];
/// Marks the path segment that carries an app's proof: `/apps/{id}/~{proof}/...`.
const PROOF_MARK: char = '~';

enum Admission {
    Open,
    SignedIn(SignedIn),
    Redirect(StatusCode, String),
}

pub(crate) async fn guard(
    State(accounts): State<Accounts>,
    mut request: Request,
    next: Next,
) -> Response {
    match accounts.admit(&request) {
        Ok(Admission::Open) => next.run(request).await,
        Ok(Admission::SignedIn(signed_in)) => {
            request.extensions_mut().insert(signed_in);
            next.run(request).await
        }
        Ok(Admission::Redirect(status, location)) => {
            (status, [(LOCATION, location)]).into_response()
        }
        Err(error) => error.into_response(),
    }
}

impl Accounts {
    fn admit(&self, request: &Request) -> Result<Admission, AccountError> {
        let path = request.uri().path();
        let headers = request.headers();
        let changes_state = !matches!(
            *request.method(),
            Method::GET | Method::HEAD | Method::OPTIONS
        );
        if is_open(path) {
            if changes_state {
                self.same_origin(headers)?;
            }
            return Ok(Admission::Open);
        }
        // An app page runs with an opaque origin, so its requests carry no cookie and say they
        // are cross-site; the proof in its address is what lets them in.
        if let Some((app, Some(proof))) = app_path(path) {
            let signed_in = self.signed_in(proof, |grant| match grant {
                Grant::App {
                    signin,
                    app: granted,
                } if granted == app => Some(signin),
                _ => None,
            })?;
            return Ok(Admission::SignedIn(signed_in));
        }
        if self.is_file_handoff(request) {
            return Ok(Admission::Open);
        }
        if is_cross_site(headers) && !is_top_level_navigation(request) {
            return Err(AccountError::CrossSite);
        }
        if changes_state {
            self.same_origin(headers)?;
        }
        let access = cookies::read(headers, cookies::ACCESS).unwrap_or_default();
        let signed_in = match self.signed_in(access, |grant| match grant {
            Grant::Access { signin } => Some(signin),
            _ => None,
        }) {
            Ok(signed_in) => signed_in,
            Err(AccountError::SignedOut)
                if is_navigation(headers) && !path.starts_with("/api/") =>
            {
                return Ok(Admission::Redirect(
                    StatusCode::SEE_OTHER,
                    signin_address(request.uri()),
                ));
            }
            Err(error) => return Err(error),
        };
        if let Some((app, None)) = app_path(path)
            && is_navigation(headers)
        {
            return Ok(Admission::Redirect(
                StatusCode::TEMPORARY_REDIRECT,
                self.app_address(request, app, &signed_in),
            ));
        }
        Ok(Admission::SignedIn(signed_in))
    }

    /// A request that changes state must say it comes from Jet's own page: browsers send
    /// `Origin` on every such request, and another site cannot forge it.
    fn same_origin(&self, headers: &HeaderMap) -> Result<(), AccountError> {
        let origin = headers.get(ORIGIN).and_then(|value| value.to_str().ok());
        let own = match &self.public_origin {
            Some(origin) => Some(origin.clone()),
            None => headers
                .get(HOST)
                .and_then(|value| value.to_str().ok())
                .map(|host| format!("http://{host}")),
        };
        match (origin, own) {
            (Some(origin), Some(own)) if origin == own => Ok(()),
            _ => Err(AccountError::CrossSite),
        }
    }

    /// `GET /api/files/{id}?proof=...`: the address Jet hands an app's server for one file.
    fn is_file_handoff(&self, request: &Request) -> bool {
        let Some(file) = request.uri().path().strip_prefix("/api/files/") else {
            return false;
        };
        let proof = request
            .uri()
            .query()
            .and_then(|query| query.strip_prefix("proof="));
        let granted = proof.and_then(|proof| self.keys.verify(proof));
        request.method() == Method::GET
            && matches!(granted, Some((Grant::File { file: granted }, _)) if granted == file)
    }

    /// The address that serves an app's page with the app's proof in it, so that the page and
    /// every relative address it loads reach the app without Jet's cookies.
    fn app_address(&self, request: &Request, app: &str, signed_in: &SignedIn) -> String {
        let grant = Grant::App {
            signin: signed_in.signin.clone(),
            app: app.to_owned(),
        };
        let proof = self.keys.sign(grant, token::now() + SIGNIN_SECONDS);
        let tail = request
            .uri()
            .path()
            .strip_prefix(&format!("/apps/{app}/"))
            .unwrap_or_default();
        let query = request
            .uri()
            .query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default();
        format!("/apps/{app}/{PROOF_MARK}{proof}/{tail}{query}")
    }
}

/// The sign-in page, told where to go back to once the person has signed in.
fn signin_address(asked: &axum::http::Uri) -> String {
    let next = asked.path_and_query().map_or("/", |asked| asked.as_str());
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("next", next)
        .finish();
    format!("{SIGNIN_PAGE}?{query}")
}

fn is_open(path: &str) -> bool {
    let plain = !path.contains("..") && !path.contains('%');
    plain
        && OPEN_PATHS.iter().any(|open| {
            if open.ends_with('/') {
                path.starts_with(open)
            } else {
                path == *open
            }
        })
}

/// The app id of an `/apps/{id}/...` path, and the proof it carries, if any.
fn app_path(path: &str) -> Option<(&str, Option<&str>)> {
    let (app, rest) = path.strip_prefix("/apps/")?.split_once('/')?;
    let proof = rest
        .strip_prefix(PROOF_MARK)
        .map(|rest| rest.split_once('/').map_or(rest, |(proof, _)| proof));
    Some((app, proof))
}

fn fetch(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_ascii_lowercase)
}

fn is_cross_site(headers: &HeaderMap) -> bool {
    matches!(
        fetch(headers, "sec-fetch-site").as_deref(),
        Some("cross-site" | "same-site")
    )
}

fn is_navigation(headers: &HeaderMap) -> bool {
    fetch(headers, "sec-fetch-mode").as_deref() == Some("navigate")
}

/// A link followed from another site opens Jet in its own tab; nothing of Jet is shown to the
/// other site.
fn is_top_level_navigation(request: &Request) -> bool {
    request.method() == Method::GET
        && is_navigation(request.headers())
        && fetch(request.headers(), "sec-fetch-dest").as_deref() == Some("document")
}
