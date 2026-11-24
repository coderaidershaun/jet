//! Connect using the exact HTTP configuration the adapter passed to the process.
use super::{Provider, events};
use agent::{TOOL_USE_META, TURN_HEADER};
use rmcp::{
    Peer, RoleClient, ServiceExt,
    model::{CallToolRequestParams, RequestMetaObject},
    transport::{
        StreamableHttpClientTransport, streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::{Value, json};
pub(super) async fn run(provider: &dyn Provider, args: &[String], script: Vec<Value>) {
    let (url, token) = provider.connection(args);
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
    provider.start();
    let caller = Caller {
        peer: client.peer().clone(),
        names_tool_use: provider.names_tool_use(),
    };
    let mut results = Vec::new();
    for (index, operation) in script.iter().enumerate() {
        if operation["pause"] == true {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            continue;
        }
        // A test makes the file when the script may go on, so no step depends on a sleep.
        if let Some(file) = operation["wait"].as_str() {
            while !std::path::Path::new(file).exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            continue;
        }
        // Writes the line of a call that the test sends to the facade itself.
        if let Some(id) = operation["announce"].as_str() {
            provider.call(id, name_of(operation), &arguments_of(operation));
            continue;
        }
        if let Some(address) = operation["fetch"].as_str() {
            results.push(web_fetch(args, &format!("web-{index}"), address).await);
        } else if let Some(query) = operation["search"].as_str() {
            let id = format!("web-{index}");
            events::web_call(&id, "WebSearch", json!({"query": query}));
            events::web_result(&id, &format!("Search results for {query}"), false);
            results.push(json!({"search": query}));
        } else if let Some(together) = operation["together"].as_array() {
            results.extend(caller.call_together(provider, index, together).await);
        } else {
            let id = format!("facade-{index}");
            results.extend(caller.call_together_as(provider, &[(id, operation)]).await);
        }
        std::fs::write("facade-results.json", json!(results).to_string()).unwrap();
    }
    provider.finish();
    client.cancel().await.unwrap();
}
/// Reads `https://<address>` the way Claude Code does: the hook in `--settings` is asked first,
/// and a refusal, or a hook that cannot be reached, stops the read; then the host needs its allow
/// rule. The address is written without `https://`, so that the script in a message names no
/// link the host list would pick up.
async fn web_fetch(args: &[String], id: &str, address: &str) -> Value {
    let url = format!("https://{address}");
    let input = json!({"url": url, "prompt": "What does the page say?"});
    events::web_call(id, "WebFetch", input.clone());
    let value = |key: &str| {
        args.iter()
            .position(|arg| arg == key)
            .map(|at| args[at + 1].clone())
    };
    let settings: Value =
        serde_json::from_str(&value("--settings").unwrap_or_default()).unwrap_or_default();
    let hook = &settings["hooks"]["PreToolUse"][0]["hooks"][0];
    let mut request = reqwest::Client::new()
        .post(hook["url"].as_str().unwrap_or("http://127.0.0.1:1/"))
        .json(&json!({"hook_event_name": "PreToolUse", "tool_name": "WebFetch", "tool_input": input, "tool_use_id": id}));
    for (name, header) in hook["headers"].as_object().into_iter().flatten() {
        request = request.header(name, header.as_str().unwrap_or_default());
    }
    let answer: Result<Value, String> = match request.send().await {
        Ok(response) if response.status().is_success() => {
            response.json().await.map_err(|e| e.to_string())
        }
        Ok(response) => Err(format!("status {}", response.status())),
        Err(error) => Err(error.to_string()),
    };
    let host = address.split('/').next().unwrap_or_default();
    let rule = format!("WebFetch(domain:{host})");
    let ruled =
        value("--allowedTools").is_some_and(|allowed| allowed.split(',').any(|tool| tool == rule));
    let refusal = match answer {
        Err(error) => Some(format!(
            "PreToolUse:WebFetch hook error: failed; blocking because onFailure is \"block\"\n{error}"
        )),
        Ok(answer) if answer["hookSpecificOutput"]["permissionDecision"] == "deny" => {
            Some(format!(
                "PreToolUse:WebFetch hook error: {}",
                answer["hookSpecificOutput"]["permissionDecisionReason"]
                    .as_str()
                    .unwrap_or_default()
            ))
        }
        Ok(_) if !ruled => Some("Permission for this tool use was denied.".to_owned()),
        Ok(_) => None,
    };
    match &refusal {
        Some(refusal) => events::web_result(id, refusal, true),
        None => events::web_result(id, &format!("The text of {url}."), false),
    }
    json!({"fetch": url, "refused": refusal})
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
    names_tool_use: bool,
}
impl Caller {
    async fn call_together(
        &self,
        provider: &dyn Provider,
        index: usize,
        together: &[Value],
    ) -> Vec<Value> {
        let calls: Vec<(String, &Value)> = together
            .iter()
            .enumerate()
            .map(|(part, operation)| (format!("facade-{index}-{part}"), operation))
            .collect();
        self.call_together_as(provider, &calls).await
    }
    /// Shows every call as started, sends them all at once, and gives their results in script
    /// order. A call the provider refuses is not sent, and its result is the refusal.
    async fn call_together_as(
        &self,
        provider: &dyn Provider,
        calls: &[(String, &Value)],
    ) -> Vec<Value> {
        let mut pending = Vec::new();
        for (id, operation) in calls {
            let refusal = provider.call(id, name_of(operation), &arguments_of(operation));
            let sent = refusal
                .is_none()
                .then(|| tokio::spawn(self.clone().call(id.clone(), (*operation).clone())));
            pending.push((id, refusal, sent));
        }
        let mut results = Vec::new();
        for (id, refusal, sent) in pending {
            let Some(call) = sent else {
                results.push(json!({"refused": refusal}));
                continue;
            };
            let result = call.await.unwrap();
            provider.result(id, result.clone());
            results.push(result);
        }
        results
    }
    /// Sends one call. Claude Code names the tool use a call belongs to in the request metadata,
    /// and the other providers name nothing.
    async fn call(self, id: String, operation: Value) -> Value {
        let mut params = CallToolRequestParams::new(name_of(&operation).to_owned())
            .with_arguments(arguments_of(&operation).as_object().unwrap().clone());
        if self.names_tool_use {
            let mut meta = RequestMetaObject::new();
            meta.insert(TOOL_USE_META.into(), json!(id));
            params.meta = Some(meta);
        }
        serde_json::to_value(self.peer.call_tool(params).await.unwrap()).unwrap()
    }
}
