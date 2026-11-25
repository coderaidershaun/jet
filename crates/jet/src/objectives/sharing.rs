//! Sharing an objective with colleagues: the read a colleague gets, the share card Jet proposes,
//! the owner's tap that applies it, and an admin's changes to the people and teams.

use super::{ObjectiveError, Objectives, TEAM_NAME_LIMIT, UTC, time};
use crate::chat::TurnOwner;
use crate::store::{
    Applied, CardPerson, CardTeam, ObjectiveId, Person, ProposalId, ShareCard, Shared, Sharing,
    Tap, Team, UserId,
};
use serde::{Deserialize, Serialize};

/// What a colleague reads of an objective shared with them.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SharedView {
    #[serde(flatten)]
    pub(super) shared: Shared,
    /// Days from the start date to the due date.
    duration_days: i64,
    /// Days from today, in the owner's zone, to the due date; negative once it has passed.
    pub(super) days_left: i64,
}

/// Everyone the owner could share an objective with, ticked when it is shared with them now.
#[derive(Debug, Serialize)]
pub(crate) struct Directory {
    people: Vec<CardPerson>,
    teams: Vec<CardTeam>,
}

/// One change to the organisation's directory, made by an admin.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum DirectoryChange {
    TeamAdd { name: String },
    TeamRename { team: i64, name: String },
    MemberAdd { team: i64, user: i64 },
    MemberRemove { team: i64, user: i64 },
    ManagerSet { user: i64, manager: i64 },
    ManagerClear { user: i64 },
}

impl Objectives {
    /// The objectives of `owner` that are shared with `viewer`. It is empty when nothing is
    /// shared, the same as for an owner who has none, so it says nothing about what exists.
    pub(crate) fn shared_with(
        &self,
        viewer: UserId,
        owner: UserId,
    ) -> Result<Vec<SharedView>, ObjectiveError> {
        let zone = match self.store.time_zone(owner)? {
            Some(name) => time::zone(&name)?,
            None => time::zone(UTC)?,
        };
        let today = time::today(&zone, self.now());
        self.store
            .shared_objectives(viewer, owner)?
            .into_iter()
            .map(|shared| {
                let (start, due) = (time::date(&shared.start)?, time::date(&shared.due)?);
                Ok(SharedView {
                    duration_days: time::days_between(start, due),
                    days_left: time::days_between(today, due),
                    shared,
                })
            })
            .collect()
    }

    /// Makes a share card for the owner's objective. Nothing is shared until the owner taps it.
    /// `people` and `teams` are the whole set the objective should be shared with.
    pub(crate) fn propose_share(
        &self,
        owner: TurnOwner,
        objective: ObjectiveId,
        people: &[UserId],
        teams: &[i64],
    ) -> Result<ShareCard, ObjectiveError> {
        let (known_people, known_teams) = self.store.directory()?;
        for person in people {
            if *person == owner.user {
                return Err(ObjectiveError::ShareWithOwner);
            }
            if !known_people.iter().any(|known| known.id == *person) {
                return Err(ObjectiveError::NoSuchUser { id: person.0 });
            }
        }
        for team in teams {
            if !known_teams.iter().any(|known| known.id == *team) {
                return Err(ObjectiveError::NoSuchTeam { id: *team });
            }
        }
        let now = self.sharing(owner.user, objective)?;
        if people.is_empty() && teams.is_empty() && now.people.is_empty() && now.teams.is_empty() {
            return Err(ObjectiveError::NothingToShare);
        }
        let id = self
            .write(|| {
                self.store.add_share_proposal(
                    owner.user,
                    owner.chat,
                    objective,
                    (people, teams),
                    self.now(),
                )
            })?
            .ok_or(ObjectiveError::NoSuchObjective { id: objective.0 })?;
        self.card(owner.user, id)
    }

    /// The same card from the objective's own pane, which belongs to the objective's chat.
    pub(crate) fn propose_share_from_pane(
        &self,
        user: UserId,
        objective: ObjectiveId,
        people: &[UserId],
        teams: &[i64],
    ) -> Result<ShareCard, ObjectiveError> {
        let chat = self
            .store
            .objective(user, objective)?
            .ok_or(ObjectiveError::NoSuchObjective { id: objective.0 })?
            .chat_id;
        self.propose_share(TurnOwner { user, chat }, objective, people, teams)
    }

    /// The owner's tap: the objective is shared with the ticked people and teams, and nobody else.
    pub(crate) fn apply_share(
        &self,
        owner: UserId,
        id: ProposalId,
        people: &[UserId],
        teams: &[i64],
    ) -> Result<ShareCard, ObjectiveError> {
        let applied = self.write(|| {
            self.store
                .apply_share_proposal(owner, id, (people, teams), self.now())
        })?;
        match applied {
            Applied::Done => self.card(owner, id),
            Applied::Missing => Err(ObjectiveError::NoSuchProposal { id: id.0 }),
            Applied::NotOpen(state) => Err(ObjectiveError::ProposalNotOpen {
                id: id.0,
                state: state.as_str(),
            }),
            Applied::NotOnCard => Err(ObjectiveError::NotOnCard),
        }
    }

    /// The owner's cards with these ids, as they are now. Others' cards are left out.
    pub(crate) fn share_cards(
        &self,
        owner: UserId,
        ids: &[ProposalId],
    ) -> Result<Vec<ShareCard>, ObjectiveError> {
        Ok(self.store.share_cards(owner, ids)?)
    }

    /// Who the owner's objective is shared with now.
    pub(crate) fn sharing(
        &self,
        owner: UserId,
        objective: ObjectiveId,
    ) -> Result<Sharing, ObjectiveError> {
        self.store
            .sharing(owner, objective)?
            .ok_or(ObjectiveError::NoSuchObjective { id: objective.0 })
    }

    /// The people and teams of the organisation for the owner's share card, the owner left out.
    /// Another user's objective answers as one that does not exist.
    pub(crate) fn directory(
        &self,
        owner: UserId,
        objective: ObjectiveId,
    ) -> Result<Directory, ObjectiveError> {
        let shared = self.sharing(owner, objective)?;
        let (people, teams) = self.store.directory()?;
        let name_of = |id: UserId| {
            people
                .iter()
                .find(|person| person.id == id)
                .map_or_else(String::new, |person| person.name.clone())
        };
        let teams = teams
            .iter()
            .map(|team| CardTeam {
                id: team.id,
                name: team.name.clone(),
                members: team.member_ids.iter().map(|id| name_of(*id)).collect(),
                ticked: shared.teams.iter().any(|shared| shared.id == team.id),
            })
            .collect();
        let people = people
            .iter()
            .filter(|person| person.id != owner)
            .map(|person| CardPerson {
                id: person.id,
                name: person.name.clone(),
                ticked: shared.people.iter().any(|shared| shared.id == person.id),
            })
            .collect();
        Ok(Directory { people, teams })
    }

    /// Marks one of the owner's notes private or shared.
    pub(crate) fn set_note_private(
        &self,
        owner: UserId,
        objective: ObjectiveId,
        note: i64,
        is_private: bool,
        tap: Tap,
    ) -> Result<(), ObjectiveError> {
        self.write(|| {
            self.store
                .set_note_private(owner, objective, note, is_private, (self.now(), tap))
        })?
        .ok_or(ObjectiveError::NoSuchNote { id: note })
    }

    /// Makes one change to the people and teams of the organisation, for an admin only, and gives
    /// the directory as it is after.
    pub(crate) fn change_directory(
        &self,
        admin: UserId,
        change: DirectoryChange,
    ) -> Result<(Vec<Person>, Vec<Team>), ObjectiveError> {
        if !self.store.user(admin)?.is_some_and(|user| user.is_admin) {
            return Err(ObjectiveError::NotAdmin);
        }
        let (people, teams) = self.store.directory()?;
        let user = |id: i64| {
            people
                .iter()
                .any(|person| person.id.0 == id)
                .then_some(UserId(id))
                .ok_or(ObjectiveError::NoSuchUser { id })
        };
        let team = |id: i64| {
            teams
                .iter()
                .any(|team| team.id == id)
                .then_some(id)
                .ok_or(ObjectiveError::NoSuchTeam { id })
        };
        match change {
            DirectoryChange::TeamAdd { name } => {
                let name = team_name(&name)?;
                self.store
                    .add_team(&name)?
                    .ok_or(ObjectiveError::TeamNameTaken { name })?;
            }
            DirectoryChange::TeamRename { team: id, name } => {
                let (id, name) = (team(id)?, team_name(&name)?);
                if !self.store.rename_team(id, &name)? {
                    return Err(ObjectiveError::TeamNameTaken { name });
                }
            }
            DirectoryChange::MemberAdd {
                team: id,
                user: member,
            } => {
                self.store.add_member(team(id)?, user(member)?)?;
            }
            DirectoryChange::MemberRemove {
                team: id,
                user: member,
            } => {
                self.store.remove_member(team(id)?, user(member)?)?;
            }
            DirectoryChange::ManagerSet {
                user: report,
                manager,
            } => {
                if report == manager {
                    return Err(ObjectiveError::ManagesSelf);
                }
                self.store
                    .change_manager(user(report)?, Some(user(manager)?))?;
            }
            DirectoryChange::ManagerClear { user: report } => {
                self.store.change_manager(user(report)?, None)?;
            }
        }
        Ok(self.store.directory()?)
    }

    fn card(&self, owner: UserId, id: ProposalId) -> Result<ShareCard, ObjectiveError> {
        self.store
            .share_cards(owner, &[id])?
            .pop()
            .ok_or(ObjectiveError::NoSuchProposal { id: id.0 })
    }
}

fn team_name(name: &str) -> Result<String, ObjectiveError> {
    let name = name.trim();
    match (1..=TEAM_NAME_LIMIT).contains(&name.chars().count()) {
        true => Ok(name.to_owned()),
        false => Err(ObjectiveError::BadTeamName),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::objectives::{Check, Create, Update};
    use crate::store::{Email, NewSource, NewStep, NoteStatus, SourceKind, test_store};
    use serde_json::{Value, json};
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };

    // 2026-01-01 00:00 UTC.
    const START: u64 = 1_767_225_600;

    struct World {
        _dir: tempfile::TempDir,
        objectives: Objectives,
        ada: TurnOwner,
        bob: UserId,
        cat: UserId,
        team: i64,
    }

    /// Ada owns an objective that has a private note, a source and a check. Bob and Cat are the
    /// others, and Cat is in a team.
    fn world() -> (World, ObjectiveId) {
        let (dir, store, ada, bob) = test_store();
        let cat = store
            .add_user(&crate::store::NewUser {
                email: &Email::from("cat@example.com"),
                display_name: "Cat",
                password_hash: "not a real hash",
                is_admin: false,
            })
            .unwrap();
        store.add_team_member("Commercial", cat).unwrap();
        let team = store.directory().unwrap().1[0].id;
        let ticking = Arc::new(AtomicU64::new(START));
        let objectives = Objectives::new(
            store.clone(),
            Arc::new(move || ticking.fetch_add(1, Ordering::SeqCst)),
        );
        let ada = TurnOwner {
            user: ada,
            chat: store.main_chat(ada).unwrap().id,
        };
        let created = objectives
            .create(
                ada,
                Create {
                    title: "Ship the kite".into(),
                    deliverable: "A kite that flies".into(),
                    start: Some("2026-02-01".into()),
                    due: "2026-03-01".into(),
                    steps: vec![NewStep {
                        title: "Build the frame".into(),
                        due: None,
                    }],
                    sources: vec![NewSource {
                        kind: SourceKind::Github,
                        target: "secret/repo".into(),
                        detail: "ada-login".into(),
                    }],
                    first_check: Check {
                        at: "2026-02-10T09:00".into(),
                        why: "private check reason".into(),
                    },
                },
            )
            .unwrap();
        let id = created.objective.id;
        for (moved, is_private) in [
            ("frame is half built", false),
            ("I doubt this will work", true),
        ] {
            objectives
                .note(
                    ada.user,
                    id,
                    Update {
                        status: NoteStatus::AtRisk,
                        moved: moved.into(),
                        blockers: String::new(),
                        is_private,
                    },
                )
                .unwrap();
        }
        (
            World {
                _dir: dir,
                objectives,
                ada,
                bob,
                cat,
                team,
            },
            id,
        )
    }

    fn share(world: &World, id: ObjectiveId, people: &[UserId], teams: &[i64]) -> ShareCard {
        let card = world
            .objectives
            .propose_share(world.ada, id, people, teams)
            .unwrap();
        world
            .objectives
            .apply_share(world.ada.user, card.id, people, teams)
            .unwrap()
    }

    #[test]
    fn shared_reads_never_return_private_notes_chats_or_unshared_objectives() {
        let (world, id) = world();
        let (ada, bob, cat) = (world.ada.user, world.bob, world.cat);
        let read = |viewer| json!(world.objectives.shared_with(viewer, ada).unwrap());
        let nothing_there = json!(world.objectives.shared_with(bob, cat).unwrap());
        assert_eq!(nothing_there, json!([]));
        let unknown = json!(world.objectives.shared_with(bob, UserId(9_999)).unwrap());
        assert_eq!(unknown, nothing_there, "an unknown owner is not an error");

        // Before any tap nothing is shared, and the answer is that of an owner with no objectives.
        assert_eq!(read(bob), nothing_there);

        share(&world, id, &[bob], &[]);
        let seen = read(bob);
        let objective = &seen[0];
        let mut keys: Vec<&String> = objective.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "daysLeft",
                "deliverable",
                "due",
                "durationDays",
                "id",
                "notes",
                "start",
                "status",
                "steps",
                "title"
            ]
        );
        assert_eq!(objective["durationDays"], 28);
        let notes: Vec<&str> = objective["notes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|note| note["moved"].as_str().unwrap())
            .collect();
        assert_eq!(notes, ["frame is half built"]);
        for secret in [
            "doubt",
            "secret/repo",
            "ada-login",
            "private check reason",
            "chatId",
            "isPrivate",
            "entryId",
            "tasks",
            "sources",
        ] {
            assert!(
                !seen.to_string().contains(secret),
                "{secret} leaked: {seen}"
            );
        }

        // A viewer it is not shared with, and the owner's own team-less reads, see nothing.
        assert_eq!(read(cat), nothing_there);

        // Sharing with a team reaches its members, and a note written later is read at once.
        share(&world, id, &[], &[world.team]);
        assert_eq!(read(bob), nothing_there);
        assert_eq!(read(cat)[0]["title"], "Ship the kite");
        world
            .objectives
            .note(
                ada,
                id,
                Update {
                    status: NoteStatus::OnTrack,
                    moved: "flying tomorrow".into(),
                    blockers: String::new(),
                    is_private: false,
                },
            )
            .unwrap();
        assert_eq!(read(cat)[0]["notes"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn the_share_card_payload_is_the_fixture() {
        let (world, id) = world();
        let (bob, team) = (world.bob, world.team);
        let proposed = world
            .objectives
            .propose_share(world.ada, id, &[bob], &[team])
            .unwrap();
        let applied = world
            .objectives
            .apply_share(world.ada.user, proposed.id, &[bob], &[])
            .unwrap();
        let replaced = world
            .objectives
            .propose_share(world.ada, id, &[bob], &[])
            .unwrap();
        let superseded = world
            .objectives
            .propose_share(world.ada, id, &[], &[team])
            .unwrap();
        // `replaced` was still waiting, so the newer card refused it.
        let refused = world
            .objectives
            .share_cards(world.ada.user, &[replaced.id])
            .unwrap();
        let directory = world.objectives.directory(world.ada.user, id).unwrap();
        let cards = json!({
            "proposed": json!(superseded),
            "applied": json!(applied),
            "refused": json!(refused[0]),
            "directory": json!(directory),
        });
        if std::env::var_os("WRITE_FIXTURE").is_some() {
            let path = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/share-card.json"
            );
            std::fs::write(path, serde_json::to_string_pretty(&cards).unwrap() + "\n").unwrap();
        }
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/share-card.json")).unwrap();
        assert_eq!(cards, fixture, "{cards:#}");
    }

    #[test]
    fn the_owner_only_applies_what_is_on_their_own_waiting_card() {
        let (world, id) = world();
        let (bob, cat) = (world.bob, world.cat);
        let card = world
            .objectives
            .propose_share(world.ada, id, &[bob], &[])
            .unwrap();
        let err = |result: Result<ShareCard, ObjectiveError>| result.unwrap_err().kind();
        assert_eq!(
            err(world.objectives.apply_share(bob, card.id, &[bob], &[])),
            "noSuchProposal"
        );
        assert_eq!(
            err(world
                .objectives
                .apply_share(world.ada.user, card.id, &[cat], &[])),
            "notOnCard"
        );
        assert!(
            world
                .objectives
                .shared_with(bob, world.ada.user)
                .unwrap()
                .is_empty()
        );
        world
            .objectives
            .apply_share(world.ada.user, card.id, &[bob], &[])
            .unwrap();
        assert_eq!(
            err(world
                .objectives
                .apply_share(world.ada.user, card.id, &[bob], &[])),
            "proposalNotOpen"
        );
    }
}
