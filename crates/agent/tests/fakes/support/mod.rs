//! Lets a fake provider call Jet's tool facade over real HTTP when its input holds a `facade:` script.
mod client;
mod events;
use serde_json::Value;

/// How one provider is told where the facade is, and how it writes a tool call in its stream.
pub trait Provider {
    /// The address of the facade and the token of the turn.
    fn connection(&self, args: &[String]) -> (String, String);
    fn start(&self);
    /// Writes the call as started. Gives the reason when the provider itself refuses the call,
    /// which is then never sent.
    fn call(&self, id: &str, tool: &str, arguments: &Value) -> Option<String>;
    fn result(&self, id: &str, result: Value);
    fn finish(&self);
    /// Whether each request names the tool use it belongs to.
    fn names_tool_use(&self) -> bool;
}

pub fn run_as(provider: &dyn Provider, args: &[String], input: &str) -> bool {
    // Tests read this to see exactly what the model was sent, even when no script follows.
    std::fs::write("facade-prompt.txt", input).unwrap();
    let Some(script) = input.lines().find_map(|line| line.strip_prefix("facade:")) else {
        return false;
    };
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let script: Vec<Value> = serde_json::from_str(script).unwrap();
    runtime.block_on(client::run(provider, args, script));
    true
}
