//! What one request used and which model answered it. The chat page reads these field names,
//! so change them together with the page.

use serde::{Deserialize, Serialize};

/// Token counts of one request, as Claude Code reports them. The cache counts show whether
/// the prompt cache was warm, and `model` names the model that answered.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_creation_1h_tokens: u64,
    pub output_tokens: u64,
    pub thinking_tokens: u64,
    pub model: String,
}
