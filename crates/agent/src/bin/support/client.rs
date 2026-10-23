//! Connect using the exact HTTP configuration the adapter passed to the process.
use super::events;
use rmcp::{
    ServiceExt,
    model::CallToolRequestParams,
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
            value("mcp_servers.jet.http_headers.\"x-jet-turn\"="),
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
            config["mcpServers"]["jet"]["headers"]["x-jet-turn"]
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
        .insert("x-jet-turn".parse().unwrap(), token.parse().unwrap());
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
    let mut results = Vec::new();
    for (index, operation) in script.iter().enumerate() {
        if operation["pause"] == true {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            continue;
        }
        let name = operation["tool"].as_str().unwrap();
        let arguments = operation.get("arguments").cloned().unwrap_or(json!({}));
        let id = format!("facade-{index}");
        events::call(codex, &id, name, &arguments);
        let response = client
            .call_tool(
                CallToolRequestParams::new(name.to_owned())
                    .with_arguments(arguments.as_object().unwrap().clone()),
            )
            .await
            .unwrap();
        let result = serde_json::to_value(response).unwrap();
        events::result(codex, &id, result.clone());
        results.push(result);
        std::fs::write("facade-results.json", json!(results).to_string()).unwrap();
    }
    events::finish(codex);
    client.cancel().await.unwrap();
}
