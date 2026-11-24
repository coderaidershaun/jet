-- When an objective was closed as done or dropped. Objectives closed before this column existed
-- take their last change, which was the close.
ALTER TABLE objectives ADD COLUMN closed_at INTEGER;
UPDATE objectives SET closed_at = updated_at WHERE status IN ('done', 'dropped');

-- A reply card in the thread of the user a colleague's item was sent to. It answers nothing until
-- that user taps it: `sent_at` is set by the tap.
CREATE TABLE reply_cards (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    chat_id INTEGER REFERENCES chats (id) ON DELETE SET NULL,
    item_id INTEGER NOT NULL REFERENCES inbox_items (id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN ('answered', 'declined', 'done')),
    body TEXT NOT NULL CHECK (length(body) <= 2000),
    created_at INTEGER NOT NULL,
    sent_at INTEGER
) STRICT;
CREATE INDEX reply_cards_by_user ON reply_cards (user_id);
CREATE INDEX reply_cards_by_chat ON reply_cards (chat_id);
CREATE INDEX reply_cards_by_item ON reply_cards (item_id);
