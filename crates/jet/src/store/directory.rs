//! Users, teams, team members and each user's manager.

use super::{Store, StoreError};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub(crate) struct UserId(pub(crate) i64);

/// An email address in the one form it is stored and looked up in, so that letter case never
/// makes two accounts.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub(crate) struct Email(String);

impl From<&str> for Email {
    fn from(text: &str) -> Self {
        Self(text.trim().to_lowercase())
    }
}

impl Email {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct User {
    pub(crate) id: UserId,
    pub(crate) email: Email,
    pub(crate) display_name: String,
    pub(crate) is_admin: bool,
}

/// A user as the organisation's directory lists them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Person {
    pub(crate) id: UserId,
    pub(crate) email: String,
    pub(crate) name: String,
    pub(crate) manager_id: Option<UserId>,
    pub(crate) teams: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Team {
    pub(crate) id: i64,
    pub(crate) name: String,
    pub(crate) member_ids: Vec<UserId>,
}

pub(crate) struct NewUser<'a> {
    pub(crate) email: &'a Email,
    pub(crate) display_name: &'a str,
    pub(crate) password_hash: &'a str,
    pub(crate) is_admin: bool,
}

impl Store {
    pub(crate) fn user_count(&self) -> Result<u64, StoreError> {
        let count: i64 =
            self.with(|db| db.query_row("SELECT count(*) FROM users", [], |row| row.get(0)))?;
        Ok(count.unsigned_abs())
    }

    pub(crate) fn user_id(&self, email: &Email) -> Result<Option<UserId>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT id FROM users WHERE email = ?1",
                [email.as_str()],
                |row| Ok(UserId(row.get(0)?)),
            )
            .optional()
        })
    }

    pub(crate) fn user(&self, id: UserId) -> Result<Option<User>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT email, display_name, is_admin FROM users WHERE id = ?1",
                [id.0],
                |row| {
                    Ok(User {
                        id,
                        email: Email(row.get(0)?),
                        display_name: row.get(1)?,
                        is_admin: row.get(2)?,
                    })
                },
            )
            .optional()
        })
    }

    /// The stored hash of the user's password. It never leaves the sign-in check.
    pub(crate) fn password_hash(
        &self,
        email: &Email,
    ) -> Result<Option<(UserId, String)>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT id, password_hash FROM users WHERE email = ?1",
                [email.as_str()],
                |row| Ok((UserId(row.get(0)?), row.get(1)?)),
            )
            .optional()
        })
    }

    /// Adds the user with an empty main chat; nothing else is saved for them until they change it.
    pub(crate) fn add_user(&self, user: &NewUser) -> Result<UserId, StoreError> {
        self.with(|db| {
            let transaction = db.transaction()?;
            transaction.execute(
                "INSERT INTO users (email, display_name, password_hash, is_admin) VALUES (?1, ?2, ?3, ?4)",
                params![user.email.as_str(), user.display_name, user.password_hash, user.is_admin],
            )?;
            let id = transaction.last_insert_rowid();
            transaction.execute(
                "INSERT INTO chats (user_id, kind, created_at) VALUES (?1, 'main', unixepoch())",
                [id],
            )?;
            transaction.commit()?;
            Ok(UserId(id))
        })
    }

    /// Puts the user in the team, making the team if it is new. Doing it twice changes nothing.
    pub(crate) fn add_team_member(&self, team: &str, user: UserId) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute("INSERT OR IGNORE INTO teams (name) VALUES (?1)", [team])?;
            db.execute(
                "INSERT OR IGNORE INTO team_members (team_id, user_id) SELECT id, ?2 FROM teams WHERE name = ?1",
                params![team, user.0],
            )?;
            Ok(())
        })
    }

    pub(crate) fn set_manager(&self, user: UserId, manager: UserId) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute(
                "UPDATE users SET manager_id = ?2 WHERE id = ?1",
                params![user.0, manager.0],
            )?;
            Ok(())
        })
    }

    /// Makes a team. `None` when a team of that name exists.
    pub(crate) fn add_team(&self, name: &str) -> Result<Option<i64>, StoreError> {
        self.with(|db| {
            let added = db.execute("INSERT OR IGNORE INTO teams (name) VALUES (?1)", [name])?;
            Ok((added == 1).then(|| db.last_insert_rowid()))
        })
    }

    /// Renames the team. `false` when it does not exist, or another team has the name.
    pub(crate) fn rename_team(&self, team: i64, name: &str) -> Result<bool, StoreError> {
        self.with(|db| {
            Ok(db.execute(
                "UPDATE OR IGNORE teams SET name = ?2 WHERE id = ?1",
                params![team, name],
            )? == 1)
        })
    }

    pub(crate) fn add_member(&self, team: i64, user: UserId) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute(
                "INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?1, ?2)",
                params![team, user.0],
            )
            .map(drop)
        })
    }

    pub(crate) fn remove_member(&self, team: i64, user: UserId) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute(
                "DELETE FROM team_members WHERE team_id = ?1 AND user_id = ?2",
                params![team, user.0],
            )
            .map(drop)
        })
    }

    /// Sets the user's manager, or clears it with `None`.
    pub(crate) fn change_manager(
        &self,
        user: UserId,
        manager: Option<UserId>,
    ) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute(
                "UPDATE users SET manager_id = ?2 WHERE id = ?1",
                params![user.0, manager.map(|manager| manager.0)],
            )
            .map(drop)
        })
    }

    /// Every user and every team of the organisation.
    pub(crate) fn directory(&self) -> Result<(Vec<Person>, Vec<Team>), StoreError> {
        self.with(|db| {
            let mut teams: Vec<Team> = db
                .prepare("SELECT id, name FROM teams ORDER BY name")?
                .query_map([], |row| {
                    Ok(Team {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        member_ids: Vec::new(),
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            let mut people: Vec<Person> = db
                .prepare("SELECT id, email, display_name, manager_id FROM users ORDER BY id")?
                .query_map([], |row| {
                    Ok(Person {
                        id: UserId(row.get(0)?),
                        email: row.get(1)?,
                        name: row.get(2)?,
                        manager_id: row.get::<_, Option<i64>>(3)?.map(UserId),
                        teams: Vec::new(),
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            let memberships = db
                .prepare("SELECT team_id, user_id FROM team_members ORDER BY user_id")?
                .query_map([], |row| Ok((row.get::<_, i64>(0)?, UserId(row.get(1)?))))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (team_id, user) in memberships {
                if let Some(team) = teams.iter_mut().find(|team| team.id == team_id) {
                    team.member_ids.push(user);
                    if let Some(person) = people.iter_mut().find(|person| person.id == user) {
                        person.teams.push(team.name.clone());
                    }
                }
            }
            Ok((people, teams))
        })
    }

    /// Keeps the IANA time zone the user's page last sent.
    pub(crate) fn set_time_zone(&self, user: UserId, zone: &str) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute(
                "UPDATE users SET time_zone = ?2 WHERE id = ?1",
                params![user.0, zone],
            )
            .map(drop)
        })
    }

    /// The time zone of the user's page, `None` until a message carried one, or for no such user.
    pub(crate) fn time_zone(&self, user: UserId) -> Result<Option<String>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT time_zone FROM users WHERE id = ?1",
                [user.0],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
        })
    }
}
