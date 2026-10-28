//! The `{"$file": "<id>"}` hand-off: a model names a file of the conversation, and the tool is
//! given the address that serves it.
use serde_json::Value;
use std::collections::HashMap;
use uuid::Uuid;

const KEY: &str = "$file";

/// The file id when `value` is exactly `{"$file": "<id>"}`. An object with any other key is
/// ordinary data.
fn reference(value: &Value) -> Option<&str> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    object.get(KEY)?.as_str()
}

/// Every file id named anywhere in `value`, in the order met.
pub(super) fn file_ids(value: &Value) -> Vec<&str> {
    if let Some(id) = reference(value) {
        return vec![id];
    }
    match value {
        Value::Array(items) => items.iter().flat_map(file_ids).collect(),
        Value::Object(fields) => fields.values().flat_map(file_ids).collect(),
        _ => Vec::new(),
    }
}

/// Puts `{origin}/api/files/{file}` in place of each reference that `files` knows. The address
/// uses the file's id in its usual form, whatever form the model wrote it in.
pub(super) fn swap_for_addresses(value: &mut Value, origin: &str, files: &HashMap<String, Uuid>) {
    if let Some(id) = reference(value) {
        if let Some(file) = files.get(id) {
            *value = Value::String(format!("{origin}/api/files/{file}"));
        }
        return;
    }
    match value {
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| swap_for_addresses(item, origin, files)),
        Value::Object(fields) => fields
            .values_mut()
            .for_each(|field| swap_for_addresses(field, origin, files)),
        _ => {}
    }
}
