-- Who an objective is shared with: one row for a user or one for a team, never both. Nothing is
-- shared until the owner taps a share card.
CREATE TABLE objective_shares (
    objective_id INTEGER NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
    team_id INTEGER REFERENCES teams (id) ON DELETE CASCADE,
    CHECK ((user_id IS NULL) <> (team_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX shares_once_per_user ON objective_shares (objective_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX shares_once_per_team ON objective_shares (objective_id, team_id) WHERE team_id IS NOT NULL;
CREATE INDEX shares_by_user ON objective_shares (user_id);
CREATE INDEX shares_by_team ON objective_shares (team_id);

-- A share card in the owner's thread. `refused` is a card that can no longer be applied, because
-- a newer card for the same objective replaced it.
CREATE TABLE share_proposals (
    id INTEGER PRIMARY KEY,
    objective_id INTEGER NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL REFERENCES chats (id),
    state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'applied', 'refused')),
    created_at INTEGER NOT NULL,
    applied_at INTEGER,
    -- Raised once the next message in the chat has told Jet of the tap.
    announced INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX proposals_by_objective ON share_proposals (objective_id);

-- The people and teams on a card, each with its tick. After the tap the ticks are what was applied.
CREATE TABLE share_proposal_entries (
    proposal_id INTEGER NOT NULL REFERENCES share_proposals (id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
    team_id INTEGER REFERENCES teams (id) ON DELETE CASCADE,
    ticked INTEGER NOT NULL,
    CHECK ((user_id IS NULL) <> (team_id IS NULL))
) STRICT;
CREATE INDEX entries_by_proposal ON share_proposal_entries (proposal_id);
