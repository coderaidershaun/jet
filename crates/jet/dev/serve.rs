//! Serves the pages in `ui/` to a plain browser, so the chat (on its pretend agent), the workstation
//! (on its pretend feed) and the lab can be tried and checked without the desktop window. Run it
//! with `cargo run -p jet --example serve`, or pass a port after `--`.

use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::thread;
use std::time::Duration;

const HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8787;
const READ_TIMEOUT: Duration = Duration::from_secs(5);

/// The app's config, which holds the window's security policy. Every reply carries the same
/// policy, so a script or image that the app would block is blocked in the browser too.
const APP_CONFIG: &str = include_str!("../tauri.conf.json");

/// The rig sits outside `ui/`, but the pages ask for it as `../rig/jet.json` when they run
/// outside the desktop window.
const RIG_URL: &str = "/rig/jet.json";

struct Site {
    ui_dir: PathBuf,
    rig_file: PathBuf,
    csp: &'static str,
}

struct Reply {
    status: &'static str,
    content_type: &'static str,
    body: Vec<u8>,
}

impl Reply {
    fn text(status: &'static str, message: &'static str) -> Reply {
        Reply {
            status,
            content_type: "text/plain; charset=utf-8",
            body: message.as_bytes().to_vec(),
        }
    }
}

/// The `csp` string of the app config, found by a plain text search so the policy has one
/// copy. `None` when the policy is missing or is not a single string.
fn csp_of(config: &'static str) -> Option<&'static str> {
    let (_, after_key) = config.split_once("\"csp\"")?;
    let value = after_key
        .trim_start()
        .strip_prefix(':')?
        .trim_start()
        .strip_prefix('"')?;
    let (policy, _) = value.split_once('"')?;
    Some(policy)
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn port_from_args() -> io::Result<u16> {
    match std::env::args().nth(1) {
        None => Ok(DEFAULT_PORT),
        Some(text) => text.parse().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("the port must be a number from 0 to 65535, not {text:?}"),
            )
        }),
    }
}

fn main() -> io::Result<()> {
    let csp = csp_of(APP_CONFIG).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "tauri.conf.json has no \"csp\" string, so there is no policy to serve the pages under",
        )
    })?;
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let site = Site {
        ui_dir: manifest_dir.join("ui"),
        rig_file: manifest_dir.join("rig/jet.json"),
        csp,
    };
    let requested_port = port_from_args()?;
    let listener = TcpListener::bind((HOST, requested_port)).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("could not listen on port {requested_port} (pass another after --): {error}"),
        )
    })?;
    let port = listener.local_addr()?.port();
    println!("chat (on the pretend agent): http://{HOST}:{port}/");
    println!("lab:                         http://{HOST}:{port}/lab.html");
    println!("workstation (on the pretend feed): http://{HOST}:{port}/workstation.html");

    // A browser opens several connections at once, so each one gets its own thread.
    thread::scope(|scope| {
        for connection in listener.incoming() {
            match connection {
                Ok(stream) => {
                    scope.spawn(|| {
                        if let Err(error) = handle(stream, &site) {
                            eprintln!("serve: a request failed: {error}");
                        }
                    });
                }
                Err(error) => eprintln!("serve: a connection was not accepted: {error}"),
            }
        }
    });
    Ok(())
}

/// Reads one request, answers it, and closes the connection.
fn handle(mut stream: TcpStream, site: &Site) -> io::Result<()> {
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    // A browser also opens spare connections. It may close one, or leave it idle until the
    // read times out, without sending a request. Neither is a failure.
    match reader.read_line(&mut request_line) {
        Ok(0) => return Ok(()),
        Ok(_) => {}
        Err(error) if is_timeout(&error) => return Ok(()),
        Err(error) => return Err(error),
    }
    // Read the headers too: closing a socket that still holds unread data can cut the reply
    // off in the browser.
    let mut header = String::new();
    while reader.read_line(&mut header)? > "\r\n".len() {
        header.clear();
    }

    let reply = answer(&request_line, site);
    let head = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nContent-Security-Policy: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        reply.status,
        reply.content_type,
        reply.body.len(),
        site.csp,
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(&reply.body)?;
    stream.flush()
}

/// A read timeout comes back as `WouldBlock` on Unix and as `TimedOut` on Windows.
fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    )
}

fn answer(request_line: &str, site: &Site) -> Reply {
    let mut words = request_line.split_whitespace();
    let (Some(method), Some(target)) = (words.next(), words.next()) else {
        return Reply::text("400 Bad Request", "bad request");
    };
    if method != "GET" {
        return Reply::text("405 Method Not Allowed", "only GET is served");
    }
    let url_path = target.split(['?', '#']).next().unwrap_or_default();
    let Some(file) = file_for(url_path, site) else {
        return Reply::text("403 Forbidden", "forbidden");
    };
    if !file.is_file() {
        return Reply::text("404 Not Found", "not found");
    }
    match fs::read(&file) {
        Ok(body) => Reply {
            status: "200 OK",
            content_type: content_type(&file),
            body,
        },
        Err(error) => {
            eprintln!("serve: {} could not be read: {error}", file.display());
            Reply::text("500 Internal Server Error", "could not read the file")
        }
    }
}

/// The file a URL path names, or `None` when the path tries to leave `ui/`.
fn file_for(url_path: &str, site: &Site) -> Option<PathBuf> {
    if url_path == RIG_URL {
        return Some(site.rig_file.clone());
    }
    let relative = Path::new(url_path.trim_start_matches('/'));
    if !relative
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return None;
    }
    if relative.as_os_str().is_empty() {
        return Some(site.ui_dir.join("index.html"));
    }
    Some(site.ui_dir.join(relative))
}
