//! A stand-in for a library's MCP server, for tests. It serves the same streamable HTTP as
//! quanty and polysim do, and what it does is chosen by marker files in its own folder, so
//! tests that run side by side never share settings. Like polysim, it stops when its input
//! closes if it is started with `--watch-stdin`.

use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{Value, json};

const PIDS_FILE: &str = "fake-mcp-pids";
const REQUESTS_FILE: &str = "fake-mcp-requests.jsonl";
/// Gets a line each time the program stops because its input closed.
const STDIN_CLOSED_FILE: &str = "stdin-closed";
/// When this file exists, the program behaves like one that has no `--http` mode.
const NO_HTTP_MARKER: &str = "no-http";
/// When this file exists, every answer comes as an event stream, as quanty sends it.
const STREAM_MARKER: &str = "sse";

struct Request {
    /// Header names in lower case.
    headers: Vec<(String, String)>,
    body: Value,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        let found = self.headers.iter().find(|(key, _)| key == name);
        found.map(|(_, value)| value.as_str())
    }
}

/// What the program says back, and whether it dies right after saying it.
struct Answer {
    status: u16,
    /// The session id to hand out, for `initialize`.
    session: Option<String>,
    body: Option<Value>,
    crash: bool,
}

impl Answer {
    fn status(status: u16) -> Answer {
        Answer {
            status,
            session: None,
            body: None,
            crash: false,
        }
    }

    fn body(body: Value) -> Answer {
        Answer {
            body: Some(body),
            ..Answer::status(200)
        }
    }
}

/// The sessions handed out so far.
struct Server {
    sessions: Mutex<HashSet<String>>,
    opened: AtomicU64,
}

/// What the program was asked to do on its command line.
struct Options {
    port: u16,
    stops_when_input_closes: bool,
}

/// Reads `--http <port>`, optionally followed by `--watch-stdin`. A folder with the
/// `no-http` marker makes the program behave like one that has no `--http` mode.
fn parse_options(args: &[String]) -> Option<Options> {
    if Path::new(NO_HTTP_MARKER).exists() {
        return None;
    }
    match args {
        [http, port] if http == "--http" => Some(Options {
            port: port.parse().ok()?,
            stops_when_input_closes: false,
        }),
        [http, port, watch] if http == "--http" && watch == "--watch-stdin" => Some(Options {
            port: port.parse().ok()?,
            stops_when_input_closes: true,
        }),
        _ => None,
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(options) = parse_options(&args) else {
        eprintln!(
            "fake-mcp: unknown arguments {args:?}\nusage: fake-mcp --http <port> [--watch-stdin]"
        );
        return ExitCode::from(2);
    };
    if options.stops_when_input_closes {
        stop_when_input_closes();
    }
    match serve(options.port) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("fake-mcp: {error}");
            ExitCode::from(1)
        }
    }
}

/// Reads the program's input to the end on a thread of its own, then notes that it closed
/// and exits. An input that cannot be read is as good as one that closed.
fn stop_when_input_closes() {
    std::thread::spawn(|| {
        if let Err(error) = io::copy(&mut io::stdin(), &mut io::sink()) {
            eprintln!("fake-mcp: could not read its input: {error}");
        }
        if let Err(error) = append(STDIN_CLOSED_FILE, "closed") {
            eprintln!("fake-mcp: could not note that its input closed: {error}");
        }
        std::process::exit(0);
    });
}

fn serve(port: u16) -> io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    append(PIDS_FILE, &std::process::id().to_string())?;
    eprintln!("fake-mcp: listening on http://127.0.0.1:{port}/mcp");
    let server = Arc::new(Server {
        sessions: Mutex::new(HashSet::new()),
        opened: AtomicU64::new(0),
    });
    for stream in listener.incoming().flatten() {
        let server = Arc::clone(&server);
        std::thread::spawn(move || {
            if let Err(error) = handle(&server, stream) {
                eprintln!("fake-mcp: {error}");
            }
        });
    }
    Ok(())
}

fn append(file: &str, line: &str) -> io::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(file)?;
    file.write_all(format!("{line}\n").as_bytes())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn read_request(stream: &TcpStream) -> io::Result<Request> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut headers = Vec::new();
    loop {
        line.clear();
        reader.read_line(&mut line)?;
        let Some((name, value)) = line.trim_end().split_once(':') else {
            break;
        };
        headers.push((name.to_ascii_lowercase(), value.trim().to_owned()));
    }
    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
    Ok(Request { headers, body })
}

fn handle(server: &Server, mut stream: TcpStream) -> io::Result<()> {
    let request = read_request(&stream)?;
    let answer = answer(server, &request);
    let log = json!({
        "method": request.body["method"],
        "session": request.header("mcp-session-id"),
        "protocol": request.header("mcp-protocol-version"),
        "accept": request.header("accept"),
        "status": answer.status,
    });
    append(REQUESTS_FILE, &log.to_string())?;
    reply(&mut stream, &answer)?;
    if answer.crash {
        std::process::exit(3);
    }
    Ok(())
}

fn answer(server: &Server, request: &Request) -> Answer {
    let method = request.body["method"].as_str().unwrap_or_default();
    let id = request.body["id"].clone();
    if method == "initialize" {
        let n = server.opened.fetch_add(1, Ordering::SeqCst);
        let session = format!("fake-{}-{n}", std::process::id());
        lock(&server.sessions).insert(session.clone());
        let result = json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake-mcp", "version": "0"},
        });
        return Answer {
            session: Some(session),
            ..Answer::body(rpc_result(id, result))
        };
    }
    let known = request
        .header("mcp-session-id")
        .is_some_and(|session| lock(&server.sessions).contains(session));
    if !known {
        return Answer::status(404);
    }
    match method {
        "notifications/initialized" => Answer::status(202),
        "tools/call" => {
            let name = request.body["params"]["name"].as_str().unwrap_or_default();
            let arguments = &request.body["params"]["arguments"];
            if name == "forget_sessions" {
                lock(&server.sessions).clear();
            }
            let body = match name {
                "echo" | "forget_sessions" | "crash" => rpc_result(id, echo(arguments)),
                "fail" => rpc_result(id, failure()),
                _ => rpc_error(id, -32601, "no such tool"),
            };
            Answer {
                crash: name == "crash",
                ..Answer::body(body)
            }
        }
        _ => Answer::body(rpc_error(id, -32601, "no such method")),
    }
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn echo(arguments: &Value) -> Value {
    json!({
        "content": [{"type": "text", "text": arguments.to_string()}],
        "structuredContent": {"echo": arguments},
        "isError": false,
    })
}

fn failure() -> Value {
    json!({
        "content": [{"type": "text", "text": "strat-x · te-y is not running"}],
        "isError": true,
    })
}

fn reply(stream: &mut TcpStream, answer: &Answer) -> io::Result<()> {
    let reason = match answer.status {
        200 => "OK",
        202 => "Accepted",
        _ => "Not Found",
    };
    let mut head = format!(
        "HTTP/1.1 {} {reason}\r\nConnection: close\r\n",
        answer.status
    );
    if let Some(session) = &answer.session {
        head.push_str(&format!("Mcp-Session-Id: {session}\r\n"));
    }
    let Some(body) = &answer.body else {
        let text = if answer.status == 404 {
            "Not Found: Session not found"
        } else {
            ""
        };
        head.push_str(&format!("Content-Length: {}\r\n\r\n{text}", text.len()));
        return stream.write_all(head.as_bytes());
    };
    if !Path::new(STREAM_MARKER).exists() {
        let text = body.to_string();
        head.push_str("Content-Type: application/json\r\n");
        head.push_str(&format!("Content-Length: {}\r\n\r\n{text}", text.len()));
        return stream.write_all(head.as_bytes());
    }
    head.push_str("Content-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    write_events(stream, body)
}

/// The answer as quanty sends it: an event stream in chunks, with other messages first.
fn write_events(stream: &mut TcpStream, body: &Value) -> io::Result<()> {
    // Before the answer come things a client must skip: a notification, a request from the
    // server that happens to reuse the id, and an answer to some other request.
    let note = json!({
        "jsonrpc": "2.0",
        "method": "notifications/message",
        "params": {"level": "info", "data": "working"},
    });
    let ping = json!({"jsonrpc": "2.0", "id": body["id"], "method": "ping"});
    let stray = rpc_result(json!("someone-else"), json!({}));
    let events = [
        "data: \nid: 0\nretry: 3000\n\n".to_owned(),
        format!("data: {note}\nid: 1/0\n\n"),
        format!("data: {ping}\nid: 2/0\n\n"),
        format!("data: {stray}\nid: 3/0\n\n"),
        format!("data: {body}\nid: 4/0\n\n"),
    ];
    for event in events {
        stream.write_all(format!("{:x}\r\n{event}\r\n", event.len()).as_bytes())?;
        stream.flush()?;
    }
    stream.write_all(b"0\r\n\r\n")
}
