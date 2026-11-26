//! Evidence from outside Jet, so Jet can look before it asks the user how something is going:
//! today, what happened in a GitHub repository, read with the signed-in user's own token when the
//! repository is private.

mod github;
mod tokens;

pub(crate) use github::GithubError;
pub(crate) use tokens::{GithubTokens, router};

use crate::store::UserId;
use github::{Github, Repo};
use serde_json::Value;

#[derive(Clone)]
pub(crate) struct Evidence {
    github: Github,
    tokens: GithubTokens,
}

impl Evidence {
    pub(crate) fn new(tokens: GithubTokens) -> Self {
        Self {
            github: Github::new(),
            tokens,
        }
    }

    /// The GitHub login of the user's saved token; `None` when the user saved none.
    pub(crate) fn github_login(&self, user: UserId) -> Result<Option<String>, GithubError> {
        let Some(token) = self.tokens.token(user)? else {
            return Ok(None);
        };
        self.github.login(&token).map(Some)
    }

    /// The facts of `github_activity` for a call in `user`'s turn: GitHub is asked with that
    /// user's token, or with none when the user saved none.
    pub(crate) fn github_activity(
        &self,
        user: UserId,
        repo: &str,
        since: &str,
    ) -> Result<Value, GithubError> {
        let repo = Repo::parse(repo)?;
        let token = self.tokens.token(user)?;
        self.github.activity(&repo, since, token.as_ref())
    }
}
