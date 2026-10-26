//! What the Claude Code stand-in tests share.

use std::path::PathBuf;

use agent::{ClaudeCli, Effort, Model, Request, SessionMode};

/// The stand-in program, set to run in its own empty folder.
pub fn fake_claude(name: &str) -> (ClaudeCli, PathBuf) {
    let cwd = std::env::temp_dir().join(format!("agent-contract-{}-{name}", std::process::id()));
    std::fs::remove_dir_all(&cwd).ok();
    let program = PathBuf::from(env!("CARGO_BIN_EXE_fake-claude"));
    (ClaudeCli::at(program, cwd.clone()), cwd)
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
