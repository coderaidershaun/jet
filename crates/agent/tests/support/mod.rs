//! What the Claude Code stand-in tests share.

use std::path::PathBuf;

use agent::{ClaudeCli, Effort, Model, Request, SessionMode};
use tempfile::TempDir;

/// The stand-in program, set to run in its own empty folder, which goes when the test ends.
pub fn fake_claude() -> (ClaudeCli, TempDir) {
    let cwd = tempfile::tempdir().unwrap();
    let program = PathBuf::from(env!("CARGO_BIN_EXE_fake-claude"));
    (ClaudeCli::at(program, cwd.path().to_owned()), cwd)
}

pub fn chat_request(prompt: &str, session: SessionMode) -> Request {
    Request {
        prompt: prompt.to_owned(),
        system_prompt: "You are Jet.".to_owned(),
        model: Model::Sonnet,
        effort: Effort::Medium,
        budget_usd: 1.0,
        session,
        schema: None,
        mcp: None,
    }
}
