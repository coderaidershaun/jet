//! Codex takes TOML overrides, so translate the shared request into them before launch.

use std::path::Path;

use serde_json::{Value, json};

use super::super::{Request, SessionMode};
use crate::chat::{FACADE_TOOLS, TURN_HEADER};

fn push_config_value(args: &mut Vec<String>, key: &str, value: impl Into<Value>) {
    args.extend(["-c".into(), format!("{key}={}", value.into())]);
}

pub(super) fn args(request: &Request, schema: Option<&Path>) -> Vec<String> {
    let mut args = vec!["exec".into()];
    // exec's global settings must precede the resume subcommand.
    push_config_value(&mut args, "sandbox_mode", "read-only");
    push_config_value(&mut args, "approval_policy", "never");
    push_config_value(&mut args, "forced_login_method", "chatgpt");
    push_config_value(
        &mut args,
        "developer_instructions",
        request.system_prompt.as_str(),
    );
    push_config_value(&mut args, "model_reasoning_effort", request.effort.alias());
    push_config_value(&mut args, "project_doc_max_bytes", 0);
    push_config_value(&mut args, "web_search", "disabled");
    for feature in [
        "shell_tool",
        "plugins",
        "apps",
        "hooks",
        "memories",
        "multi_agent",
        "browser_use",
        "computer_use",
        "image_generation",
        "view_image",
        "skill_search",
    ] {
        push_config_value(&mut args, &format!("features.{feature}"), false);
    }
    if let Some(mcp) = &request.mcp {
        push_config_value(&mut args, "mcp_servers.jet.url", mcp.url.as_str());
        let header = format!("mcp_servers.jet.http_headers.{TURN_HEADER}");
        push_config_value(&mut args, &header, mcp.token.as_str());
        push_config_value(
            &mut args,
            "mcp_servers.jet.enabled_tools",
            json!(FACADE_TOOLS),
        );
        // Jet users authorize their configured servers; headless turns cannot prompt.
        push_config_value(
            &mut args,
            "mcp_servers.jet.default_tools_approval_mode",
            "approve",
        );
        push_config_value(&mut args, "mcp_servers.jet.tool_timeout_sec", 300);
    }

    if matches!(request.session, SessionMode::Resume(_)) {
        args.push("resume".into());
    }
    args.extend(
        [
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--json",
            "--model",
            request.model.alias(),
        ]
        .map(str::to_owned),
    );
    if request.session == SessionMode::Ephemeral {
        args.push("--ephemeral".into());
    }
    if let Some(path) = schema {
        args.extend(["--output-schema".into(), path.display().to_string()]);
    }
    if let SessionMode::Resume(id) = &request.session {
        args.push(id.0.clone());
    }
    args.push("-".into());
    args
}
