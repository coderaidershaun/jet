//! Read the group and cost marks an app may put in a tool's `_meta`, and match a search against a tool.
use agent::mcp::ToolDefinition;
use serde_json::Value;

const GROUP_MARK: &str = "quanty/group";
const COST_MARK: &str = "quanty/cost";

/// The group an app filed the tool under, when the mark is a string.
pub(super) fn group(tool: &ToolDefinition) -> Option<&str> {
    tool.meta.get(GROUP_MARK)?.as_str()
}

/// `free`, `paid`, or `paid (who)`, from a mark of the form `{"paid": bool, "who": string}`.
/// An app is outside code, so a mark of any other form says nothing.
pub(super) fn cost(tool: &ToolDefinition) -> Option<String> {
    let mark = tool.meta.get(COST_MARK)?;
    match (
        mark.get("paid")?.as_bool()?,
        mark.get("who").and_then(Value::as_str),
    ) {
        (false, _) => Some("free".to_owned()),
        (true, Some(who)) => Some(format!("paid ({who})")),
        (true, None) => Some("paid".to_owned()),
    }
}

/// The words of a search. A tool matches when each word is in its name, description or group.
pub(super) struct Query(Vec<String>);

impl Query {
    pub fn new(text: &str) -> Self {
        Self(
            text.to_lowercase()
                .split_whitespace()
                .map(str::to_owned)
                .collect(),
        )
    }

    pub fn matches(&self, tool: &ToolDefinition) -> bool {
        let haystack = format!(
            "{} {} {}",
            tool.name,
            tool.description.as_deref().unwrap_or_default(),
            group(tool).unwrap_or_default()
        )
        .to_lowercase();
        self.0.iter().all(|word| haystack.contains(word))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn marked(meta: Value) -> ToolDefinition {
        serde_json::from_value(json!({"name":"t","inputSchema":{},"_meta":meta})).unwrap()
    }

    #[test]
    fn marks_of_the_wrong_form_say_nothing() {
        for meta in [
            json!({"quanty/group":7,"quanty/cost":"free"}),
            json!({"quanty/cost":{"paid":"yes"}}),
            json!({"quanty/cost":{"who":"ask"}}),
            json!({"quanty/cost":[true]}),
        ] {
            let tool = marked(meta.clone());
            assert_eq!((group(&tool), cost(&tool)), (None, None), "{meta}");
        }
        assert_eq!(
            cost(&marked(json!({"quanty/cost":{"paid":true,"who":3}}))).as_deref(),
            Some("paid")
        );
    }
}
