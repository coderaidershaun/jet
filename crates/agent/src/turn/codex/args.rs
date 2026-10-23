//! Codex takes TOML overrides, so validate and translate the shared request before launch.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;
use serde_json::{Value, json};

use super::super::{Request, SessionMode, TransportError};

fn push_config_value(args: &mut Vec<String>, key: &str, value: Value) {
    args.extend(["-c".into(), format!("{key}={value}")]);
}

pub(super) fn args(
    request: &Request,
    schema: Option<&Path>,
) -> Result<Vec<String>, TransportError> {
    let mut args = vec!["exec".into()];
    // exec's global settings must precede the resume subcommand.
    push_config_value(&mut args, "sandbox_mode", json!("read-only"));
    push_config_value(&mut args, "approval_policy", json!("never"));
    push_config_value(&mut args, "forced_login_method", json!("chatgpt"));
    push_config_value(
        &mut args,
        "developer_instructions",
        json!(request.system_prompt),
    );
    push_config_value(
        &mut args,
        "model_reasoning_effort",
        json!(request.effort.alias()),
    );
    push_config_value(&mut args, "project_doc_max_bytes", json!(0));
    push_config_value(&mut args, "web_search", json!("disabled"));
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
        push_config_value(&mut args, &format!("features.{feature}"), json!(false));
    }
    if let Some(raw) = &request.mcp_config {
        let config: McpConfig =
            serde_json::from_str(raw).map_err(|source| TransportError::McpConfig { source })?;
        for (name, server) in config.servers {
            if name != "jet" {
                return Err(TransportError::McpServerName { name });
            }
            push_config_value(&mut args, "mcp_servers.jet.url", json!(server.url));
            for (header, value) in server.headers {
                push_config_value(
                    &mut args,
                    &format!("mcp_servers.{name}.http_headers.{}", json!(header)),
                    json!(value),
                );
            }
            push_config_value(
                &mut args,
                &format!("mcp_servers.{name}.enabled_tools"),
                json!(crate::FACADE_TOOLS),
            );
            // Jet users authorize their configured servers; headless turns cannot prompt.
            push_config_value(
                &mut args,
                &format!("mcp_servers.{name}.default_tools_approval_mode"),
                json!("approve"),
            );
            push_config_value(
                &mut args,
                &format!("mcp_servers.{name}.tool_timeout_sec"),
                json!(300),
            );
        }
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
    Ok(args)
}

#[derive(Deserialize)]
struct McpConfig {
    #[serde(rename = "mcpServers")]
    servers: BTreeMap<String, McpServer>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct McpServer {
    #[serde(rename = "type")]
    _kind: HttpTransport,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum HttpTransport {
    Http,
}
