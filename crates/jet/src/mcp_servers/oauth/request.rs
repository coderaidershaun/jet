//! The pieces of a sign-in that Jet builds or reads without the network: the challenge, the PKCE
//! pair and state, the provider's sign-in address, and where metadata is published.

use super::SignInError;
use base64::Engine;
use sha2::{Digest, Sha256};
use url::Url;

const BASE64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// What a server's `WWW-Authenticate` challenge says: where its metadata is and which scopes it asks for.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Challenge {
    pub resource_metadata: Option<Url>,
    pub scope: Option<String>,
}

impl Challenge {
    /// Reads the `Bearer` challenge of a `WWW-Authenticate` header (RFC 6750 and RFC 9728). An
    /// address that is not valid is left out, as if the server had not named one.
    pub(super) fn parse(header: &str, server: &Url) -> Self {
        let mut challenge = Self::default();
        let Some(at) = header.to_ascii_lowercase().find("bearer") else {
            return challenge;
        };
        let mut rest = &header[at + "bearer".len()..];
        while let Some((key, value, after)) = next_param(rest) {
            match key.to_ascii_lowercase().as_str() {
                "resource_metadata" => challenge.resource_metadata = server.join(&value).ok(),
                "scope" if !value.trim().is_empty() => challenge.scope = Some(value),
                _ => {}
            }
            rest = after;
        }
        challenge
    }
}

/// The next `key=value` or `key="quoted value"` of a challenge, and what follows it. `None` at the
/// end, or where a new challenge scheme starts.
fn next_param(text: &str) -> Option<(String, String, &str)> {
    let text = text.trim_start_matches([' ', ',', '\t']);
    let key_end = text.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))?;
    let (key, after_key) = text.split_at(key_end);
    let after_equals = after_key.trim_start().strip_prefix('=')?.trim_start();
    if key.is_empty() {
        return None;
    }
    if let Some(quoted) = after_equals.strip_prefix('"') {
        let mut value = String::new();
        let mut chars = quoted.char_indices();
        while let Some((at, c)) = chars.next() {
            match c {
                '\\' => value.extend(chars.next().map(|(_, escaped)| escaped)),
                '"' => return Some((key.to_owned(), value, &quoted[at + 1..])),
                _ => value.push(c),
            }
        }
        return None;
    }
    let end = after_equals
        .find([',', ' ', '\t'])
        .unwrap_or(after_equals.len());
    Some((
        key.to_owned(),
        after_equals[..end].to_owned(),
        &after_equals[end..],
    ))
}

/// A PKCE pair (RFC 7636): the verifier Jet keeps and the S256 challenge the provider sees.
pub(in crate::mcp_servers) struct Pkce {
    pub(in crate::mcp_servers) verifier: String,
    pub(in crate::mcp_servers) challenge: String,
}

impl Pkce {
    pub(in crate::mcp_servers) fn new() -> Self {
        let verifier = random_token();
        let challenge = BASE64URL.encode(Sha256::digest(verifier.as_bytes()));
        Self {
            verifier,
            challenge,
        }
    }
}

/// 32 random bytes as base64url: a PKCE verifier or an OAuth state.
pub(in crate::mcp_servers) fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the system random source is available");
    BASE64URL.encode(bytes)
}

/// The state as the database keeps it, so the table alone cannot finish a sign-in.
pub(in crate::mcp_servers) fn state_hash(state: &str) -> String {
    Sha256::digest(state.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The provider's sign-in page, with the PKCE challenge, the state and the RFC 8707 resource.
pub(in crate::mcp_servers) fn authorization_url(
    endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    resource: &str,
    scope: Option<&str>,
    challenge: &str,
    state: &str,
) -> Result<Url, SignInError> {
    let mut url = Url::parse(endpoint).map_err(|_| SignInError::UnsafeAddress(endpoint.into()))?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state)
            .append_pair("resource", resource);
        if let Some(scope) = scope {
            query.append_pair("scope", scope);
        }
    }
    Ok(url)
}

/// Whether a protected resource that metadata names is this server: the same origin, and the same
/// path or a parent of it, compared whole segment by whole segment (RFC 9728, section 3.3).
pub(super) fn names_server(resource: &Url, server: &Url) -> bool {
    let parent = resource.path().trim_end_matches('/');
    let path = server.path();
    let within = path == parent
        || path
            .strip_prefix(parent)
            .is_some_and(|rest| rest.starts_with('/'));
    resource.origin() == server.origin() && within
}

/// The server's address as an RFC 8707 resource: no fragment, and no trailing slash on a bare host.
pub(super) fn canonical(server: &Url) -> String {
    let mut url = server.clone();
    url.set_fragment(None);
    let text = url.to_string();
    match url.path() {
        "/" => text.trim_end_matches('/').to_owned(),
        _ => text,
    }
}

pub(super) enum WellKnown {
    /// `https://host/.well-known/{name}/path`, the RFC 8414 and RFC 9728 form.
    PathAfter,
    /// `https://host/.well-known/{name}`.
    Root,
    /// `https://host/path/.well-known/{name}`, the OpenID Connect form.
    PathBefore,
}

/// The well-known address of `name` for `url`. `None` for a form that needs a path the address
/// does not have.
pub(super) fn well_known(url: &Url, name: &str, form: WellKnown) -> Option<Url> {
    let path = url.path().trim_end_matches('/');
    let path = match form {
        WellKnown::PathAfter if !path.is_empty() => format!("/.well-known/{name}{path}"),
        WellKnown::PathBefore if !path.is_empty() => format!("{path}/.well-known/{name}"),
        WellKnown::Root => format!("/.well-known/{name}"),
        WellKnown::PathAfter | WellKnown::PathBefore => return None,
    };
    let mut found = url.clone();
    found.set_path(&path);
    found.set_query(None);
    found.set_fragment(None);
    Some(found)
}

/// Where an issuer's metadata may be, in the order the MCP specification gives.
pub(super) fn authorization_server_documents(issuer: &Url) -> Vec<Url> {
    let has_path = !issuer.path().trim_end_matches('/').is_empty();
    let forms = match has_path {
        true => vec![
            ("oauth-authorization-server", WellKnown::PathAfter),
            ("openid-configuration", WellKnown::PathAfter),
            ("openid-configuration", WellKnown::PathBefore),
        ],
        false => vec![
            ("oauth-authorization-server", WellKnown::Root),
            ("openid-configuration", WellKnown::Root),
        ],
    };
    forms
        .into_iter()
        .filter_map(|(name, form)| well_known(issuer, name, form))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_challenge_gives_its_metadata_address_and_scope() {
        let server = Url::parse("https://mcp.example.com/mcp").unwrap();
        let header = r#"Basic realm="x", Bearer error="invalid_token", resource_metadata="/.well-known/oauth-protected-resource/mcp", scope="files:read files:write""#;
        let challenge = Challenge::parse(header, &server);
        assert_eq!(
            challenge.resource_metadata.unwrap().as_str(),
            "https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
        );
        assert_eq!(challenge.scope.as_deref(), Some("files:read files:write"));
        assert_eq!(Challenge::parse("Bearer", &server), Challenge::default());
    }

    #[test]
    fn a_resource_names_the_server_only_on_whole_path_segments() {
        let server = Url::parse("https://host.example/mcp").unwrap();
        let named = |text: &str| names_server(&Url::parse(text).unwrap(), &server);
        assert!(named("https://host.example/mcp"));
        assert!(named("https://host.example/"));
        assert!(named("https://host.example"));
        assert!(!named("https://host.example/mc"));
        assert!(!named("https://other.example/mcp"));
    }

    #[test]
    fn metadata_addresses_follow_the_specification_order() {
        let issuer = Url::parse("https://auth.example.com/tenant1").unwrap();
        let found: Vec<String> = authorization_server_documents(&issuer)
            .iter()
            .map(Url::to_string)
            .collect();
        assert_eq!(
            found,
            [
                "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
                "https://auth.example.com/.well-known/openid-configuration/tenant1",
                "https://auth.example.com/tenant1/.well-known/openid-configuration",
            ]
        );
        let root = Url::parse("https://auth.example.com").unwrap();
        assert_eq!(authorization_server_documents(&root).len(), 2);
    }

    #[test]
    fn the_pkce_challenge_is_the_s256_of_the_verifier() {
        // RFC 7636, appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = BASE64URL.encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let pair = Pkce::new();
        assert_eq!(pair.verifier.len(), 43);
        assert_eq!(
            pair.challenge,
            BASE64URL.encode(Sha256::digest(pair.verifier.as_bytes()))
        );
    }
}
