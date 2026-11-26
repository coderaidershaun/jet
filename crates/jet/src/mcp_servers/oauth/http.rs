//! The network side of a sign-in: the challenge a server answers with, its metadata, registering
//! Jet as a client, and the token requests. It follows no redirect and keeps answers small.

use super::{
    SignInError, refusal,
    request::{
        Challenge, WellKnown, authorization_server_documents, canonical, names_server, well_known,
    },
};
use agent::apps::reaches_server_side;
use base64::Engine;
use serde_json::{Value, json};
use std::time::Duration;
use url::Url;

/// The longest any request to a server or its sign-in server may take.
const TIMEOUT: Duration = Duration::from_secs(10);
/// A metadata or token answer longer than this is not one.
const BODY_LIMIT: usize = 64 * 1024;

/// How a server's sign-in server works, from its metadata.
pub(in crate::mcp_servers) struct Provider {
    pub issuer: String,
    pub authorization_endpoint: Url,
    pub token_endpoint: Url,
    pub registration_endpoint: Option<Url>,
    pub resource: String,
    pub scope: Option<String>,
    pub secret_in_body: bool,
}

/// A client Jet registered. It has no `Debug` print, so the secret cannot reach a log line.
pub(in crate::mcp_servers) struct Registered {
    pub client_id: String,
    pub client_secret: Option<String>,
}

/// What a token request gave. It has no `Debug` print, so no token can reach a log line.
pub(in crate::mcp_servers) struct Tokens {
    pub access: String,
    pub refresh: Option<String>,
    pub expires_in: Option<u64>,
}

/// The client a token request is made as.
pub(in crate::mcp_servers) struct Client<'a> {
    pub id: &'a str,
    pub secret: Option<&'a str>,
    pub secret_in_body: bool,
}

/// The HTTP side of a sign-in, for one server. It follows no redirect and reaches this server or a
/// private network only when the server itself is there, which only an admin may set up.
pub(in crate::mcp_servers) struct OAuthHttp {
    client: reqwest::Client,
    may_reach_server_side: bool,
}

impl OAuthHttp {
    pub(in crate::mcp_servers) fn new(server: &Url) -> Result<Self, SignInError> {
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| SignInError::Unreachable {
                url: server.to_string(),
                message: error.to_string(),
            })?;
        Ok(Self {
            client,
            may_reach_server_side: reaches_server_side(server),
        })
    }

    fn check(&self, url: &Url) -> Result<(), SignInError> {
        let server_side = reaches_server_side(url);
        let allowed = match url.scheme() {
            "https" => !server_side || self.may_reach_server_side,
            "http" => server_side && self.may_reach_server_side,
            _ => false,
        };
        match allowed {
            true => Ok(()),
            false => Err(SignInError::UnsafeAddress(url.to_string())),
        }
    }

    /// Sends the request and reads at most `BODY_LIMIT` bytes of the answer.
    async fn send(
        &self,
        url: &Url,
        request: reqwest::RequestBuilder,
    ) -> Result<(u16, Option<String>, Vec<u8>), SignInError> {
        let unreachable = |error: reqwest::Error| SignInError::Unreachable {
            url: url.to_string(),
            message: error.without_url().to_string(),
        };
        let mut response = request.send().await.map_err(unreachable)?;
        let status = response.status().as_u16();
        let challenge = response
            .headers()
            .get(reqwest::header::WWW_AUTHENTICATE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(unreachable)? {
            body.extend_from_slice(&chunk);
            if body.len() > BODY_LIMIT {
                return Err(SignInError::BadAnswer(format!(
                    "{url} sent more than {BODY_LIMIT} bytes"
                )));
            }
        }
        Ok((status, challenge, body))
    }

    /// Finds how the server signs in, from the challenge it answers a request with no credentials.
    pub(in crate::mcp_servers) async fn provider(
        &self,
        server: &Url,
    ) -> Result<Provider, SignInError> {
        let challenge = self.probe(server).await?;
        self.discover(server, challenge).await
    }

    /// Asks the server to start a session with no credentials, and reads the challenge it answers
    /// with. A server that lets Jet in needs no sign-in.
    async fn probe(&self, server: &Url) -> Result<Challenge, SignInError> {
        let initialize = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"Jet","version":env!("CARGO_PKG_VERSION")}}});
        let request = self
            .client
            .post(server.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .body(initialize.to_string());
        let (status, challenge, _) = self.send(server, request).await?;
        match status {
            401 | 403 => Ok(challenge
                .map(|header| Challenge::parse(&header, server))
                .unwrap_or_default()),
            200..=299 => Err(SignInError::NotNeeded),
            other => Err(SignInError::NoChallenge(other)),
        }
    }

    /// A JSON object at `url`, or `None` when nothing is published there.
    async fn document(
        &self,
        url: &Url,
    ) -> Result<Option<serde_json::Map<String, Value>>, SignInError> {
        self.check(url)?;
        let request = self
            .client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "application/json");
        let (status, _, body) = self.send(url, request).await?;
        if status != 200 {
            return Ok(None);
        }
        Ok(serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|value| value.as_object().cloned()))
    }

    /// Finds the server's sign-in server (RFC 9728, then RFC 8414 or OpenID Connect discovery) and
    /// checks that it can sign Jet in with PKCE S256.
    async fn discover(&self, server: &Url, challenge: Challenge) -> Result<Provider, SignInError> {
        let host = server.host_str().unwrap_or_default().to_owned();
        let candidates = match &challenge.resource_metadata {
            Some(url) => vec![url.clone()],
            None => well_known(server, "oauth-protected-resource", WellKnown::PathAfter)
                .into_iter()
                .chain(well_known(
                    server,
                    "oauth-protected-resource",
                    WellKnown::Root,
                ))
                .collect(),
        };
        let mut found = None;
        for url in candidates {
            if let Some(document) = self.document(&url).await? {
                found = Some((url, document));
                break;
            }
        }
        let (metadata_url, resource) = found.ok_or(SignInError::NoMetadata(host))?;
        let invalid = |problem: &str| SignInError::Metadata {
            url: metadata_url.to_string(),
            problem: problem.to_owned(),
        };
        let resource_id = match resource.get("resource").and_then(Value::as_str) {
            Some(named) => {
                let named_url =
                    Url::parse(named).map_err(|_| invalid("its resource is not an address"))?;
                if !names_server(&named_url, server) {
                    return Err(invalid("it names another server as its resource"));
                }
                named.to_owned()
            }
            None => canonical(server),
        };
        let issuer = resource
            .get("authorization_servers")
            .and_then(Value::as_array)
            .and_then(|servers| servers.first())
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("it names no authorization server"))?;
        let issuer_url = Url::parse(issuer)
            .map_err(|_| invalid("its authorization server is not an address"))?;
        self.check(&issuer_url)?;
        let scope = challenge.scope.or_else(|| {
            let scopes: Vec<&str> = resource
                .get("scopes_supported")?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .collect();
            (!scopes.is_empty()).then(|| scopes.join(" "))
        });
        let mut metadata = None;
        for url in authorization_server_documents(&issuer_url) {
            if let Some(document) = self.document(&url).await? {
                metadata = Some((url, document));
                break;
            }
        }
        let (url, metadata) = metadata.ok_or_else(|| SignInError::Metadata {
            url: issuer.to_owned(),
            problem: "it publishes no authorization server metadata".into(),
        })?;
        let invalid = |problem: &str| SignInError::Metadata {
            url: url.to_string(),
            problem: problem.to_owned(),
        };
        let named = metadata
            .get("issuer")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if named.trim_end_matches('/') != issuer.trim_end_matches('/') {
            return Err(invalid("its issuer is not the server that sent Jet there"));
        }
        let lists = |key: &str, value: &str| {
            metadata
                .get(key)
                .and_then(Value::as_array)
                .is_some_and(|values| values.iter().any(|listed| listed == value))
        };
        if !lists("code_challenge_methods_supported", "S256") {
            return Err(SignInError::NoPkce(issuer.to_owned()));
        }
        let endpoint = |key: &str| -> Result<Option<Url>, SignInError> {
            let Some(address) = metadata.get(key).and_then(Value::as_str) else {
                return Ok(None);
            };
            let url = Url::parse(address)
                .map_err(|_| invalid(&format!("its {key} is not an address")))?;
            self.check(&url)?;
            Ok(Some(url))
        };
        let required =
            |key: &str| endpoint(key)?.ok_or_else(|| invalid(&format!("it gives no {key}")));
        Ok(Provider {
            issuer: issuer.to_owned(),
            authorization_endpoint: required("authorization_endpoint")?,
            token_endpoint: required("token_endpoint")?,
            registration_endpoint: endpoint("registration_endpoint")?,
            resource: resource_id,
            scope,
            secret_in_body: lists(
                "token_endpoint_auth_methods_supported",
                "client_secret_post",
            ),
        })
    }

    /// Registers Jet as a public client that signs in with a code and PKCE (RFC 7591).
    pub(in crate::mcp_servers) async fn register(
        &self,
        provider: &Provider,
        endpoint: &Url,
        redirect_uri: &str,
    ) -> Result<Registered, SignInError> {
        let request = json!({
            "client_name": "Jet",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        });
        let request = self
            .client
            .post(endpoint.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json")
            .body(request.to_string());
        let (status, _, body) = self.send(endpoint, request).await?;
        let answer: Value = serde_json::from_slice(&body).unwrap_or_default();
        let refused = |message: String| SignInError::Registration {
            issuer: provider.issuer.clone(),
            message,
        };
        if !(200..=299).contains(&status) {
            let error = answer["error"].as_str().unwrap_or("no reason given");
            let description = answer["error_description"].as_str();
            return Err(refused(format!(
                "HTTP {status}, {}",
                refusal(error, description)
            )));
        }
        let client_id = answer["client_id"]
            .as_str()
            .filter(|id| (1..=512).contains(&id.len()))
            .ok_or_else(|| refused("its answer has no client id".into()))?;
        Ok(Registered {
            client_id: client_id.to_owned(),
            client_secret: answer["client_secret"].as_str().map(str::to_owned),
        })
    }

    /// Trades the code the provider sent back for tokens.
    pub(in crate::mcp_servers) async fn exchange(
        &self,
        token_endpoint: &str,
        client: &Client<'_>,
        resource: &str,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<Tokens, SignInError> {
        let form = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
            ("resource", resource),
        ];
        self.token(token_endpoint, client, &form).await
    }

    /// Trades a refresh token for a new access token, and maybe a new refresh token.
    pub(in crate::mcp_servers) async fn refresh(
        &self,
        token_endpoint: &str,
        client: &Client<'_>,
        resource: &str,
        refresh: &str,
    ) -> Result<Tokens, SignInError> {
        let form = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
            ("resource", resource),
        ];
        self.token(token_endpoint, client, &form).await
    }

    async fn token(
        &self,
        token_endpoint: &str,
        client: &Client<'_>,
        form: &[(&str, &str)],
    ) -> Result<Tokens, SignInError> {
        let url = Url::parse(token_endpoint)
            .map_err(|_| SignInError::UnsafeAddress(token_endpoint.into()))?;
        self.check(&url)?;
        let mut pairs: Vec<(&str, &str)> = form.to_vec();
        pairs.push(("client_id", client.id));
        let mut request = self
            .client
            .post(url.clone())
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .header(reqwest::header::ACCEPT, "application/json");
        match (client.secret, client.secret_in_body) {
            (Some(secret), true) => pairs.push(("client_secret", secret)),
            (Some(secret), false) => {
                request = request.header(reqwest::header::AUTHORIZATION, basic(client.id, secret)?)
            }
            (None, _) => {}
        }
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs)
            .finish();
        let (status, _, answer) = self.send(&url, request.body(body)).await?;
        let answer: Value = serde_json::from_slice(&answer).unwrap_or_default();
        if status != 200 {
            return Err(SignInError::Refused {
                error: answer["error"]
                    .as_str()
                    .map_or_else(|| format!("HTTP {status}"), str::to_owned),
                description: answer["error_description"].as_str().map(str::to_owned),
            });
        }
        let token_type = answer["token_type"].as_str().unwrap_or("Bearer");
        if !token_type.eq_ignore_ascii_case("bearer") {
            return Err(SignInError::BadAnswer(format!(
                "it gave a {token_type:?} token, and Jet sends only bearer tokens"
            )));
        }
        let access = answer["access_token"]
            .as_str()
            .filter(|token| is_header_safe(token))
            .ok_or_else(|| SignInError::BadAnswer("it gave no access token".into()))?;
        Ok(Tokens {
            access: access.to_owned(),
            refresh: answer["refresh_token"]
                .as_str()
                .filter(|token| !token.is_empty())
                .map(str::to_owned),
            expires_in: answer["expires_in"].as_u64(),
        })
    }
}

/// The RFC 6749 `client_secret_basic` header: the id and secret, each form-encoded first.
fn basic(id: &str, secret: &str) -> Result<reqwest::header::HeaderValue, SignInError> {
    let encode =
        |text: &str| -> String { url::form_urlencoded::byte_serialize(text.as_bytes()).collect() };
    let pair = format!("{}:{}", encode(id), encode(secret));
    let encoded = base64::engine::general_purpose::STANDARD.encode(pair);
    let mut value = reqwest::header::HeaderValue::from_str(&format!("Basic {encoded}"))
        .map_err(|_| SignInError::BadAnswer("the client secret is not one line of text".into()))?;
    value.set_sensitive(true);
    Ok(value)
}

/// Whether a token can go in an `Authorization` header as it is.
fn is_header_safe(token: &str) -> bool {
    (1..=8192).contains(&token.len()) && token.bytes().all(|byte| (b'!'..=b'~').contains(&byte))
}
