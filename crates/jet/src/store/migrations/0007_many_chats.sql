-- A user has many chats. How far the user has read each one is the id of the newest entry they have
-- seen; Jet entries after it are the chat's unread count. Chats that exist already count as read.
ALTER TABLE chats ADD COLUMN read_through INTEGER NOT NULL DEFAULT 0;
UPDATE chats SET read_through = coalesce(
    (SELECT max(id) FROM entries WHERE entries.chat_id = chats.id), 0);

-- The chat a file was sent or written in; NULL for an upload not yet sent. Forgetting or deleting a
-- chat takes its files with it. Files already sent go to their user's main chat.
ALTER TABLE files ADD COLUMN chat_id INTEGER REFERENCES chats (id) ON DELETE CASCADE;
UPDATE files SET chat_id = (
    SELECT id FROM chats WHERE chats.user_id = files.user_id AND chats.kind = 'main')
WHERE attached = 1;
