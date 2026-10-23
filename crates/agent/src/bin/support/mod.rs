//! Drive real HTTP facade requests from free provider process fixtures.
mod client;
mod events;
use serde_json::Value;
pub fn run(args: &[String], input: &str, codex: bool) -> bool {
    let Some(script) = input.lines().find_map(|line| line.strip_prefix("facade:")) else {
        return false;
    };
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let script: Vec<Value> = serde_json::from_str(script).unwrap();
    runtime.block_on(client::run(args, script, codex));
    true
}
