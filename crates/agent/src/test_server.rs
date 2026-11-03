//! A web server on the loopback address that answers one request, for tests of the clients that
//! call out.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread::JoinHandle;
use std::time::Duration;

/// Starts a server that answers one request with `status` and `body`. It gives back its address
/// and a handle that ends with the request it got. A second request fails the test.
pub(crate) fn serve(status: u16, body: &str) -> (String, JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let body = body.to_owned();
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let count = stream.read(&mut buffer).unwrap();
            request.extend_from_slice(&buffer[..count]);
            if let Some(at) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&request[..at]).to_ascii_lowercase();
                let length: usize = header
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                if request.len() >= at + 4 + length {
                    break;
                }
            }
            assert_ne!(count, 0);
        }
        let response = format!(
            "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).unwrap();
        listener.set_nonblocking(true).unwrap();
        assert!(listener.accept().is_err(), "more than one request came");
        String::from_utf8(request).unwrap()
    });
    (address, worker)
}
