//! The OAuth sign-in that the MCP authorization specification (revision 2025-11-25) asks of a
//! client: read a server's challenge, find its sign-in server, register, and trade a code or a refresh token for tokens.

mod http;
mod request;

pub(super) use http::{Client, OAuthHttp, Provider, Tokens};
pub(super) use request::{Pkce, authorization_url, random_token, state_hash};

#[derive(Debug, thiserror::Error)]
pub(crate) enum SignInError {
    #[error(
        "the server let Jet in without a sign-in, so it needs none; test the connection instead"
    )]
    NotNeeded,
    #[error("the server answered HTTP {0} instead of asking Jet to sign in")]
    NoChallenge(u16),
    #[error("could not reach {url}: {message}")]
    Unreachable { url: String, message: String },
    #[error(
        "the server at {0} does not say how to sign in to it, because it publishes no OAuth metadata; add a key it accepts instead"
    )]
    NoMetadata(String),
    #[error("the sign-in metadata at {url} does not describe a sign-in Jet can use: {problem}")]
    Metadata { url: String, problem: String },
    #[error(
        "the sign-in server {0} does not offer PKCE with S256, which Jet needs to sign in safely"
    )]
    NoPkce(String),
    #[error(
        "the sign-in address {0} must use https, and may be on this server or a private network only for a server an admin added there"
    )]
    UnsafeAddress(String),
    #[error(
        "the sign-in server at {0} does not let Jet register itself; make an OAuth client in the provider's console with the redirect address below, then paste its client id"
    )]
    NoRegistration(String),
    #[error("the sign-in server at {issuer} would not register Jet: {message}")]
    Registration { issuer: String, message: String },
    #[error("the sign-in server refused: {}", refusal(.error, .description.as_deref()))]
    Refused {
        error: String,
        description: Option<String>,
    },
    #[error("the sign-in server's answer is not one Jet can read: {0}")]
    BadAnswer(String),
    #[error(
        "this sign-in link was already used, ran out, or belongs to another account; start the sign-in again in Settings, under MCP"
    )]
    StateRefused,
    #[error(
        "the sign-in server did not accept the client id or secret; Jet forgot them, so sign in again and paste the right ones"
    )]
    ClientRefused,
    #[error("the sign-in was not finished: {}", refusal(.error, .description.as_deref()))]
    Denied {
        error: String,
        description: Option<String>,
    },
}

impl SignInError {
    /// Whether the sign-in server did not accept the client id or secret.
    pub(super) fn is_client_refused(&self) -> bool {
        matches!(self, Self::Refused { error, .. } if error == "invalid_client")
    }

    /// Whether the sign-in server said the refresh token or code is no longer good.
    pub(super) fn is_invalid_grant(&self) -> bool {
        matches!(self, Self::Refused { error, .. } if error == "invalid_grant")
    }
}

fn refusal(error: &str, description: Option<&str>) -> String {
    match description {
        Some(description) => format!("{error} ({description})"),
        None => error.to_owned(),
    }
}
