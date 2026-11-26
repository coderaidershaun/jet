//! Prove the sign-in through the real host: who gets in, what the cookies say, and what is refused.
use super::support::{Host, OWNER, PASSWORD, agent, cookie_header, listening_url, sign_in};
use serde_json::{Value, json};
use std::{
    path::Path,
    process::{Child, Command, Stdio},
};

const ACCOUNTS: [&str; 5] = [
    OWNER,
    "admin123@gmail.com",
    "admin1@gmail.com",
    "admin2@gmail.com",
    "admin3@gmail.com",
];

fn fresh(flags: &[&str]) -> Host {
    Host::launch_with(tempfile::tempdir().unwrap(), flags)
}

/// Posts to Jet as its own page does, with the given cookies.
fn post(host: &Host, path: &str, cookie: &str) -> ureq::http::Response<ureq::Body> {
    agent()
        .post(format!("{}{path}", host.url))
        .header("cookie", cookie)
        .header("origin", &host.origin)
        .send_empty()
        .unwrap()
}

fn me(host: &Host, cookie: &str) -> u16 {
    let response = agent()
        .get(format!("{}/api/auth/me", host.url))
        .header("cookie", cookie)
        .call()
        .unwrap();
    response.status().as_u16()
}

fn body(response: ureq::http::Response<ureq::Body>) -> Value {
    let mut response = response;
    serde_json::from_str(&response.body_mut().read_to_string().unwrap()).unwrap()
}

fn set_cookies<B>(response: &ureq::http::Response<B>) -> Vec<String> {
    response
        .headers()
        .get_all("set-cookie")
        .iter()
        .map(|value| value.to_str().unwrap().to_owned())
        .collect()
}

#[test]
fn every_kind_of_route_refuses_a_request_without_a_sign_in() {
    let host = fresh(&[]);
    let app = "00000000-0000-4000-8000-000000000000";
    let routes = [
        ("GET", "/".to_owned()),
        ("POST", "/api/chat/send".to_owned()),
        ("POST", "/api/chat/react".to_owned()),
        ("GET", "/api/events".to_owned()),
        ("GET", format!("/api/files/{app}")),
        ("POST", "/api/voice/speech".to_owned()),
        ("POST", "/api/voice/hear".to_owned()),
        ("GET", "/api/apps".to_owned()),
        ("GET", format!("/apps/{app}/")),
    ];
    for (method, path) in &routes {
        let request = ureq::http::Request::builder()
            .method(*method)
            .uri(format!("{}{path}", host.url))
            .header("origin", &host.url)
            .body(())
            .unwrap();
        let response = agent().run(request).unwrap();
        assert_eq!(response.status(), 401, "{method} {path}");
    }
    let page = agent()
        .get(format!("{}/", host.url))
        .header("sec-fetch-mode", "navigate")
        .call()
        .unwrap();
    assert_eq!(page.status(), 303);
    assert_eq!(page.headers()["location"], "/signin/?next=%2F");
    let deep = agent()
        .get(format!("{}/apps/notebook/view?a=1&b=two", host.url))
        .header("sec-fetch-mode", "navigate")
        .call()
        .unwrap();
    assert_eq!(
        deep.headers()["location"],
        "/signin/?next=%2Fapps%2Fnotebook%2Fview%3Fa%3D1%26b%3Dtwo",
        "the sign-in page is told where the person was going"
    );
    let mcp = agent().get(format!("{}/mcp", host.url)).call().unwrap();
    assert_eq!(mcp.status(), 401, "the facade still wants its turn token");
    let open = agent().get(format!("{}/signin/", host.url)).call().unwrap();
    assert_ne!(open.status(), 401, "the sign-in page needs no sign-in");
}

#[test]
fn the_owner_signs_in_and_jet_knows_who_they_are() {
    let host = fresh(&[]);
    let response = sign_in(&host.url, &host.url, "ShaunSurfing@Gmail.com", PASSWORD);
    assert_eq!(response.status(), 200);
    let cookie = cookie_header(&response);
    let answer = body(response);
    assert_eq!(answer["user"]["displayName"], "Shaun");
    assert_eq!(answer["user"]["isAdmin"], true);
    assert!(answer["accessExpiresAt"].as_u64().is_some(), "{answer}");
    let mut whoami = agent()
        .get(format!("{}/api/auth/me", host.url))
        .header("cookie", &cookie)
        .call()
        .unwrap();
    let whoami: Value = serde_json::from_str(&whoami.body_mut().read_to_string().unwrap()).unwrap();
    assert_eq!(whoami["user"]["email"], OWNER);
    assert!(whoami.to_string().find("password").is_none(), "{whoami}");
}

#[test]
fn cookies_are_http_only_and_same_site_and_secure_only_under_https() {
    let mut plain = fresh(&[]);
    let cookies = set_cookies(&sign_in(&plain.url, &plain.url, OWNER, PASSWORD));
    assert_eq!(cookies.len(), 2, "{cookies:?}");
    for cookie in &cookies {
        assert!(cookie.contains("; HttpOnly"), "{cookie}");
        assert!(cookie.contains("; SameSite="), "{cookie}");
        assert!(!cookie.contains("Secure"), "{cookie}");
    }
    let seeded = std::mem::replace(&mut plain.dir, tempfile::tempdir().unwrap());
    drop(plain);

    let operator = "the operator's own password";
    let (mut secure, url) = public(seeded.path(), &[("JET_SEED_PASSWORD", operator)]);
    let published = sign_in(&url, PUBLIC, OWNER, PASSWORD).status().as_u16();
    let cookies = set_cookies(&sign_in(&url, PUBLIC, OWNER, operator));
    secure.kill().unwrap();
    assert_eq!(published, 401, "a public host takes the published password");
    assert_eq!(cookies.len(), 2, "{cookies:?}");
    for cookie in &cookies {
        assert!(cookie.ends_with("; Secure"), "{cookie}");
    }
}

#[test]
fn a_wrong_password_and_an_unknown_email_get_the_same_answer() {
    let host = fresh(&[]);
    let wrong = sign_in(&host.url, &host.url, OWNER, "111000");
    let unknown = sign_in(&host.url, &host.url, "nobody@example.com", PASSWORD);
    assert_eq!(wrong.status(), 401);
    assert_eq!(unknown.status(), 401);
    assert!(set_cookies(&wrong).is_empty());
    assert_eq!(body(wrong), body(unknown));
}

#[test]
fn repeated_failures_are_limited_even_for_the_right_password() {
    let host = fresh(&[]);
    for _ in 0..5 {
        assert_eq!(sign_in(&host.url, &host.url, OWNER, "wrong").status(), 401);
    }
    let limited = sign_in(&host.url, &host.url, OWNER, PASSWORD);
    assert_eq!(limited.status(), 429);
    assert!(limited.headers().contains_key("retry-after"));
}

#[test]
fn guesses_sent_at_once_get_no_more_password_checks_than_the_limit() {
    let host = fresh(&[]);
    let answers: Vec<u16> = std::thread::scope(|scope| {
        let guesses: Vec<_> = (0..30)
            .map(|_| {
                scope.spawn(|| {
                    sign_in(&host.url, &host.url, OWNER, "wrong")
                        .status()
                        .as_u16()
                })
            })
            .collect();
        guesses
            .into_iter()
            .map(|guess| guess.join().unwrap())
            .collect()
    });
    let checked = answers.iter().filter(|status| **status == 401).count();
    assert_eq!(checked, 5, "{answers:?}");
    assert!(
        answers.iter().all(|status| matches!(status, 401 | 429)),
        "{answers:?}"
    );
}

/// Twenty failures from one address fill its count. Each try names a new email, so only the
/// address count can stop the last one.
fn twenty_failures_then_one_more(host: &Host) -> u16 {
    let attempt = |n: u32| {
        agent()
            .post(format!("{}/api/auth/signin", host.url))
            .header("origin", &host.url)
            .header("x-forwarded-for", format!("198.51.100.{n}"))
            .header("content-type", "application/json")
            .send(json!({"email": format!("nobody{n}@example.com"), "password": "x"}).to_string())
            .unwrap()
            .status()
            .as_u16()
    };
    for n in 0..20 {
        assert_eq!(attempt(n), 401);
    }
    attempt(20)
}

#[test]
fn a_forwarded_address_counts_only_when_the_trusted_proxy_sends_it() {
    let not_behind_proxy = fresh(&["--trusted-proxy", "192.0.2.1"]);
    assert_eq!(twenty_failures_then_one_more(&not_behind_proxy), 429);
    let behind_proxy = fresh(&[]);
    assert_eq!(twenty_failures_then_one_more(&behind_proxy), 401);
}

#[test]
fn a_refresh_replaces_the_token_and_a_replaced_token_ends_the_sign_in() {
    let host = fresh(&[]);
    let first = cookie_header(&sign_in(&host.url, &host.url, OWNER, PASSWORD));
    let renewed = post(&host, "/api/auth/refresh", &first);
    assert_eq!(renewed.status(), 200);
    let second = cookie_header(&renewed);
    let refresh = |cookie: &str| {
        cookie
            .split("; ")
            .find(|c| c.starts_with("jet_refresh="))
            .map(str::to_owned)
    };
    assert_ne!(refresh(&first), refresh(&second));
    assert_eq!(me(&host, &second), 200);
    let third = cookie_header(&post(&host, "/api/auth/refresh", &second));
    assert_eq!(me(&host, &third), 200);

    assert_eq!(post(&host, "/api/auth/refresh", &first).status(), 401);
    assert_eq!(me(&host, &third), 401, "reuse ends the whole sign-in");
    assert_eq!(post(&host, "/api/auth/refresh", &third).status(), 401);
}

#[test]
fn a_renewal_whose_answer_was_lost_does_not_end_the_sign_in() {
    let host = fresh(&[]);
    let held = cookie_header(&sign_in(&host.url, &host.url, OWNER, PASSWORD));
    // The server renews, but the answer never reaches the browser, which keeps `held`.
    let lost = post(&host, "/api/auth/refresh", &held);
    assert_eq!(lost.status(), 200);
    let never_seen = cookie_header(&lost);
    let retried = post(&host, "/api/auth/refresh", &held).status().as_u16();
    let held_access = me(&host, &held);
    let unseen_access = me(&host, &never_seen);
    assert_eq!(
        (retried, held_access, unseen_access),
        (200, 200, 200),
        "one renewal answer lost on the network ends the whole 30-day sign-in"
    );
}

#[test]
fn a_replaced_token_offered_a_minute_later_ends_the_sign_in() {
    let host = fresh(&[]);
    let first = cookie_header(&sign_in(&host.url, &host.url, OWNER, PASSWORD));
    let second = cookie_header(&post(&host, "/api/auth/refresh", &first));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    host.set_clock(now + 61);
    assert_eq!(post(&host, "/api/auth/refresh", &first).status(), 401);
    assert_eq!(me(&host, &second), 401, "reuse ends the whole sign-in");
}

#[test]
fn a_tampered_token_is_refused() {
    let host = fresh(&[]);
    let cookie = host.cookie.clone();
    assert_eq!(me(&host, &cookie), 200);
    let access = cookie
        .split("; ")
        .find(|c| c.starts_with("jet_access="))
        .unwrap();
    let (signed, signature) = access.rsplit_once('.').unwrap();
    let swapped = if signature.starts_with('A') { 'B' } else { 'A' };
    let tampered = format!("{signed}.{swapped}{}", &signature[1..]);
    assert_eq!(me(&host, &tampered), 401);
}

#[test]
fn sign_out_ends_the_sign_in() {
    let host = fresh(&[]);
    let cookie = host.cookie.clone();
    let out = post(&host, "/api/auth/signout", &cookie);
    assert_eq!(out.status(), 200);
    assert!(set_cookies(&out).iter().all(|c| c.contains("Max-Age=0")));
    assert_eq!(me(&host, &cookie), 401);
    assert_eq!(post(&host, "/api/auth/refresh", &cookie).status(), 401);
}

#[test]
fn a_post_from_another_site_or_without_origin_is_refused_even_with_a_valid_cookie() {
    let host = fresh(&[]);
    let markdown = |origin: Option<&str>, site: Option<&str>| {
        let mut request = agent()
            .post(format!("{}/api/markdown", host.url))
            .header("cookie", &host.cookie)
            .header("content-type", "application/json");
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        if let Some(site) = site {
            request = request.header("sec-fetch-site", site);
        }
        request
            .send(json!({"text": "hi"}).to_string())
            .unwrap()
            .status()
            .as_u16()
    };
    assert_eq!(markdown(Some(&host.url), Some("same-origin")), 200);
    assert_eq!(markdown(Some("https://evil.test"), None), 403);
    assert_eq!(markdown(None, None), 403);
    assert_eq!(markdown(Some(&host.url), Some("cross-site")), 403);
}

#[test]
fn the_seed_run_twice_leaves_five_accounts_that_each_sign_in() {
    let dir = tempfile::tempdir().unwrap();
    for added in ["seeded 5 new accounts", "seeded 0 new accounts"] {
        let output = Command::new(env!("CARGO_BIN_EXE_jet"))
            .args(["seed", "--data-dir"])
            .arg(dir.path())
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(added),
            "{output:?}"
        );
    }
    let host = Host::launch_with(dir, &[]);
    for email in ACCOUNTS {
        assert_eq!(
            sign_in(&host.url, &host.url, email, PASSWORD).status(),
            200,
            "{email}"
        );
    }
}

#[test]
fn the_database_holds_no_password_in_clear_text() {
    let host = fresh(&[]);
    let mut bytes = Vec::new();
    for name in ["jet.sqlite3", "jet.sqlite3-wal"] {
        bytes.extend(std::fs::read(host.dir.path().join(name)).unwrap_or_default());
    }
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("$argon2id$"), "the hashes were not found");
    assert!(!text.contains(PASSWORD));
}

const PUBLIC: &str = "https://jet.test";

/// Starts Jet on a public https origin with the given environment, without signing anyone in.
fn public(dir: &Path, env: &[(&str, &str)]) -> (Child, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_jet"))
        .args([
            "--listen",
            "127.0.0.1:0",
            "--disable-feelings",
            "--disable-voice",
        ])
        .args(["--public-origin", PUBLIC, "--data-dir"])
        .arg(dir)
        .env_remove("JET_SEED_PASSWORD")
        .envs(env.iter().copied())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let url = listening_url(&mut child);
    (child, url)
}

#[test]
fn a_public_host_refuses_the_published_seed_password() {
    let dir = tempfile::tempdir().unwrap();
    let (mut child, url) = public(dir.path(), &[]);
    let status = sign_in(&url, PUBLIC, OWNER, PASSWORD).status().as_u16();
    child.kill().unwrap();
    assert_eq!(
        status, 401,
        "a public host takes the password that the source publishes"
    );
}

/// The `exp` claim of a JSON Web Token, read without checking its signature.
fn expiry_of(token: &str) -> u64 {
    use base64::Engine;
    let claims = token.split('.').nth(1).expect("a token has three parts");
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(claims)
        .expect("the claims are base64url");
    let claims: Value = serde_json::from_slice(&bytes).expect("the claims are JSON");
    claims["exp"].as_u64().expect("the claims hold exp")
}

#[test]
fn an_app_proof_in_the_address_lasts_an_hour_at_most() {
    let host = fresh(&[]);
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}/", closed.local_addr().unwrap());
    drop(closed);
    let (status, added) = host.post("/api/apps", json!({"action": "add", "address": address}));
    assert_eq!(status, 200, "{added}");
    let id = added["app"]["id"].as_str().unwrap().to_owned();
    let opened = agent()
        .get(format!("{}/apps/{id}/", host.url))
        .header("cookie", &host.cookie)
        .header("sec-fetch-mode", "navigate")
        .header("sec-fetch-dest", "document")
        .header("sec-fetch-site", "same-origin")
        .call()
        .unwrap();
    assert_eq!(opened.status(), 307);
    let location = opened.headers()["location"].to_str().unwrap().to_owned();
    let proof = location
        .split('~')
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // Anyone who reads the address, in a log or a history, can use the proxy as this user until the proof runs out.
    let lasts = expiry_of(proof).saturating_sub(now);
    assert!(
        lasts <= 60 * 60,
        "the proof in an app address lasts {lasts} s"
    );
}
