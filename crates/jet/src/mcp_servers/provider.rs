//! The providers whose MCP servers Jet knows: each one's published address (from its own docs,
//! November 2026), what it is for, and what signing in to it asks of the user.

use crate::store::McpProvider;
use serde::Serialize;

/// Which key the page offers first when the user gives a key instead of signing in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum KeyKind {
    Bearer,
    Basic,
}

/// What the page shows when the user picks the provider.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderFacts {
    id: McpProvider,
    label: &'static str,
    /// The published address, or `None` when the user must give one.
    address: Option<&'static str>,
    /// How the server signs in, in a sentence or two.
    note: &'static str,
    key_kind: KeyKind,
    /// Whether the provider is known to let no client register itself, so the user makes one in
    /// its console with Jet's redirect address.
    needs_own_client: bool,
}

impl McpProvider {
    pub(crate) const ALL: [McpProvider; 7] = [
        McpProvider::Gmail,
        McpProvider::Google,
        McpProvider::Outlook,
        McpProvider::Slack,
        McpProvider::Notion,
        McpProvider::Jira,
        McpProvider::Custom,
    ];

    pub(crate) fn label(self) -> &'static str {
        match self {
            McpProvider::Gmail => "Gmail",
            McpProvider::Google => "Google Drive",
            McpProvider::Outlook => "Outlook",
            McpProvider::Slack => "Slack",
            McpProvider::Notion => "Notion",
            McpProvider::Jira => "Jira",
            McpProvider::Custom => "Custom server",
        }
    }

    fn address(self) -> Option<&'static str> {
        match self {
            McpProvider::Gmail => Some("https://gmailmcp.googleapis.com/mcp/v1"),
            McpProvider::Google => Some("https://drivemcp.googleapis.com/mcp/v1"),
            McpProvider::Outlook => Some("https://workiq.svc.cloud.microsoft/mcp"),
            McpProvider::Slack => Some("https://mcp.slack.com/mcp"),
            McpProvider::Notion => Some("https://mcp.notion.com/mcp"),
            McpProvider::Jira => Some("https://mcp.atlassian.com/v2/mcp"),
            McpProvider::Custom => None,
        }
    }

    /// What the server at `host` is for, as Jet is told. A custom server is known only by the name
    /// the user gave it and its tools.
    pub(crate) fn purpose(self, host: &str) -> String {
        let known = match self {
            McpProvider::Gmail => "the user's Gmail: search, read and draft email.",
            McpProvider::Google => "the user's Google Drive: search and read their files.",
            McpProvider::Outlook => {
                "the user's Microsoft 365 work data through Work IQ: Outlook mail, calendar, files and chats."
            }
            McpProvider::Slack => {
                "the user's Slack workspace: search and read channels and messages."
            }
            McpProvider::Notion => {
                "the user's Notion workspace: search, read and edit pages and databases."
            }
            McpProvider::Jira => {
                "the user's Atlassian Jira and Confluence: search, read and update issues and pages."
            }
            McpProvider::Custom => {
                return format!("a server the user added at {host}; its tools say what it does.");
            }
        };
        known.to_owned()
    }

    fn note(self) -> &'static str {
        match self {
            McpProvider::Gmail => {
                "Signs in with your Google account. Google may ask for an OAuth client of your own: make one in Google Cloud with the Gmail API turned on, add the redirect address Jet shows, then paste its client id and secret."
            }
            McpProvider::Google => {
                "Google has one server for each product; this one is Drive, and Calendar is at https://calendarmcp.googleapis.com/mcp/v1. It signs in as Gmail does, with the Drive API turned on."
            }
            McpProvider::Outlook => {
                "Signs in with your work account, through an app your organisation registers in Microsoft Entra with the redirect address Jet shows. Paste that app's client id and secret when Jet asks."
            }
            McpProvider::Slack => {
                "Slack does not let Jet register itself: make an internal Slack app with the redirect address Jet shows, then paste its client id and secret when Jet asks."
            }
            McpProvider::Notion => {
                "Signs in with your Notion account. On Business and Enterprise plans, an MCP token from Notion's developer portal also works as a bearer token."
            }
            McpProvider::Jira => {
                "Signs in with your Atlassian account. If your admin allows API tokens, your Atlassian email and an API token also work."
            }
            McpProvider::Custom => {
                "The address of the server's MCP endpoint, often ending in /mcp. Jet signs in when the server asks it to."
            }
        }
    }

    fn key_kind(self) -> KeyKind {
        match self {
            McpProvider::Jira => KeyKind::Basic,
            _ => KeyKind::Bearer,
        }
    }

    pub(crate) fn facts(self) -> ProviderFacts {
        ProviderFacts {
            id: self,
            label: self.label(),
            address: self.address(),
            note: self.note(),
            key_kind: self.key_kind(),
            needs_own_client: matches!(
                self,
                McpProvider::Gmail
                    | McpProvider::Google
                    | McpProvider::Outlook
                    | McpProvider::Slack
            ),
        }
    }
}
