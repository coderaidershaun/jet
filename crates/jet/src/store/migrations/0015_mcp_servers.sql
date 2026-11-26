-- The MCP servers each user added: where each one is, whether it is on, the key it is called with,
-- sealed with the server's token key, and what Jet found the last time it connected.
CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider TEXT NOT NULL
        CHECK (provider IN ('gmail', 'google', 'outlook', 'slack', 'notion', 'jira', 'custom')),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    -- The header the key is sent in, such as Authorization. The page may show it; the key it never sees.
    key_header TEXT,
    sealed_key BLOB,
    state TEXT NOT NULL CHECK (state IN ('unchecked', 'connected', 'needs_key', 'failed')),
    reason TEXT,
    tools TEXT NOT NULL CHECK (json_valid(tools)),
    CHECK ((key_header IS NULL) = (sealed_key IS NULL)),
    CHECK ((state = 'failed') = (reason IS NOT NULL)),
    -- Also the index that finds a user's servers.
    UNIQUE (user_id, url)
) STRICT;
