//! Keep saved app configuration and registry command messages independent of transports.
use super::{AppAddress, DiscoveryStatus};
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AppId(Uuid);
impl AppId {
    pub(super) fn generate() -> Self {
        Self(Uuid::new_v4())
    }
}
impl std::fmt::Display for AppId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
impl std::str::FromStr for AppId {
    type Err = uuid::Error;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        value.parse().map(Self)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Embedding {
    RelativePaths,
    Direct,
    #[default]
    External,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", content = "url", rename_all = "camelCase")]
pub enum McpOverride {
    #[default]
    Discover,
    Disabled,
    Url(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct AppOverrides {
    pub label: Option<String>,
    pub ui: Option<String>,
    pub mcp: McpOverride,
    pub embedding: Option<Embedding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct App {
    pub id: AppId,
    pub label: String,
    pub base_url: AppAddress,
    pub ui_url: Url,
    pub mcp_url: Option<Url>,
    pub embedding: Embedding,
    pub enabled: bool,
    pub overrides: AppOverrides,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddApp {
    pub address: String,
    #[serde(default)]
    pub overrides: AppOverrides,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum RegistryCommand {
    Add(AddApp),
    List,
    Edit {
        id: AppId,
        address: Option<String>,
        overrides: Option<AppOverrides>,
    },
    Enable {
        id: AppId,
    },
    Disable {
        id: AppId,
    },
    Remove {
        id: AppId,
    },
    Refresh {
        id: AppId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryResult {
    pub app: Option<App>,
    pub apps: Vec<App>,
    pub discovery: Option<DiscoveryStatus>,
    pub change: Option<RegistryEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RegistryChange {
    Added,
    Edited,
    Enabled,
    Disabled,
    Removed,
    Refreshed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEvent {
    pub app_id: AppId,
    pub change: RegistryChange,
}
