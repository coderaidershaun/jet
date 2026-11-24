-- Each user's own Jet: chats with their history and provider session, the user's notes, settings,
-- apps and files, the server-wide settings only an admin may change, and the record that the files
-- of an older Jet were copied in.

-- A user has one main chat, made with the account; later kinds of chat need no new table.
CREATE TABLE chats (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('main', 'objective', 'topic')),
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    -- The provider session record of the chat, NULL before the first reply and after Forget.
    session TEXT CHECK (session IS NULL OR json_valid(session))
) STRICT;

CREATE UNIQUE INDEX one_main_chat_per_user ON chats (user_id) WHERE kind = 'main';

INSERT INTO chats (user_id, kind, created_at) SELECT id, 'main', unixepoch() FROM users;

-- The thread of a chat, one row per entry. Ids keep counting after Forget, which only marks the
-- entries it took out of the thread.
CREATE TABLE entries (
    chat_id INTEGER NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    id INTEGER NOT NULL CHECK (id > 0),
    forgotten_at INTEGER,
    entry TEXT NOT NULL CHECK (
        json_valid(entry) AND json_extract(entry, '$.role') IN ('user', 'jet')
    ),
    PRIMARY KEY (chat_id, id)
) STRICT;

-- The limits are those the agent cuts the notes to before it saves them.
CREATE TABLE notes (
    user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    memory TEXT NOT NULL CHECK (length(memory) <= 2200),
    about_user TEXT NOT NULL CHECK (length(about_user) <= 1375),
    recent TEXT NOT NULL CHECK (length(recent) <= 1500)
) STRICT;

CREATE TABLE settings (
    user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    settings TEXT NOT NULL CHECK (json_valid(settings))
) STRICT;

-- Whoever sets these runs a program of their choice on the server, so only an admin reads or
-- writes them.
CREATE TABLE server_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    claude_path TEXT,
    codex_path TEXT
) STRICT;

CREATE TABLE apps (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    app TEXT NOT NULL CHECK (json_valid(app))
) STRICT;

-- The files a user attached and the files Jet wrote for them, kept whole in the database.
CREATE TABLE files (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    attached INTEGER NOT NULL CHECK (attached IN (0, 1)),
    about TEXT NOT NULL CHECK (json_valid(about)),
    contents BLOB NOT NULL CHECK (length(contents) <= 33554432)
) STRICT;

CREATE INDEX files_by_user ON files (user_id, at);

-- One row once the older Jet's files in the data directory were looked for, copied or not.
CREATE TABLE legacy_import (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    imported_at INTEGER NOT NULL
) STRICT;
