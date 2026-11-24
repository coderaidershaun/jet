-- A tap in the plan pane (a tick, a snooze, a cancel, a note flipped), kept as the line Jet is
-- told before the user's next message in the chat it concerns. `announced` is raised once told.
CREATE TABLE pane_taps (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    line TEXT NOT NULL,
    at INTEGER NOT NULL,
    announced INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX pane_taps_by_chat ON pane_taps (chat_id) WHERE announced = 0;
