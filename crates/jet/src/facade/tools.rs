//! Define the fixed facade contract without copying registered tool schemas.
use rmcp::model::Tool;
use serde_json::{Value, json};
pub(super) fn definitions() -> Vec<Tool> {
    let target = json!({"appId":{"type":"string","format":"uuid"},"tool":{"type":"string"}});
    [
        ("apps_list", "List all registered apps and stable IDs.", object(json!({}),json!([]))),
        ("apps_update", "Apply an explicit typed registry action and return its persisted outcome.", object(json!({"command":command_schema()}),json!(["command"]))),
        ("apps_open", "Open an app in the browser that initiated this turn.", object(json!({"appId":{"type":"string","format":"uuid"}}),json!(["appId"]))),
        ("tools_search", "Search concise tool summaries across all enabled apps. Use tools_describe for schemas.", object(json!({"query":{"type":"string"}}),json!([]))),
        ("tools_describe", "Read a real tool schema and its server instructions.", object(target,json!(["appId","tool"]))),
        ("tools_call", "Validate and call a real tool once. Discover its schema first.", object(json!({"appId":{"type":"string","format":"uuid"},"tool":{"type":"string"},"arguments":{"type":"object"}}),json!(["appId","tool","arguments"]))),
    ].into_iter().map(|(name, description, schema)| {
        let mut tool = Tool::new(name, description, schema.as_object().cloned().unwrap_or_default());
        tool.annotations = serde_json::from_value(json!({"readOnlyHint":matches!(name,"apps_list"|"tools_search"|"tools_describe")})).ok();
        tool
    }).collect()
}
fn object(properties: Value, required: Value) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn command_schema() -> Value {
    let overrides = object(
        json!({
            "label":{"type":["string","null"]},
            "ui":{"type":["string","null"]},
            "embedding":{"enum":["relative-paths","direct","external",null]},
            "mcp":{"oneOf":[object(json!({"mode":{"enum":["discover","disabled"]}}),json!(["mode"])),object(json!({"mode":{"const":"url"},"url":{"type":"string"}}),json!(["mode","url"]))]}
        }),
        json!([]),
    );
    let mut variants = vec![
        object(
            json!({"action":{"const":"add"},"address":{"type":"string"},"overrides":overrides}),
            json!(["action", "address"]),
        ),
        object(
            json!({"action":{"const":"edit"},"id":{"type":"string","format":"uuid"},"address":{"type":["string","null"]},"overrides":overrides}),
            json!(["action", "id"]),
        ),
    ];
    for action in ["enable", "disable", "remove", "refresh"] {
        variants.push(object(
            json!({"action":{"const":action},"id":{"type":"string","format":"uuid"}}),
            json!(["action", "id"]),
        ));
    }
    json!({"oneOf":variants})
}
pub(super) fn validate(name: &str, arguments: &Value) -> Result<(), rmcp::ErrorData> {
    let tool = definitions()
        .into_iter()
        .find(|tool| tool.name == name)
        .ok_or_else(|| rmcp::ErrorData::invalid_params("unknown facade tool", None))?;
    let schema = Value::Object((*tool.input_schema).clone());
    let validator = jsonschema::validator_for(&schema)
        .map_err(|error| rmcp::ErrorData::internal_error(error.to_string(), None))?;
    validator
        .validate(arguments)
        .map_err(|error| rmcp::ErrorData::invalid_params(error.to_string(), None))
}
