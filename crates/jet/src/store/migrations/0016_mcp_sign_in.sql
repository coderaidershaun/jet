-- The OAuth sign-in of each MCP server: how its provider signs Jet in, the client Jet signs in as,
-- the tokens it holds, sealed with the server's token key, and each sign-in the user has started.
-- A server that needs a sign-in can now say why, so its state carries a reason too.
-- Warning: from here on mcp_sign_ins and mcp_sign_in_starts reference mcp_servers with ON DELETE
-- CASCADE, and migrations run with foreign keys on. A later rebuild of mcp_servers must turn foreign
-- keys off before its transaction, or dropping the old table deletes every sign-in.
CREATE TABLE mcp_servers_new (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider TEXT NOT NULL
        CHECK (provider IN ('gmail', 'google', 'outlook', 'slack', 'notion', 'jira', 'custom')),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    key_header TEXT,
    sealed_key BLOB,
    state TEXT NOT NULL CHECK (state IN ('unchecked', 'connected', 'needs_key', 'failed')),
    reason TEXT,
    tools TEXT NOT NULL CHECK (json_valid(tools)),
    CHECK ((key_header IS NULL) = (sealed_key IS NULL)),
    CHECK (state <> 'failed' OR reason IS NOT NULL),
    CHECK (state IN ('failed', 'needs_key') OR reason IS NULL),
    UNIQUE (user_id, url)
) STRICT;
INSERT INTO mcp_servers_new (id, user_id, provider, name, url, enabled, key_header, sealed_key, state, reason, tools)
    SELECT id, user_id, provider, name, url, enabled, key_header, sealed_key, state, reason, tools
    FROM mcp_servers ORDER BY rowid;
DROP TABLE mcp_servers;
ALTER TABLE mcp_servers_new RENAME TO mcp_servers;

CREATE TABLE mcp_sign_ins (
    server_id TEXT PRIMARY KEY REFERENCES mcp_servers (id) ON DELETE CASCADE,
    authorization_endpoint TEXT NOT NULL,
    token_endpoint TEXT NOT NULL,
    -- The RFC 8707 resource: the server's own address, as its metadata names it.
    resource TEXT NOT NULL,
    scope TEXT,
    client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 512),
    sealed_client_secret BLOB,
    -- 1 when Jet registered the client itself; 0 when the user pasted its id.
    registered INTEGER NOT NULL CHECK (registered IN (0, 1)),
    -- The redirect address the client was registered with.
    redirect_uri TEXT NOT NULL,
    -- 1 when the client secret goes in the token request's body, 0 when in its Authorization header.
    secret_in_body INTEGER NOT NULL CHECK (secret_in_body IN (0, 1)),
    sealed_access BLOB,
    sealed_refresh BLOB,
    -- When Jet renews the access token before using it, in seconds since 1970: a little before it
    -- runs out. NULL when the provider did not say how long it lasts.
    renew_at INTEGER,
    CHECK (sealed_access IS NOT NULL OR (sealed_refresh IS NULL AND renew_at IS NULL))
) STRICT;

CREATE TABLE mcp_sign_in_starts (
    -- The SHA-256 of the state sent to the provider, so the table alone cannot finish a sign-in.
    state_hash TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    sealed_verifier BLOB NOT NULL,
    redirect_uri TEXT NOT NULL,
    expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX mcp_sign_in_starts_server ON mcp_sign_in_starts (server_id);
CREATE INDEX mcp_sign_in_starts_user ON mcp_sign_in_starts (user_id);
