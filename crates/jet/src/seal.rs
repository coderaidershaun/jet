//! The server's key for the secrets users give Jet, a GitHub token or an MCP server's key: each is
//! sealed with it before it is stored, so the database alone never holds a secret in clear.

use ring::aead::{Aad, CHACHA20_POLY1305, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path, sync::Arc};

const KEY_FILE: &str = "github-token-key";
const KEY_VARIABLE: &str = "JET_GITHUB_TOKEN_KEY";
const KEY_BYTES: usize = 32;

#[derive(Debug, thiserror::Error)]
pub enum SealError {
    #[error("failed to read or make the token key {path}")]
    Key {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("the token key has {length} bytes; it needs at least 32")]
    ShortKey { length: usize },
}

#[derive(Clone)]
pub(crate) struct Sealer {
    key: Arc<LessSafeKey>,
}

impl Sealer {
    /// Reads the key from the environment, else from the data directory, making it there with
    /// owner-only access on first start.
    pub(crate) fn open(data_dir: &Path) -> Result<Self, SealError> {
        let secret = match std::env::var(KEY_VARIABLE) {
            Ok(secret) => secret,
            Err(_) => read_or_make_key(&data_dir.join(KEY_FILE))?,
        };
        if secret.len() < KEY_BYTES {
            return Err(SealError::ShortKey {
                length: secret.len(),
            });
        }
        let key = UnboundKey::new(&CHACHA20_POLY1305, &Sha256::digest(secret.as_bytes()))
            .expect("a SHA-256 digest is exactly a ChaCha20-Poly1305 key long");
        Ok(Self {
            key: Arc::new(LessSafeKey::new(key)),
        })
    }

    /// Seals the secret to `owner`, the bytes that name whose it is: sealed bytes copied to
    /// another owner's row do not open.
    pub(crate) fn seal(&self, owner: &[u8], secret: &[u8]) -> Vec<u8> {
        let mut nonce = [0; NONCE_LEN];
        getrandom::fill(&mut nonce).expect("the system random source is available");
        let mut sealed = secret.to_vec();
        self.key
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(owner),
                &mut sealed,
            )
            .expect("ChaCha20-Poly1305 seals any message this short");
        [nonce.as_slice(), &sealed].concat()
    }

    /// The secret in clear, or `None` when the bytes do not open with this key for `owner`.
    pub(crate) fn unseal(&self, owner: &[u8], stored: &[u8]) -> Option<Vec<u8>> {
        let (nonce, sealed) = stored.split_at_checked(NONCE_LEN)?;
        let nonce = Nonce::try_assume_unique_for_key(nonce).ok()?;
        let mut sealed = sealed.to_vec();
        let secret = self
            .key
            .open_in_place(nonce, Aad::from(owner), &mut sealed)
            .ok()?;
        Some(secret.to_vec())
    }
}

fn read_or_make_key(path: &Path) -> Result<String, SealError> {
    let failed = |source| SealError::Key {
        path: path.to_owned(),
        source,
    };
    match std::fs::read_to_string(path) {
        Ok(secret) => return Ok(secret.trim().to_owned()),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(failed(error)),
        Err(_) => {}
    }
    let mut bytes = [0; KEY_BYTES];
    getrandom::fill(&mut bytes).expect("the system random source is available");
    let secret: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path).map_err(failed)?;
    file.write_all(secret.as_bytes()).map_err(failed)?;
    Ok(secret)
}
