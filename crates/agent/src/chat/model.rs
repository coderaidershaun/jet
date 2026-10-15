//! Provider and thinking choices share saved names across chat requests and settings.

use serde::{Deserialize, Serialize};

/// Which provider model answers the chat.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Model {
    #[default]
    #[serde(rename = "gpt-6.1-sol")]
    Gpt61Sol,
    #[serde(rename = "gpt-6-astra")]
    Gpt6Astra,
    #[serde(rename = "gpt-6-sol")]
    Gpt6Sol,
    #[serde(rename = "gpt-6-luna")]
    Gpt6Luna,
    #[serde(rename = "gpt-5.6-sol")]
    Gpt56Sol,
    #[serde(rename = "gpt-5.6-terra")]
    Gpt56Terra,
    #[serde(rename = "gpt-5.6-luna")]
    Gpt56Luna,
    #[serde(rename = "gpt-reserve")]
    GptReserve,
    Fable,
    Opus,
    Sonnet,
    Haiku,
}

impl Model {
    pub fn is_codex(self) -> bool {
        matches!(
            self,
            Self::Gpt61Sol
                | Self::Gpt6Astra
                | Self::Gpt6Sol
                | Self::Gpt6Luna
                | Self::Gpt56Sol
                | Self::Gpt56Terra
                | Self::Gpt56Luna
                | Self::GptReserve
        )
    }

    pub fn supports_ultra(self) -> bool {
        self.is_codex() && !matches!(self, Self::Gpt6Luna | Self::Gpt56Luna | Self::GptReserve)
    }

    /// The name the provider command line accepts.
    pub fn alias(self) -> &'static str {
        match self {
            Model::Gpt61Sol => "gpt-6.1-sol",
            Model::Gpt6Astra => "gpt-6-astra",
            Model::Gpt6Sol => "gpt-6-sol",
            Model::Gpt6Luna => "gpt-6-luna",
            Model::Gpt56Sol => "gpt-5.6-sol",
            Model::Gpt56Terra => "gpt-5.6-terra",
            Model::Gpt56Luna => "gpt-5.6-luna",
            Model::GptReserve => "gpt-reserve",
            Model::Fable => "fable",
            Model::Opus => "opus",
            Model::Sonnet => "sonnet",
            Model::Haiku => "haiku",
        }
    }
}

/// How hard the model thinks before it answers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    #[default]
    Medium,
    High,
    XHigh,
    Max,
    Ultra,
}

impl Effort {
    /// The name the provider command line accepts.
    pub fn alias(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::XHigh => "xhigh",
            Effort::Max => "max",
            Effort::Ultra => "ultra",
        }
    }
}
