//! Accounts and sign-in: who may use Jet, the tokens that prove it, and the guard that stands in
//! front of every route.

mod cookies;
mod error;
mod guard;
mod limit;
mod password;
mod routes;
mod seed;
mod token;

pub use error::AccountError;
pub(crate) use guard::guard;
pub(crate) use routes::router;
pub(crate) use seed::{OWNER, seed};
pub(crate) use token::Keys;

use crate::{
    objectives::{self, Clock},
    server::ServerConfig,
    store::{SigninId, Store, User},
};
use axum::{extract::FromRequestParts, http::request::Parts};
use cookies::Cookies;
use limit::Failures;
use seed::DemoPassword;
use std::{
    net::IpAddr,
    sync::{Arc, Mutex},
};
use token::Grant;

/// How long a sign-in lasts without a new password: its refresh token is renewed on each use
/// until then.
const SIGNIN_SECONDS: u64 = 30 * 24 * 60 * 60;
pub(crate) const ACCESS_SECONDS: u64 = 15 * 60;

/// What the sign-in routes and the guard share.
#[derive(Clone)]
pub(crate) struct Accounts {
    store: Store,
    keys: Keys,
    cookies: Cookies,
    access_seconds: u64,
    public_origin: Option<String>,
    trusted_proxy: Option<IpAddr>,
    failures: Arc<Mutex<Failures>>,
    demo_password: DemoPassword,
    /// The time a renewal is judged by, which a test host can move.
    clock: Clock,
}

/// The signed-in user of a request. The guard puts it on every request it lets through with a
/// sign-in, so any handler can take it as an argument.
#[derive(Debug, Clone)]
pub(crate) struct SignedIn {
    pub(crate) user: User,
    pub(crate) signin: SigninId,
    /// When the proof this request carried runs out, in seconds since 1970.
    pub(crate) expires_at: u64,
}

impl<S: Send + Sync> FromRequestParts<S> for SignedIn {
    type Rejection = AccountError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<SignedIn>()
            .cloned()
            .ok_or(AccountError::SignedOut)
    }
}

impl Accounts {
    /// Seeds the demo organisation when the database holds no user yet, and loads the signing
    /// secret.
    pub(crate) fn open(config: &ServerConfig, store: Store) -> Result<Self, AccountError> {
        let demo_password = DemoPassword::for_host(config.public_origin.as_deref())?;
        demo_password.seed_empty(&store)?;
        let public_origin = config.public_origin.clone();
        Ok(Self {
            store,
            keys: Keys::load(&config.data_dir)?,
            cookies: Cookies {
                secure: public_origin
                    .as_deref()
                    .is_some_and(|origin| origin.starts_with("https://")),
            },
            access_seconds: config.access_seconds,
            public_origin,
            trusted_proxy: config.trusted_proxy,
            failures: Arc::new(Mutex::new(Failures::default())),
            demo_password,
            clock: objectives::test_clock().unwrap_or_else(objectives::system_clock),
        })
    }

    pub(crate) fn keys(&self) -> &Keys {
        &self.keys
    }

    /// Whether the sign-in has not been ended since the request that carried it was let in.
    pub(crate) fn is_live(&self, signed_in: &SignedIn) -> bool {
        matches!(
            self.store.live_signin(&signed_in.signin, token::now()),
            Ok(Some(_))
        )
    }

    /// The signed-in user of a token, when the token is the right kind and its sign-in is live.
    fn signed_in(
        &self,
        token: &str,
        wanted: impl Fn(&Grant) -> Option<&SigninId>,
    ) -> Result<SignedIn, AccountError> {
        let (grant, expires_at) = self.keys.verify(token).ok_or(AccountError::SignedOut)?;
        let signin = wanted(&grant).ok_or(AccountError::SignedOut)?.clone();
        let user = self
            .store
            .live_signin(&signin, token::now())?
            .ok_or(AccountError::SignedOut)?;
        Ok(SignedIn {
            user,
            signin,
            expires_at,
        })
    }
}
