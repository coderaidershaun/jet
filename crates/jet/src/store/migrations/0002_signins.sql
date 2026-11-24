-- One row per signed-in browser, and the refresh tokens it has been given, kept only as hashes.
CREATE TABLE signins (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);

CREATE TABLE refresh_tokens (
    hash BLOB PRIMARY KEY,
    signin_id TEXT NOT NULL REFERENCES signins (id) ON DELETE CASCADE,
    replaced_at INTEGER
);

CREATE INDEX refresh_tokens_by_signin ON refresh_tokens (signin_id);
