//! Bound address lookup and the complete TLS handshake without timing out streamed bodies, and
//! check every address an app connection goes to, so a name that later points at the server is refused.
use agent::apps::{Reach, is_server_side_ip};
use axum::http::Uri;
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::client::legacy::connect::{
    HttpConnector,
    dns::{GaiResolver, Name},
};
use std::{
    future::Future,
    io,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};
use tower::Service;

#[derive(Clone)]
pub(super) struct Connector {
    inner: HttpsConnector<HttpConnector<Resolver>>,
    reach: Reach,
}
impl Connector {
    pub(super) fn new(reach: Reach) -> Result<Self, rustls::Error> {
        let mut http = HttpConnector::new_with_resolver(Resolver {
            inner: GaiResolver::new(),
            reach,
        });
        http.enforce_http(false);
        let inner = HttpsConnectorBuilder::new()
            .with_provider_and_webpki_roots(std::sync::Arc::new(
                rustls::crypto::ring::default_provider(),
            ))?
            .https_or_http()
            .enable_http1()
            .wrap_connector(http);
        Ok(Self { inner, reach })
    }
}
impl Service<Uri> for Connector {
    type Response = <HttpsConnector<HttpConnector<Resolver>> as Service<Uri>>::Response;
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;
    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx).map_err(io::Error::other)
    }
    fn call(&mut self, uri: Uri) -> Self::Future {
        // An address written as numbers is never looked up, so it is checked here.
        let literal = uri
            .host()
            .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok());
        if self.reach == Reach::PublicOnly && literal.is_some_and(is_server_side_ip) {
            return Box::pin(async { Err(server_side()) });
        }
        let connection = self.inner.call(uri);
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(2), connection)
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "app connection timed out"))?
                .map_err(io::Error::other)
        })
    }
}

/// Looks up the name of each connection. For an owner who may only reach public addresses, a name
/// that resolves to an address on the server or its private network is refused.
#[derive(Clone)]
pub(super) struct Resolver {
    inner: GaiResolver,
    reach: Reach,
}
impl Service<Name> for Resolver {
    type Response = std::vec::IntoIter<SocketAddr>;
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;
    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }
    fn call(&mut self, name: Name) -> Self::Future {
        let lookup = self.inner.call(name);
        let reach = self.reach;
        Box::pin(async move {
            let addresses: Vec<SocketAddr> = lookup.await?.collect();
            if reach == Reach::PublicOnly
                && addresses
                    .iter()
                    .any(|address| is_server_side_ip(address.ip()))
            {
                return Err(server_side());
            }
            Ok(addresses.into_iter())
        })
    }
}

fn server_side() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "the app's address is on the server or its private network, which only an admin's app may reach",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn connects(reach: Reach, address: &str) -> Result<(), String> {
        let mut connector = Connector::new(reach).unwrap();
        connector
            .call(address.parse().unwrap())
            .await
            .map(drop)
            .map_err(|error| format!("{error:?}"))
    }

    #[tokio::test]
    async fn only_an_admins_app_connects_to_a_name_or_number_on_the_server() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        for address in [
            format!("http://localhost:{port}/"),
            format!("http://127.0.0.1:{port}/"),
        ] {
            assert_eq!(connects(Reach::Anywhere, &address).await, Ok(()));
            let refused = connects(Reach::PublicOnly, &address).await.unwrap_err();
            assert!(refused.contains("private network"), "{address}: {refused}");
        }
    }
}
