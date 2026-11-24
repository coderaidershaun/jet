//! Web servers on the loopback address that stand in for outside services, for tests of the
//! clients that call out.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Starts a server that answers one request with `status` and `body`. It gives back its address
/// and a handle that ends with the request it got. A second request fails the test.
#[cfg(test)]
pub(crate) fn serve(status: u16, body: &str) -> (String, std::thread::JoinHandle<String>) {
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

/// One scripted answer of a `Paths` server.
pub struct Answer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Answer {
    pub fn json(status: u16, body: serde_json::Value) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: body.to_string(),
        }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }
}

/// A server that answers each request by its path, without the query, until the test ends: the
/// answers given for one path are used in order, and the last one repeats. A path with no answer
/// gets a 404, the way GitHub answers for a repository it does not show.
pub struct Paths {
    pub url: String,
    requests: Arc<Mutex<Vec<String>>>,
}

impl Paths {
    pub fn start(answers: Vec<(&str, Answer)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let mut answers: Vec<(String, Answer)> = answers
            .into_iter()
            .map(|(path, answer)| (path.to_owned(), answer))
            .collect();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let Some(head) = read_head(&mut stream) else {
                    continue;
                };
                let path = head
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .split('?')
                    .next()
                    .unwrap_or_default()
                    .to_owned();
                seen.lock().unwrap().push(head);
                let found = answers.iter().position(|(known, _)| *known == path);
                let is_repeated =
                    |at: usize| answers[at + 1..].iter().any(|(known, _)| *known == path);
                let (status, headers, body) = match found {
                    Some(at) if is_repeated(at) => {
                        let (_, answer) = answers.remove(at);
                        (answer.status, answer.headers, answer.body)
                    }
                    Some(at) => {
                        let answer = &answers[at].1;
                        (answer.status, answer.headers.clone(), answer.body.clone())
                    }
                    None => (404, Vec::new(), r#"{"message":"Not Found"}"#.to_owned()),
                };
                let mut response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                for (name, value) in headers {
                    response.push_str(&format!("{name}: {value}\r\n"));
                }
                response.push_str("\r\n");
                response.push_str(&body);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self { url, requests }
    }

    /// The head of each request so far, in order: the request line and the headers.
    pub fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

fn read_head(stream: &mut std::net::TcpStream) -> Option<String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut head = Vec::new();
    let mut buffer = [0; 4096];
    while !head.windows(4).any(|part| part == b"\r\n\r\n") {
        let count = stream.read(&mut buffer).ok()?;
        if count == 0 {
            return None;
        }
        head.extend_from_slice(&buffer[..count]);
    }
    Some(String::from_utf8_lossy(&head).into_owned())
}
