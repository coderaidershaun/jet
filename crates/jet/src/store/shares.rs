//! Who an objective is shared with, the share cards that propose changing it, and the one read a
//! colleague gets. Only the owner's tap on a card writes a share, and the colleague's read gives
//! back a fixed set of fields, so a private note, a chat or an evidence source cannot leak.

use super::text_enum::text_enum;
use super::{
    ChatId, NoteStatus, ObjectiveId, ObjectiveStatus, Step, Store, StoreError, UserId, seconds,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct ProposalId(pub(crate) i64);

text_enum!(ProposalState {
    Proposed = "proposed",
    Applied = "applied",
    Refused = "refused",
});

/// An objective as a colleague reads it. Dates are the owner's local dates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Shared {
    pub(crate) id: ObjectiveId,
    pub(crate) title: String,
    pub(crate) deliverable: String,
    pub(crate) start: String,
    pub(crate) due: String,
    pub(crate) status: ObjectiveStatus,
    pub(crate) steps: Vec<Step>,
    pub(crate) notes: Vec<SharedNote>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SharedNote {
    pub(crate) at: u64,
    pub(crate) status: Option<NoteStatus>,
    pub(crate) moved: String,
    pub(crate) blockers: String,
    pub(crate) new_dates: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CardPerson {
    pub(crate) id: UserId,
    pub(crate) name: String,
    pub(crate) ticked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CardTeam {
    pub(crate) id: i64,
    pub(crate) name: String,
    pub(crate) members: Vec<String>,
    pub(crate) ticked: bool,
}

/// The share card as the page draws it, in the state it is in now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareCard {
    pub(crate) id: ProposalId,
    pub(crate) objective_id: ObjectiveId,
    pub(crate) title: String,
    pub(crate) state: ProposalState,
    pub(crate) people: Vec<CardPerson>,
    pub(crate) teams: Vec<CardTeam>,
    pub(crate) applied_at: Option<u64>,
}

/// Who an objective is shared with right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sharing {
    pub(crate) people: Vec<SharingPerson>,
    pub(crate) teams: Vec<SharingTeam>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SharingPerson {
    pub(crate) id: UserId,
    pub(crate) name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SharingTeam {
    pub(crate) id: i64,
    pub(crate) name: String,
    pub(crate) members: Vec<String>,
}

/// What `apply_share_proposal` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Applied {
    Done,
    /// No such card for this user.
    Missing,
    /// The card was applied or replaced already.
    NotOpen(ProposalState),
    /// A ticked person or team is not on the card.
    NotOnCard,
}

/// Where a tap is kept: a share card, or a line from the plan pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TapId {
    Share(ProposalId),
    Pane(i64),
}

/// A tap that Jet has not been told of yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Tapped {
    pub(crate) id: TapId,
    notice: String,
}

impl Tapped {
    /// The line that goes in front of the user's next message.
    pub(crate) fn notice(&self) -> String {
        self.notice.clone()
    }
}

impl Store {
    /// The objectives of `owner` that are shared with `viewer`, directly or through a team the
    /// viewer is in, as the viewer may read them: no private note, chat, source or agent-task.
    pub(crate) fn shared_objectives(
        &self,
        viewer: UserId,
        owner: UserId,
    ) -> Result<Vec<Shared>, StoreError> {
        let mut shared = self.with(|db| {
            let mut query = db.prepare(
                "SELECT o.id, o.title, o.deliverable, o.start_date, o.due_date, o.status
                 FROM objectives o
                 WHERE o.user_id = ?2 AND EXISTS (
                     SELECT 1 FROM objective_shares s WHERE s.objective_id = o.id AND (
                         s.user_id = ?1
                         OR s.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?1)))
                 ORDER BY o.id",
            )?;
            query
                .query_map(params![viewer.0, owner.0], |row| {
                    Ok(Shared {
                        id: ObjectiveId(row.get(0)?),
                        title: row.get(1)?,
                        deliverable: row.get(2)?,
                        start: row.get(3)?,
                        due: row.get(4)?,
                        status: row.get(5)?,
                        steps: Vec::new(),
                        notes: Vec::new(),
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })?;
        for objective in &mut shared {
            objective.steps = self.steps(owner, objective.id)?;
            objective.notes = self.with(|db| public_notes(db, objective.id))?;
        }
        Ok(shared)
    }

    /// Who the owner's objective is shared with. `None` when it is not theirs.
    pub(crate) fn sharing(
        &self,
        owner: UserId,
        objective: ObjectiveId,
    ) -> Result<Option<Sharing>, StoreError> {
        self.with(|db| {
            if !owns(db, owner, objective)? {
                return Ok(None);
            }
            let people = db
                .prepare(
                    "SELECT u.id, u.display_name FROM objective_shares s JOIN users u ON u.id = s.user_id
                     WHERE s.objective_id = ?1 ORDER BY u.id",
                )?
                .query_map([objective.0], |row| {
                    Ok(SharingPerson {
                        id: UserId(row.get(0)?),
                        name: row.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            let teams = db
                .prepare(
                    "SELECT t.id, t.name FROM objective_shares s JOIN teams t ON t.id = s.team_id
                     WHERE s.objective_id = ?1 ORDER BY t.id",
                )?
                .query_map([objective.0], |row| Ok((row.get::<_, i64>(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<(i64, String)>>>()?
                .into_iter()
                .map(|(id, name)| {
                    Ok(SharingTeam {
                        id,
                        members: member_names(db, id)?,
                        name,
                    })
                })
                .collect::<rusqlite::Result<_>>()?;
            Ok(Some(Sharing { people, teams }))
        })
    }

    /// Makes a card for the owner's objective. It lists the proposed people and teams ticked, and
    /// the ones it is shared with now unticked, so a tap can only keep or remove them. An earlier
    /// card for the objective that is still waiting is refused. `None` when the objective is not
    /// the owner's.
    pub(crate) fn add_share_proposal(
        &self,
        owner: UserId,
        chat: ChatId,
        objective: ObjectiveId,
        (people, teams): (&[UserId], &[i64]),
        at: u64,
    ) -> Result<Option<ProposalId>, StoreError> {
        self.with(|db| {
            let tx = db.transaction()?;
            if !owns(&tx, owner, objective)? {
                return Ok(None);
            }
            // Keyed by (user, team); exactly one of the two is set.
            let mut entries: BTreeMap<(Option<i64>, Option<i64>), bool> = BTreeMap::new();
            let mut current = tx.prepare(
                "SELECT user_id, team_id FROM objective_shares WHERE objective_id = ?1",
            )?;
            for share in current.query_map([objective.0], |row| Ok((row.get(0)?, row.get(1)?)))? {
                entries.insert(share?, false);
            }
            drop(current);
            for person in people {
                entries.insert((Some(person.0), None), true);
            }
            for team in teams {
                entries.insert((None, Some(*team)), true);
            }
            tx.execute(
                "UPDATE share_proposals SET state = 'refused' WHERE objective_id = ?1 AND state = 'proposed'",
                [objective.0],
            )?;
            tx.execute(
                "INSERT INTO share_proposals (objective_id, user_id, chat_id, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![objective.0, owner.0, chat.0, seconds(at)],
            )?;
            let id = tx.last_insert_rowid();
            for ((user, team), ticked) in entries {
                tx.execute(
                    "INSERT INTO share_proposal_entries (proposal_id, user_id, team_id, ticked) VALUES (?1, ?2, ?3, ?4)",
                    params![id, user, team, ticked],
                )?;
            }
            tx.commit()?;
            Ok(Some(ProposalId(id)))
        })
    }

    /// The cards of the owner with these ids, in the state they are in now. Another user's card is
    /// left out, as a missing one is.
    pub(crate) fn share_cards(
        &self,
        owner: UserId,
        ids: &[ProposalId],
    ) -> Result<Vec<ShareCard>, StoreError> {
        self.with(|db| {
            let mut cards = Vec::new();
            for id in ids {
                cards.extend(card(db, owner, *id)?);
            }
            Ok(cards)
        })
    }

    /// Applies exactly the ticked people and teams: from now the objective is shared with them
    /// and nobody else. Only the owner's own card can be applied, and only while it waits.
    pub(crate) fn apply_share_proposal(
        &self,
        owner: UserId,
        id: ProposalId,
        (people, teams): (&[UserId], &[i64]),
        at: u64,
    ) -> Result<Applied, StoreError> {
        self.with(|db| {
            let tx = db.transaction()?;
            let found: Option<(i64, ProposalState)> = tx
                .query_row(
                    "SELECT objective_id, state FROM share_proposals WHERE id = ?1 AND user_id = ?2",
                    params![id.0, owner.0],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((objective, state)) = found else {
                return Ok(Applied::Missing);
            };
            if state != ProposalState::Proposed {
                return Ok(Applied::NotOpen(state));
            }
            let on_card = |user: Option<i64>, team: Option<i64>| {
                tx.query_row(
                    "SELECT count(*) FROM share_proposal_entries WHERE proposal_id = ?1 AND user_id IS ?2 AND team_id IS ?3",
                    params![id.0, user, team],
                    |row| row.get::<_, i64>(0),
                )
                .map(|count| count == 1)
            };
            for person in people {
                if !on_card(Some(person.0), None)? {
                    return Ok(Applied::NotOnCard);
                }
            }
            for team in teams {
                if !on_card(None, Some(*team))? {
                    return Ok(Applied::NotOnCard);
                }
            }
            tx.execute("UPDATE share_proposal_entries SET ticked = 0 WHERE proposal_id = ?1", [id.0])?;
            tx.execute("DELETE FROM objective_shares WHERE objective_id = ?1", [objective])?;
            for person in people {
                tx.execute(
                    "UPDATE share_proposal_entries SET ticked = 1 WHERE proposal_id = ?1 AND user_id = ?2",
                    params![id.0, person.0],
                )?;
                tx.execute(
                    "INSERT OR IGNORE INTO objective_shares (objective_id, user_id) VALUES (?1, ?2)",
                    params![objective, person.0],
                )?;
            }
            for team in teams {
                tx.execute(
                    "UPDATE share_proposal_entries SET ticked = 1 WHERE proposal_id = ?1 AND team_id = ?2",
                    params![id.0, team],
                )?;
                tx.execute(
                    "INSERT OR IGNORE INTO objective_shares (objective_id, team_id) VALUES (?1, ?2)",
                    params![objective, team],
                )?;
            }
            tx.execute(
                "UPDATE share_proposals SET state = 'applied', applied_at = ?2 WHERE id = ?1",
                params![id.0, seconds(at)],
            )?;
            tx.commit()?;
            Ok(Applied::Done)
        })
    }

    /// The taps in the chat that no message has told Jet of yet, oldest first, marked as told in
    /// the same transaction. A change that lands after this call finds them told, so it is told
    /// again in its own line. The caller puts them back with `put_taps_back` if its send fails.
    pub(crate) fn take_taps(&self, chat: ChatId) -> Result<Vec<Tapped>, StoreError> {
        self.with(|db| {
            let tx = db.transaction()?;
            let told = unannounced(&tx, chat)?;
            set_announced(&tx, &told, 1)?;
            tx.commit()?;
            Ok(told)
        })
    }

    /// Makes the taps wait again after the send that took them failed.
    pub(crate) fn put_taps_back(&self, taps: &[Tapped]) -> Result<(), StoreError> {
        self.with(|db| set_announced(db, taps, 0))
    }
}

fn unannounced(db: &Connection, chat: ChatId) -> rusqlite::Result<Vec<Tapped>> {
    let mut query = db.prepare(
        "SELECT p.id, p.user_id, o.title FROM share_proposals p JOIN objectives o ON o.id = p.objective_id
         WHERE p.chat_id = ?1 AND p.state = 'applied' AND p.announced = 0 ORDER BY p.applied_at, p.id",
    )?;
    let taps = query
        .query_map([chat.0], |row| {
            Ok((
                ProposalId(row.get(0)?),
                UserId(row.get(1)?),
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut told = taps
        .into_iter()
        .map(|(id, owner, title)| {
            let card = card(db, owner, id)?.expect("a proposal of its own owner exists");
            let people = card.people.into_iter().filter(|person| person.ticked).map(|person| person.name);
            let teams = card
                .teams
                .into_iter()
                .filter(|team| team.ticked)
                .map(|team| format!("the {} team", team.name));
            let names: Vec<_> = people.chain(teams).collect();
            let who = match names.as_slice() {
                [] => "nobody".to_owned(),
                names => names.join(" and "),
            };
            Ok(Tapped {
                id: TapId::Share(id),
                notice: format!(
                    "[The user tapped Share on the card for \"{title}\": it is now shared with {who}.]"
                ),
            })
        })
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut pane = db.prepare(
        "SELECT id, line FROM pane_taps WHERE chat_id = ?1 AND announced = 0 ORDER BY at, id",
    )?;
    let lines = pane.query_map([chat.0], |row| {
        Ok(Tapped {
            id: TapId::Pane(row.get(0)?),
            notice: row.get(1)?,
        })
    })?;
    for line in lines {
        told.push(line?);
    }
    Ok(told)
}

fn set_announced(db: &Connection, taps: &[Tapped], announced: i64) -> rusqlite::Result<()> {
    for tap in taps {
        let (table, id) = match tap.id {
            TapId::Share(id) => ("share_proposals", id.0),
            TapId::Pane(id) => ("pane_taps", id),
        };
        db.execute(
            &format!("UPDATE {table} SET announced = ?2 WHERE id = ?1"),
            params![id, announced],
        )?;
    }
    Ok(())
}

fn owns(db: &Connection, owner: UserId, objective: ObjectiveId) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT count(*) FROM objectives WHERE id = ?1 AND user_id = ?2",
        params![objective.0, owner.0],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count == 1)
}

fn public_notes(db: &Connection, objective: ObjectiveId) -> rusqlite::Result<Vec<SharedNote>> {
    db.prepare(
        "SELECT at, status, moved, blockers, new_dates FROM objective_notes
         WHERE objective_id = ?1 AND is_private = 0 ORDER BY id",
    )?
    .query_map([objective.0], |row| {
        Ok(SharedNote {
            at: row.get::<_, i64>(0)?.unsigned_abs(),
            status: row.get(1)?,
            moved: row.get(2)?,
            blockers: row.get(3)?,
            new_dates: row.get(4)?,
        })
    })?
    .collect()
}

fn member_names(db: &Connection, team: i64) -> rusqlite::Result<Vec<String>> {
    db.prepare(
        "SELECT u.display_name FROM team_members m JOIN users u ON u.id = m.user_id
         WHERE m.team_id = ?1 ORDER BY u.id",
    )?
    .query_map([team], |row| row.get(0))?
    .collect()
}

fn card(db: &Connection, owner: UserId, id: ProposalId) -> rusqlite::Result<Option<ShareCard>> {
    let head = db
        .query_row(
            "SELECT p.objective_id, o.title, p.state, p.applied_at
             FROM share_proposals p JOIN objectives o ON o.id = p.objective_id
             WHERE p.id = ?1 AND p.user_id = ?2",
            params![id.0, owner.0],
            |row| {
                Ok((
                    ObjectiveId(row.get(0)?),
                    row.get::<_, String>(1)?,
                    row.get::<_, ProposalState>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((objective_id, title, state, applied_at)) = head else {
        return Ok(None);
    };
    let people = db
        .prepare(
            "SELECT u.id, u.display_name, e.ticked FROM share_proposal_entries e JOIN users u ON u.id = e.user_id
             WHERE e.proposal_id = ?1 ORDER BY u.id",
        )?
        .query_map([id.0], |row| {
            Ok(CardPerson {
                id: UserId(row.get(0)?),
                name: row.get(1)?,
                ticked: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let teams = db
        .prepare(
            "SELECT t.id, t.name, e.ticked FROM share_proposal_entries e JOIN teams t ON t.id = e.team_id
             WHERE e.proposal_id = ?1 ORDER BY t.id",
        )?
        .query_map([id.0], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, bool>(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|(id, name, ticked)| {
            Ok(CardTeam {
                id,
                members: member_names(db, id)?,
                name,
                ticked,
            })
        })
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(ShareCard {
        id,
        objective_id,
        title,
        state,
        people,
        teams,
        applied_at: applied_at.map(i64::unsigned_abs),
    }))
}
