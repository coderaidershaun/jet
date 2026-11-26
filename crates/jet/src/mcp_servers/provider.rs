//! The providers whose MCP servers Jet knows: each one's published address (from its own docs,
//! November 2026), what it is for, and how it signs in.

use crate::store::McpProvider;
use serde::Serialize;

/// How the page asks for a provider's key by default.
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
                "Google signs in with OAuth. Until Jet can, a Google access token pasted as a bearer token works for about an hour."
            }
            McpProvider::Google => {
                "Google has one server for each product; this one is Drive, and Calendar is at https://calendarmcp.googleapis.com/mcp/v1. A Google access token pasted as a bearer token works for about an hour."
            }
            McpProvider::Outlook => {
                "Microsoft accepts only an OAuth sign-in for this server, so it cannot connect yet."
            }
            McpProvider::Slack => {
                "Slack accepts only an OAuth sign-in for this server, so it cannot connect yet."
            }
            McpProvider::Notion => {
                "On Business and Enterprise plans, a workspace owner can make an MCP token in Notion's developer portal. Paste it as a bearer token."
            }
            McpProvider::Jira => {
                "If your Atlassian admin allows API tokens, give your Atlassian email and an API token."
            }
            McpProvider::Custom => {
                "The address of the server's MCP endpoint, often ending in /mcp."
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
        }
    }
}
