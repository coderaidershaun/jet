//! The signed tokens Jet gives out, the random refresh tokens, and the secret that signs them.

use super::AccountError;
use crate::store::SigninId;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const SECRET_FILE: &str = "signing-secret";
const SECRET_VARIABLE: &str = "JET_SIGNING_SECRET";
const SECRET_BYTES: usize = 32;
const FILE_PROOF_SECONDS: u64 = 15 * 60;

/// What a signed token lets its holder do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Grant {
    /// Use Jet as the user of this sign-in.
    Access { signin: SigninId },
    /// Load one app's pages through the proxy, for an hour at most and never past the sign-in.
    App { signin: SigninId, app: String },
    /// Download one file, with no sign-in: an app's server fetches a file Jet handed it.
    File { file: String },
}

#[derive(Serialize, Deserialize)]
struct Claims {
    exp: u64,
    grant: Grant,
}

#[derive(Clone)]
pub(crate) struct Keys {
    encoding: EncodingKey,
    decoding: DecodingKey,
}

impl Keys {
    /// Reads the secret from the environment, else from the data directory, making it there with
    /// owner-only access on first start.
    pub(super) fn load(data_dir: &Path) -> Result<Self, AccountError> {
        let secret = match std::env::var(SECRET_VARIABLE) {
            Ok(secret) => secret,
            Err(_) => read_or_make_secret(&data_dir.join(SECRET_FILE))?,
        };
        if secret.len() < SECRET_BYTES {
            return Err(AccountError::ShortSecret {
                length: secret.len(),
            });
        }
        Ok(Self {
            encoding: EncodingKey::from_secret(secret.as_bytes())?,
            decoding: DecodingKey::from_secret(secret.as_bytes())?,
        })
    }

    pub(super) fn sign(&self, grant: Grant, expires_at: u64) -> String {
        let claims = Claims {
            exp: expires_at,
            grant,
        };
        jsonwebtoken::encode(&Header::new(Algorithm::HS256), &claims, &self.encoding)
            .expect("plain claims always serialise and HS256 always signs")
    }

    /// The grant of a token this server signed and that has not run out, with its expiry.
    pub(super) fn verify(&self, token: &str) -> Option<(Grant, u64)> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = 0;
        let claims = jsonwebtoken::decode::<Claims>(token, &self.decoding, &validation)
            .ok()?
            .claims;
        Some((claims.grant, claims.exp))
    }

    /// A short-lived proof that lets whoever holds it download this one file.
    pub(crate) fn file_proof(&self, file: &uuid::Uuid) -> String {
        let grant = Grant::File {
            file: file.to_string(),
        };
        self.sign(grant, now() + FILE_PROOF_SECONDS)
    }
}

fn read_or_make_secret(path: &Path) -> Result<String, AccountError> {
    let failed = |source| AccountError::Secret {
        path: path.to_owned(),
        source,
    };
    match std::fs::read_to_string(path) {
        Ok(secret) => return Ok(secret.trim().to_owned()),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(failed(error)),
        Err(_) => {}
    }
    let secret = random_hex(SECRET_BYTES);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path).map_err(failed)?;
    file.write_all(secret.as_bytes()).map_err(failed)?;
    Ok(secret)
}

pub(super) fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0; bytes];
    getrandom::fill(&mut buffer).expect("the system random source is available");
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The form a refresh token is stored in, so the database never holds a usable token.
pub(super) fn digest(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is after 1970")
        .as_secs()
}
