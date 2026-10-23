//! Run the standalone example over its public HTTP endpoints.
use agent::apps::{AddApp, AppOverrides, DiscoveryStatus, Registry, RegistryCommand};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
};

struct Fixture(Child);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn generic_fixture_exposes_ui_descriptor_and_independent_mcp() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/app/server.mjs");
    let mut fixture = Fixture(
        Command::new("node")
            .arg(path)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut output = BufReader::new(fixture.0.stdout.take().unwrap());
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    let endpoints: Value = serde_json::from_str(&line).unwrap();
    let address = endpoints["ui"].as_str().unwrap();
    let mcp = endpoints["mcp"].as_str().unwrap();
    assert_ne!(
        url::Url::parse(address).unwrap().port(),
        url::Url::parse(mcp).unwrap().port()
    );
    let dir = tempfile::tempdir().unwrap();
    let mut registry = Registry::open(dir.path()).unwrap();
    let added = registry
        .execute(RegistryCommand::Add(AddApp {
            address: address.into(),
            overrides: AppOverrides::default(),
        }))
        .unwrap();
    assert_eq!(added.discovery, Some(DiscoveryStatus::Ready));
    assert_eq!(added.app.unwrap().mcp_url.unwrap().as_str(), mcp);
    let html = ureq::get(address)
        .call()
        .unwrap()
        .body_mut()
        .read_to_string()
        .unwrap();
    assert!(html.contains("unsaved-note"));
    let call = |method, params| -> Value {
        let body = json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
        let result = ureq::post(mcp)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .send(body.to_string())
            .unwrap()
            .body_mut()
            .read_to_string()
            .unwrap();
        serde_json::from_str::<Value>(&result).unwrap()["result"].clone()
    };
    let initialization = call(
        "initialize",
        json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"registry-test","version":"1"}}),
    );
    assert_eq!(initialization["protocolVersion"], "2025-11-25");
    let tools = call("tools/list", json!({}));
    assert!(
        tools["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "read_note")
    );
    let result = call(
        "tools/call",
        json!({"name":"read_note","arguments":{"name":"welcome"}}),
    );
    assert_eq!(
        result["structuredContent"]["text"],
        "Hello from the fixture"
    );
}
