-- The task list: every step is one task of the user's, under a goal (an objective) or under none, in
-- one order for all of the user's tasks, with when it was started and done.

-- Nothing references objective_steps, so the rebuild runs safely inside the runner's transaction with
-- foreign keys on. Ids are never reused, so a stale page that names a deleted task is refused.
CREATE TABLE new_objective_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- NULL for a task under no goal, which is the user's alone and never shared.
    objective_id INTEGER REFERENCES objectives (id) ON DELETE CASCADE,
    -- The user's one order of all their tasks, from 1. A goal's steps are in this order too.
    position INTEGER NOT NULL,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
    -- The day the task is planned for, YYYY-MM-DD in the user's zone; NULL for later, with no day.
    due_date TEXT,
    started_at INTEGER,
    done_at INTEGER
) STRICT;

-- Existing steps keep their ids and each goal's order; goals follow one another by id.
INSERT INTO new_objective_steps (id, user_id, objective_id, position, title, due_date, started_at, done_at)
SELECT s.id, o.user_id, s.objective_id,
       row_number() OVER (PARTITION BY o.user_id ORDER BY s.objective_id, s.position, s.id),
       s.title, s.due_date, NULL, s.done_at
FROM objective_steps s JOIN objectives o ON o.id = s.objective_id;

DROP TABLE objective_steps;
ALTER TABLE new_objective_steps RENAME TO objective_steps;
CREATE INDEX steps_by_objective ON objective_steps (objective_id);
CREATE INDEX steps_by_user ON objective_steps (user_id, position);
CREATE INDEX steps_done ON objective_steps (done_at) WHERE done_at IS NOT NULL;

-- A line about one task, so that a newer change of that task replaces its waiting line, and an add
-- the user undoes before Jet hears of it is never told. `step_added` marks a line about a task that
-- Jet has not heard of yet.
ALTER TABLE pane_taps ADD COLUMN step_id INTEGER;
ALTER TABLE pane_taps ADD COLUMN step_added INTEGER NOT NULL DEFAULT 0 CHECK (step_added IN (0, 1));
CREATE INDEX pane_taps_by_step ON pane_taps (step_id) WHERE announced = 0 AND step_id IS NOT NULL;

-- The task list as the page reads it: each task with its goal, its state in one word, and the chat a
-- change of it is told in (its goal's, or the main chat). A task of a goal that is done or dropped
-- shows only once it is done, in the done pile.
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

-- The goals of the task list: the user's open objectives, with their tasks counted and their colour
-- in one word. Green once every task is done; yellow once any is started or done.
CREATE VIEW task_list_goals AS
SELECT
    o.id,
    o.user_id,
    o.chat_id,
    o.title,
    o.deliverable,
    o.due_date AS due,
    o.status,
    count(s.id) AS tasks,
    count(s.done_at) AS done,
    CASE
        WHEN count(s.id) > 0 AND count(s.done_at) = count(s.id) THEN 'done'
        WHEN count(s.started_at) > 0 OR count(s.done_at) > 0 THEN 'in_progress'
        ELSE 'not_started'
    END AS state
FROM objectives o
LEFT JOIN objective_steps s ON s.objective_id = o.id
WHERE o.status IN ('active', 'paused')
GROUP BY o.id;
