//! What happened in one GitHub repository, read from GitHub's REST API as a few compact facts.
//! The client reaches only GitHub's API host, follows no redirect to another host, and limits
//! the time and the size of each answer.

use super::tokens::{GithubToken, TokenError};
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

pub(crate) const API: &str = "https://api.github.com";
/// Only debug builds read it, so that tests can point the client at a stand-in for GitHub.
#[cfg(debug_assertions)]
const API_VARIABLE: &str = "JET_GITHUB_API";
const CALL_LIMIT: Duration = Duration::from_secs(10);
const ANSWER_LIMIT: u64 = 2 * 1024 * 1024;
const REDIRECT_LIMIT: usize = 3;
/// The longest wait GitHub may ask for that the tool sits out before it tries again, once.
const SHORT_WAIT_SECONDS: u64 = 10;
const PAGE: &str = "30";
const TITLE_LIMIT: usize = 200;

#[derive(Debug, thiserror::Error)]
pub(crate) enum GithubError {
    #[error(
        "`{repo}` is not a repository name; write it as owner/name, such as anthropics/claude-code"
    )]
    BadRepo { repo: String },
    #[error(
        "GitHub could not be reached ({detail}). Tell the user that GitHub did not answer, so you could not check it, and that you can try again later"
    )]
    Unreachable { detail: String },
    #[error(
        "GitHub answered {status} for {repo}: it is private or does not exist. Tell the user to check the name, and that they can paste a GitHub token that can read it in Settings so that Jet can read private repositories"
    )]
    TokenMissing { repo: String, status: u16 },
    #[error(
        "GitHub refused the user's saved token for {repo} (status {status}): the token is wrong, has expired, or cannot read this repository. Tell the user to paste a new token that can read it in Settings"
    )]
    TokenRejected { repo: String, status: u16 },
    #[error(
        "GitHub's request quota is used up for the next {wait_seconds} seconds. Tell the user you could not check the repository now and will try again later"
    )]
    Quota { wait_seconds: u64 },
    #[error(
        "the user's saved GitHub token could not be read. Tell the user to paste their token again in Settings"
    )]
    Token(#[from] TokenError),
}

impl GithubError {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::BadRepo { .. } => "githubBadRepo",
            Self::Unreachable { .. } => "githubUnreachable",
            Self::TokenMissing { .. } => "githubTokenMissing",
            Self::TokenRejected { .. } => "githubTokenRejected",
            Self::Quota { .. } => "githubQuota",
            Self::Token(_) => "githubTokenUnreadable",
        }
    }
}

/// A repository as `owner/name`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Repo(String);

impl Repo {
    pub(crate) fn parse(text: &str) -> Result<Self, GithubError> {
        let bad = || GithubError::BadRepo {
            repo: text.to_owned(),
        };
        let (owner, name) = text.split_once('/').ok_or_else(bad)?;
        let owner_ok = (1..=39).contains(&owner.len())
            && owner
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-');
        let name_ok = (1..=100).contains(&name.len())
            && name.bytes().any(|b| b != b'.')
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
        if owner_ok && name_ok {
            Ok(Self(text.to_owned()))
        } else {
            Err(bad())
        }
    }
}

#[derive(Clone)]
pub(crate) struct Github {
    base: Url,
    agent: ureq::Agent,
}

impl Github {
    /// The client for `https://api.github.com`.
    pub(crate) fn new() -> Self {
        #[cfg(debug_assertions)]
        if let Ok(base) = std::env::var(API_VARIABLE) {
            return Self::at(&base);
        }
        Self::at(API)
    }

    fn at(base: &str) -> Self {
        let agent = ureq::Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(CALL_LIMIT))
            .user_agent("jet")
            .build()
            .into();
        Self {
            base: Url::parse(base).expect("the GitHub API address is a valid address"),
            agent,
        }
    }

    /// The last push, the commits since `since`, the open pull requests and the issues updated
    /// since `since`, each with its address, and when they were fetched.
    pub(crate) fn activity(
        &self,
        repo: &Repo,
        since: &str,
        token: Option<&GithubToken>,
    ) -> Result<Value, GithubError> {
        let mut call = Call {
            github: self,
            repo,
            token,
            has_waited: false,
        };
        let path = format!("repos/{}", repo.0);
        let about = call.get(&path, &[])?;
        let commits = call.get(
            &format!("{path}/commits"),
            &[("since", since), ("per_page", PAGE)],
        )?;
        let pulls = call.get(
            &format!("{path}/pulls"),
            &[("state", "open"), ("per_page", PAGE)],
        )?;
        let issues = call.get(
            &format!("{path}/issues"),
            &[
                ("state", "all"),
                ("since", since),
                ("sort", "updated"),
                ("per_page", PAGE),
            ],
        )?;
        let items = |list: &Value| list.as_array().cloned().unwrap_or_default();
        Ok(json!({
            "repo": repo.0,
            "url": about["html_url"],
            "lastPush": about["pushed_at"],
            "since": since,
            "commits": items(&commits).iter().map(commit).collect::<Vec<_>>(),
            "pullRequests": items(&pulls).iter().map(|pull| item(pull, false)).collect::<Vec<_>>(),
            "issues": items(&issues)
                .iter()
                .filter(|issue| issue.get("pull_request").is_none())
                .map(|issue| item(issue, true))
                .collect::<Vec<_>>(),
            "fetchedAt": utc(now()),
        }))
    }
}

/// One tool call's requests to GitHub. They share the one wait for the quota that a call may sit
/// out.
struct Call<'a> {
    github: &'a Github,
    repo: &'a Repo,
    token: Option<&'a GithubToken>,
    has_waited: bool,
}

impl Call<'_> {
    fn get(&mut self, path: &str, query: &[(&str, &str)]) -> Result<Value, GithubError> {
        let unreachable = |detail: String| GithubError::Unreachable { detail };
        let mut url = self
            .github
            .base
            .join(path)
            .map_err(|e| unreachable(e.to_string()))?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        for _ in 0..=REDIRECT_LIMIT {
            let mut request = self
                .github
                .agent
                .get(url.as_str())
                .header("accept", "application/vnd.github+json")
                .header("x-github-api-version", "2022-11-28");
            if let Some(token) = self.token {
                request = request.header("authorization", format!("Bearer {}", token.expose()));
            }
            let mut response = request.call().map_err(|e| unreachable(e.to_string()))?;
            let status = response.status().as_u16();
            let header = |name: &str| {
                response
                    .headers()
                    .get(name)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned)
            };
            match status {
                200 => {
                    let text = response
                        .body_mut()
                        .with_config()
                        .limit(ANSWER_LIMIT)
                        .read_to_string()
                        .map_err(|e| unreachable(format!("its answer could not be read: {e}")))?;
                    return serde_json::from_str(&text)
                        .map_err(|e| unreachable(format!("its answer is not JSON: {e}")));
                }
                // GitHub answers 409 for the commits of a repository that has none yet.
                409 => return Ok(json!([])),
                301 | 302 | 307 | 308 => {
                    let next = header("location")
                        .and_then(|location| url.join(&location).ok())
                        .filter(|next| next.origin() == self.github.base.origin())
                        .ok_or_else(|| unreachable("it redirected to another host".into()))?;
                    url = next;
                }
                403 | 429 => match quota_wait(status, &header) {
                    Some(wait) if wait <= SHORT_WAIT_SECONDS && !self.has_waited => {
                        self.has_waited = true;
                        std::thread::sleep(Duration::from_secs(wait));
                    }
                    Some(wait_seconds) => return Err(GithubError::Quota { wait_seconds }),
                    None => return Err(self.refused(status)),
                },
                401 | 404 => return Err(self.refused(status)),
                _ => return Err(unreachable(format!("it answered {status}"))),
            }
        }
        Err(unreachable("it redirected too many times".into()))
    }

    fn refused(&self, status: u16) -> GithubError {
        let repo = self.repo.0.clone();
        match self.token {
            Some(_) => GithubError::TokenRejected { repo, status },
            None => GithubError::TokenMissing { repo, status },
        }
    }
}

/// How long GitHub asks the caller to wait, when a 403 or 429 is about the quota and not about
/// access.
fn quota_wait(status: u16, header: &impl Fn(&str) -> Option<String>) -> Option<u64> {
    let number = |name: &str| header(name)?.trim().parse::<u64>().ok();
    if let Some(after) = number("retry-after") {
        return Some(after);
    }
    if number("x-ratelimit-remaining") == Some(0) {
        return Some(number("x-ratelimit-reset")?.saturating_sub(now()));
    }
    // GitHub's own advice for a secondary limit with neither header is to wait a minute.
    (status == 429).then_some(60)
}

fn commit(item: &Value) -> Value {
    let sha = item["sha"].as_str().unwrap_or_default();
    let author = item["author"]["login"]
        .as_str()
        .or(item["commit"]["author"]["name"].as_str());
    let message = item["commit"]["message"].as_str().unwrap_or_default();
    json!({
        "id": sha.get(..7).unwrap_or(sha),
        "author": author,
        "title": title(message.lines().next().unwrap_or_default()),
        "time": item["commit"]["author"]["date"],
        "url": item["html_url"],
    })
}

fn item(item: &Value, has_state: bool) -> Value {
    let mut fact = json!({
        "number": item["number"],
        "title": title(item["title"].as_str().unwrap_or_default()),
        "author": item["user"]["login"],
        "updated": item["updated_at"],
        "url": item["html_url"],
    });
    if has_state {
        fact["state"] = item["state"].clone();
    }
    fact
}

fn title(text: &str) -> String {
    text.chars().take(TITLE_LIMIT).collect()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is after 1970")
        .as_secs()
}

/// A time as `YYYY-MM-DDTHH:MM:SSZ`, with the civil date worked out from the day count.
fn utc(seconds: u64) -> String {
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    let era_days = days + 719_468;
    let era = era_days / 146_097;
    let day_of_era = era_days % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent::test_server::{Answer, Paths};

    const SINCE: &str = "2026-11-20T00:00:00Z";

    fn repo() -> Repo {
        Repo::parse("octo/jet").unwrap()
    }

    fn scripted() -> Vec<(&'static str, Answer)> {
        vec![
            (
                "/repos/octo/jet",
                Answer::json(
                    200,
                    json!({"html_url":"https://github.com/octo/jet","pushed_at":"2026-11-23T09:00:00Z","private":false}),
                ),
            ),
            (
                "/repos/octo/jet/commits",
                Answer::json(
                    200,
                    json!([
                        {"sha":"a1b2c3d4e5f6","html_url":"https://github.com/octo/jet/commit/a1b2c3d4e5f6","author":{"login":"shaun"},"commit":{"message":"Add the kite\n\nLonger body","author":{"name":"Shaun","date":"2026-11-23T09:00:00Z"}}},
                        {"sha":"0f0f0f0f0f0f","html_url":"https://github.com/octo/jet/commit/0f0f0f0f0f0f","author":null,"commit":{"message":"Fix typo","author":{"name":"Someone Else","date":"2026-11-21T10:00:00Z"}}}
                    ]),
                ),
            ),
            (
                "/repos/octo/jet/pulls",
                Answer::json(
                    200,
                    json!([{"number":7,"title":"Spinner form","user":{"login":"shaun"},"updated_at":"2026-11-22T08:00:00Z","html_url":"https://github.com/octo/jet/pull/7"}]),
                ),
            ),
            (
                "/repos/octo/jet/issues",
                Answer::json(
                    200,
                    json!([
                        {"number":8,"title":"Kite tips over","state":"open","user":{"login":"guest"},"updated_at":"2026-11-22T12:00:00Z","html_url":"https://github.com/octo/jet/issues/8"},
                        {"number":7,"title":"Spinner form","state":"open","user":{"login":"shaun"},"updated_at":"2026-11-22T08:00:00Z","html_url":"https://github.com/octo/jet/pull/7","pull_request":{}}
                    ]),
                ),
            ),
        ]
    }

    #[test]
    fn activity_gives_the_facts_of_a_repository() {
        let github = Paths::start(scripted());
        let mut facts = Github::at(&github.url)
            .activity(&repo(), SINCE, None)
            .unwrap();

        let fetched = facts["fetchedAt"].take();
        assert!(fetched.as_str().unwrap().ends_with('Z'), "{fetched}");
        assert_eq!(utc(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(
            facts,
            json!({
                "repo": "octo/jet",
                "url": "https://github.com/octo/jet",
                "lastPush": "2026-11-23T09:00:00Z",
                "since": SINCE,
                "commits": [
                    {"id":"a1b2c3d","author":"shaun","title":"Add the kite","time":"2026-11-23T09:00:00Z","url":"https://github.com/octo/jet/commit/a1b2c3d4e5f6"},
                    {"id":"0f0f0f0","author":"Someone Else","title":"Fix typo","time":"2026-11-21T10:00:00Z","url":"https://github.com/octo/jet/commit/0f0f0f0f0f0f"}
                ],
                "pullRequests": [
                    {"number":7,"title":"Spinner form","author":"shaun","updated":"2026-11-22T08:00:00Z","url":"https://github.com/octo/jet/pull/7"}
                ],
                "issues": [
                    {"number":8,"title":"Kite tips over","state":"open","author":"guest","updated":"2026-11-22T12:00:00Z","url":"https://github.com/octo/jet/issues/8"}
                ],
                "fetchedAt": null,
            })
        );
        let requests = github.requests();
        assert!(
            requests[1].starts_with(
                "GET /repos/octo/jet/commits?since=2026-11-20T00%3A00%3A00Z&per_page=30 "
            ),
            "{}",
            requests[1]
        );
        assert!(
            requests
                .iter()
                .all(|head| !head.to_ascii_lowercase().contains("authorization"))
        );
    }

    #[test]
    fn github_tool_obeys_retry_after_once() {
        let mut answers = vec![(
            "/repos/octo/jet",
            Answer::json(403, json!({"message":"secondary rate limit"}))
                .with_header("retry-after", "1"),
        )];
        answers.extend(scripted());
        answers.insert(
            2,
            (
                "/repos/octo/jet/commits",
                Answer::json(429, json!({"message":"slow down"})).with_header("retry-after", "1"),
            ),
        );
        let github = Paths::start(answers);

        let started = std::time::Instant::now();
        let error = Github::at(&github.url)
            .activity(&repo(), SINCE, None)
            .unwrap_err();

        assert!(
            started.elapsed() >= Duration::from_secs(1),
            "the wait was sat out"
        );
        assert!(
            matches!(error, GithubError::Quota { wait_seconds: 1 }),
            "{error:?}"
        );
        assert_eq!(error.kind(), "githubQuota");
        let requests = github.requests();
        let paths: Vec<&str> = requests
            .iter()
            .map(|head| head.split(['?', ' ']).nth(1).unwrap_or_default())
            .collect();
        assert_eq!(
            paths,
            [
                "/repos/octo/jet",
                "/repos/octo/jet",
                "/repos/octo/jet/commits"
            ],
            "the first wait is obeyed and the second is reported"
        );

        // A long wait is reported at once, without a second try.
        let github = Paths::start(vec![(
            "/repos/octo/jet",
            Answer::json(403, json!({"message":"secondary rate limit"}))
                .with_header("retry-after", "60"),
        )]);
        let error = Github::at(&github.url)
            .activity(&repo(), SINCE, None)
            .unwrap_err();
        assert!(
            matches!(error, GithubError::Quota { wait_seconds: 60 }),
            "{error:?}"
        );
        assert_eq!(github.requests().len(), 1);
    }

    #[test]
    fn github_unauthorized_is_a_typed_error() {
        let github = Paths::start(vec![(
            "/repos/octo/jet",
            Answer::json(401, json!({"message":"Bad credentials"})),
        )]);
        let token = GithubToken("ghp_wrong".into());
        let error = Github::at(&github.url)
            .activity(&repo(), SINCE, Some(&token))
            .unwrap_err();
        assert!(
            matches!(error, GithubError::TokenRejected { status: 401, .. }),
            "{error:?}"
        );
        assert!(error.to_string().contains("in Settings"), "{error}");
        assert!(
            github.requests()[0]
                .to_ascii_lowercase()
                .contains("authorization: bearer ghp_wrong")
        );

        // A private repository read without a token looks like no repository at all.
        let error = Github::at(&github.url)
            .activity(&Repo::parse("octo/secret").unwrap(), SINCE, None)
            .unwrap_err();
        assert!(
            matches!(error, GithubError::TokenMissing { status: 404, .. }),
            "{error:?}"
        );
        assert!(
            error.to_string().contains("paste a GitHub token"),
            "{error}"
        );
    }

    #[test]
    fn a_redirect_to_another_host_is_not_followed() {
        let elsewhere = Paths::start(vec![("/steal", Answer::json(200, json!({})))]);
        let github = Paths::start(vec![(
            "/repos/octo/jet",
            Answer::json(301, json!({}))
                .with_header("location", &format!("{}/steal", elsewhere.url)),
        )]);
        let error = Github::at(&github.url)
            .activity(&repo(), SINCE, Some(&GithubToken("ghp_secret".into())))
            .unwrap_err();
        assert!(
            matches!(error, GithubError::Unreachable { .. }),
            "{error:?}"
        );
        assert_eq!(github.requests().len(), 1);
        assert!(
            elsewhere.requests().is_empty(),
            "the other host was never asked"
        );
    }

    /// Reads one public repository from the real GitHub with no token, and prints the quota
    /// headers that the anonymous caller gets.
    #[test]
    #[ignore = "calls the real GitHub API"]
    fn live_public_repository_without_a_token() {
        let github = Github::at(API);
        let since = utc(now() - 7 * 86_400);
        let facts = github
            .activity(&Repo::parse("rust-lang/rust").unwrap(), &since, None)
            .expect("the public repository could be read with no token");
        eprintln!(
            "lastPush {}, {} commits, {} open pull requests, {} issues since {since}",
            facts["lastPush"],
            facts["commits"].as_array().unwrap().len(),
            facts["pullRequests"].as_array().unwrap().len(),
            facts["issues"].as_array().unwrap().len()
        );
        let mut response = github
            .agent
            .get(format!("{API}/rate_limit"))
            .header("accept", "application/vnd.github+json")
            .call()
            .unwrap();
        for (name, value) in response.headers() {
            eprintln!("{name}: {}", value.to_str().unwrap_or("?"));
        }
        let body: Value =
            serde_json::from_str(&response.body_mut().read_to_string().unwrap()).unwrap();
        eprintln!("rate_limit core: {}", body["resources"]["core"]);
        assert_eq!(
            body["resources"]["core"]["limit"], 60,
            "the anonymous limit"
        );
    }
}
