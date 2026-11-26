-- A deleted chat's id is never given to a new chat, so a page that still has the old chat open
-- cannot send into a new one. The table is rebuilt with AUTOINCREMENT; every row keeps its id, so
-- the rows that reference chats are untouched. The task list view reads chats, so it is dropped
-- for the rebuild and made again as it was.

DROP VIEW task_list;

CREATE TABLE chats_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('main', 'objective', 'topic')),
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    -- The provider session record of the chat, NULL before the first reply and after Forget.
    session TEXT CHECK (session IS NULL OR json_valid(session)),
    read_through INTEGER NOT NULL DEFAULT 0
) STRICT;

INSERT INTO chats_new (id, user_id, kind, title, created_at, session, read_through)
    SELECT id, user_id, kind, title, created_at, session, read_through FROM chats ORDER BY id;

DROP TABLE chats;
ALTER TABLE chats_new RENAME TO chats;

CREATE UNIQUE INDEX one_main_chat_per_user ON chats (user_id) WHERE kind = 'main';

CREATE VIEW task_list AS
SELECT
    s.id,
    s.user_id,
    s.objective_id AS goal_id,
    o.title AS goal_title,
    coalesce(o.chat_id, m.id) AS chat_id,
    s.title,
    s.due_date AS date,
    s.position,
    s.started_at,
    s.done_at,
    CASE
        WHEN s.done_at IS NOT NULL THEN 'done'
        WHEN s.started_at IS NOT NULL THEN 'in_progress'
        ELSE 'not_started'
    END AS state
FROM objective_steps s
LEFT JOIN objectives o ON o.id = s.objective_id
JOIN chats m ON m.user_id = s.user_id AND m.kind = 'main'
WHERE s.objective_id IS NULL
   OR o.status IN ('active', 'paused')
   OR s.done_at IS NOT NULL;
