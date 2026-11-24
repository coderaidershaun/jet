-- What a user is working towards (objectives) and what Jet sets itself to do (agent-tasks), with the
-- user's time zone that turns the local times Jet writes into UTC. Dates are `YYYY-MM-DD` text in the
-- user's zone; times are Unix seconds. Duration and days left are never stored.
ALTER TABLE users ADD COLUMN time_zone TEXT;

CREATE TABLE objectives (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL REFERENCES chats (id),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    deliverable TEXT NOT NULL CHECK (length(deliverable) BETWEEN 1 AND 2000),
    start_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done', 'dropped')),
    -- Raised by every change.
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX objectives_by_user ON objectives (user_id);
CREATE INDEX objectives_by_chat ON objectives (chat_id);

CREATE TABLE objective_steps (
    id INTEGER PRIMARY KEY,
    objective_id INTEGER NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
    due_date TEXT,
    done_at INTEGER
) STRICT;
CREATE INDEX steps_by_objective ON objective_steps (objective_id);

-- `jet`: target is empty. `github`: target is owner/name, detail the user's GitHub login.
-- `web`: target is a page address (detail `page`) or a search topic (detail `search`).
-- `app`: target is an app id, detail one read-only tool of that app.
CREATE TABLE objective_sources (
    id INTEGER PRIMARY KEY,
    objective_id INTEGER NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('jet', 'github', 'web', 'app')),
    target TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX sources_by_objective ON objective_sources (objective_id);

CREATE TABLE objective_notes (
    id INTEGER PRIMARY KEY,
    objective_id INTEGER NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    -- NULL for a note that only records new dates.
    status TEXT CHECK (status IN ('on track', 'at risk', 'blocked', 'done')),
    moved TEXT NOT NULL,
    blockers TEXT NOT NULL DEFAULT '',
    new_dates TEXT NOT NULL DEFAULT '',
    is_private INTEGER NOT NULL DEFAULT 0,
    -- The chat entry the note came from, when it is known.
    entry_id INTEGER
) STRICT;
CREATE INDEX notes_by_objective ON objective_notes (objective_id);

CREATE TABLE agent_tasks (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL REFERENCES chats (id),
    objective_id INTEGER REFERENCES objectives (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('check', 'follow_up')),
    why TEXT NOT NULL CHECK (length(why) BETWEEN 1 AND 300),
    due_at INTEGER NOT NULL,
    local_time TEXT NOT NULL,
    time_zone TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (state IN ('scheduled', 'running', 'done', 'cancelled', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    -- Raised by every change.
    version INTEGER NOT NULL DEFAULT 1,
    set_by TEXT NOT NULL CHECK (set_by IN ('jet', 'user', 'default', 'review')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (kind <> 'check' OR objective_id IS NOT NULL)
) STRICT;
CREATE INDEX tasks_by_user ON agent_tasks (user_id);
CREATE INDEX tasks_by_due ON agent_tasks (state, due_at);
-- At most one open check for an objective.
CREATE UNIQUE INDEX one_open_check_per_objective ON agent_tasks (objective_id)
    WHERE kind = 'check' AND state IN ('scheduled', 'running');

CREATE TABLE task_runs (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES agent_tasks (id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    outcome TEXT CHECK (outcome IN
        ('spoke', 'silent', 'held', 'failed', 'interrupted', 'preempted', 'stale')),
    found TEXT NOT NULL DEFAULT '',
    sources_read TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources_read)),
    tokens INTEGER
) STRICT;
CREATE INDEX runs_by_task ON task_runs (task_id);
