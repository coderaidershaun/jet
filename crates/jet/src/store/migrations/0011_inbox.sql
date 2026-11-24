-- What a user sends to a colleague's Jet, after the sender's own tap on a send card. `state` moves
-- from sent to seen (the recipient's Jet brought it up) and ends as answered, declined, done or
-- expired. The sender's chat is where the answer comes back.
CREATE TABLE inbox_items (
    id INTEGER PRIMARY KEY,
    from_user INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    to_user INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    chat_id INTEGER REFERENCES chats (id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('question', 'task', 'note')),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
    objective_id INTEGER REFERENCES objectives (id) ON DELETE SET NULL,
    state TEXT NOT NULL DEFAULT 'sent'
        CHECK (state IN ('sent', 'seen', 'answered', 'declined', 'done', 'expired')),
    sent_at INTEGER NOT NULL,
    closed_at INTEGER,
    reply TEXT,
    -- Raised when the answer came from the recipient's Jet and not from the recipient.
    answered_by_jet INTEGER NOT NULL DEFAULT 0,
    -- Raised once the recipient's Jet has tried to answer from the shared objectives.
    tried_alone INTEGER NOT NULL DEFAULT 0,
    -- The agent-task that brings the item to the recipient.
    task_id INTEGER REFERENCES agent_tasks (id) ON DELETE SET NULL
) STRICT;
-- The daily count of one sender to one recipient, and the other foreign keys, which a delete of
-- the row they name looks up.
CREATE INDEX inbox_by_sender ON inbox_items (from_user, to_user, sent_at);
CREATE INDEX inbox_by_recipient ON inbox_items (to_user);
CREATE INDEX inbox_by_chat ON inbox_items (chat_id);
CREATE INDEX inbox_by_objective ON inbox_items (objective_id);
CREATE INDEX inbox_by_task ON inbox_items (task_id);
-- The expiry looks only at items that are still open.
CREATE INDEX inbox_open_by_age ON inbox_items (sent_at) WHERE state IN ('sent', 'seen');

-- A send card in the sender's thread. It stores no item until the sender taps it: `item_id` is
-- set by the tap.
CREATE TABLE send_cards (
    id INTEGER PRIMARY KEY,
    from_user INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    to_user INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    chat_id INTEGER REFERENCES chats (id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('question', 'task', 'note')),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
    objective_id INTEGER REFERENCES objectives (id) ON DELETE SET NULL,
    item_id INTEGER REFERENCES inbox_items (id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX send_cards_by_sender ON send_cards (from_user);
CREATE INDEX send_cards_by_recipient ON send_cards (to_user);
CREATE INDEX send_cards_by_chat ON send_cards (chat_id);
CREATE INDEX send_cards_by_objective ON send_cards (objective_id);
CREATE INDEX send_cards_by_item ON send_cards (item_id);
