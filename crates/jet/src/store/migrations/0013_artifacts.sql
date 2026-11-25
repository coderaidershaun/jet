-- The chats an artifact was shared into, beside the chat that keeps it (files.chat_id).
CREATE TABLE file_chats (
    file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    PRIMARY KEY (file_id, chat_id)
) STRICT;
CREATE INDEX file_chats_by_chat ON file_chats (chat_id);
CREATE INDEX files_by_chat ON files (chat_id);

-- The contents a file had before each change; the newest five are kept.
CREATE TABLE file_versions (
    file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    at INTEGER NOT NULL,
    contents BLOB NOT NULL,
    PRIMARY KEY (file_id, version)
) STRICT;
