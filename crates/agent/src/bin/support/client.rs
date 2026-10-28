//! Connect using the exact HTTP configuration the adapter passed to the process.
use super::events;
use agent::{TOOL_USE_META, TURN_HEADER};
use rmcp::{
    Peer, RoleClient, ServiceExt,
    model::{CallToolRequestParams, RequestMetaObject},
    transport::{
        StreamableHttpClientTransport, streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::{Value, json};
pub(super) async fn run(args: &[String], script: Vec<Value>, codex: bool) {
    let (url, token) = if codex {
        let value = |key: &str| -> String {
            serde_json::from_str(args.iter().find_map(|arg| arg.strip_prefix(key)).unwrap())
                .unwrap()
        };
        assert!(args.contains(&"--ignore-user-config".into()));
        assert!(args.contains(&"--ignore-rules".into()));
        assert!(args.contains(&"features.shell_tool=false".into()));
        assert!(args.contains(&format!(
            "mcp_servers.jet.enabled_tools={}",
            json!(agent::FACADE_TOOLS)
        )));
        (
            value("mcp_servers.jet.url="),
            value(&format!("mcp_servers.jet.http_headers.{TURN_HEADER}=")),
        )
    } else {
        let value =
            |key: &str| -> &str { &args[args.iter().position(|arg| arg == key).unwrap() + 1] };
        assert_eq!(value("--tools"), "");
        assert!(args.contains(&"--strict-mcp-config".into()));
        assert_eq!(
            value("--allowedTools"),
            agent::FACADE_TOOLS
                .map(|name| format!("mcp__jet__{name}"))
                .join(",")
        );
        let config: Value = serde_json::from_str(value("--mcp-config")).unwrap();
        (
            config["mcpServers"]["jet"]["url"].as_str().unwrap().into(),
            config["mcpServers"]["jet"]["headers"][TURN_HEADER]
                .as_str()
                .unwrap()
                .into(),
        )
    };
    std::fs::write(
        "facade-connection.json",
        json!({"url":url,"token":token}).to_string(),
    )
    .unwrap();
    let mut config = StreamableHttpClientTransportConfig::with_uri(url);
    config
        .custom_headers
        .insert(TURN_HEADER.parse().unwrap(), token.parse().unwrap());
    config.reinit_on_expired_session = false;
    let transport = StreamableHttpClientTransport::with_client(reqwest::Client::new(), config);
    let client = ().serve(transport).await.unwrap();
    let tools = client.list_all_tools().await.unwrap();
    assert_eq!(
        tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect::<Vec<_>>(),
        agent::FACADE_TOOLS
    );
    events::start(codex);
    let caller = Caller {
        peer: client.peer().clone(),
        codex,
    };
    let mut results = Vec::new();
    for (index, operation) in script.iter().enumerate() {
        if operation["pause"] == true {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            continue;
        }
        if let Some(together) = operation["together"].as_array() {
            results.extend(caller.call_together(index, together).await);
        } else {
            let id = format!("facade-{index}");
            events::call(codex, &id, name_of(operation), &arguments_of(operation));
            let result = caller.clone().call(id.clone(), operation.clone()).await;
            events::result(codex, &id, result.clone());
            results.push(result);
        }
        std::fs::write("facade-results.json", json!(results).to_string()).unwrap();
    }
    events::finish(codex);
    client.cancel().await.unwrap();
}
fn name_of(operation: &Value) -> &str {
    operation["tool"].as_str().unwrap()
}
fn arguments_of(operation: &Value) -> Value {
    operation.get("arguments").cloned().unwrap_or(json!({}))
}
/// Sends the script's calls the way the provider would.
#[derive(Clone)]
struct Caller {
    peer: Peer<RoleClient>,
    codex: bool,
}
impl Caller {
    /// Shows every call as started, sends them all at once, and gives their results in script
    /// order.
    async fn call_together(&self, index: usize, together: &[Value]) -> Vec<Value> {
        let mut pending = Vec::new();
        for (part, operation) in together.iter().enumerate() {
            let id = format!("facade-{index}-{part}");
            events::call(
                self.codex,
                &id,
                name_of(operation),
                &arguments_of(operation),
            );
            pending.push((
                id.clone(),
                tokio::spawn(self.clone().call(id, operation.clone())),
            ));
        }
        let mut results = Vec::new();
        for (id, call) in pending {
            let result = call.await.unwrap();
            events::result(self.codex, &id, result.clone());
            results.push(result);
        }
        results
    }
    /// Sends one call. Claude Code names the tool use a call belongs to in the request metadata,
    /// and Codex names nothing.
    async fn call(self, id: String, operation: Value) -> Value {
        let mut params = CallToolRequestParams::new(name_of(&operation).to_owned())
            .with_arguments(arguments_of(&operation).as_object().unwrap().clone());
        if !self.codex {
            let mut meta = RequestMetaObject::new();
            meta.insert(TOOL_USE_META.into(), json!(id));
            params.meta = Some(meta);
        }
        serde_json::to_value(self.peer.call_tool(params).await.unwrap()).unwrap()
    }
}
