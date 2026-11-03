//! Bound address lookup and the complete TLS handshake without timing out streamed bodies.
use axum::http::Uri;
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::client::legacy::connect::HttpConnector;
use std::{
    future::Future,
    io,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};
use tower::Service;

#[derive(Clone)]
pub(super) struct Connector(HttpsConnector<HttpConnector>);
impl Connector {
    pub(super) fn new() -> Result<Self, rustls::Error> {
        let mut http = HttpConnector::new();
        http.enforce_http(false);
        Ok(Self(
            HttpsConnectorBuilder::new()
                .with_provider_and_webpki_roots(std::sync::Arc::new(
                    rustls::crypto::ring::default_provider(),
                ))?
                .https_or_http()
                .enable_http1()
                .wrap_connector(http),
        ))
    }
}
impl Service<Uri> for Connector {
    type Response = <HttpsConnector<HttpConnector> as Service<Uri>>::Response;
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;
    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.0.poll_ready(cx).map_err(io::Error::other)
    }
    fn call(&mut self, uri: Uri) -> Self::Future {
        let connection = self.0.call(uri);
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(2), connection)
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "app connection timed out"))?
                .map_err(io::Error::other)
        })
    }
}
