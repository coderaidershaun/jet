//! The last measurement of how much of a model's context window is used.

use serde::{Deserialize, Serialize};

/// Last measured context for one selected model. Missing counts are unknown.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ContextStatus {
    pub model: Option<super::Model>,
    pub used_tokens: Option<u64>,
    pub limit_tokens: Option<u64>,
    pub estimated: bool,
}
