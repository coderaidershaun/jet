//! Each user's settings, and the server-wide settings that only an admin reads or writes.

use super::{Store, StoreError, UserId, from_json, to_json};
use crate::settings::{ProgramPaths, Settings};
use rusqlite::{OptionalExtension, params};
use std::path::PathBuf;

impl Store {
    /// The user's settings; the defaults before anything was saved.
    pub(crate) fn settings(&self, user: UserId) -> Result<Settings, StoreError> {
        let text: Option<String> = self.with(|db| {
            db.query_row(
                "SELECT settings FROM settings WHERE user_id = ?1",
                [user.0],
                |row| row.get(0),
            )
            .optional()
        })?;
        text.map_or_else(
            || Ok(Settings::default()),
            |text| from_json("settings", &text),
        )
    }

    pub(crate) fn set_settings(&self, user: UserId, settings: &Settings) -> Result<(), StoreError> {
        let text = to_json(settings)?;
        self.with(|db| {
            db.execute(
                "INSERT INTO settings (user_id, settings) VALUES (?1, ?2)
                 ON CONFLICT (user_id) DO UPDATE SET settings = excluded.settings",
                params![user.0, text],
            )
            .map(drop)
        })
    }

    /// Where the provider programs are; `None` for each one not set.
    pub(crate) fn program_paths(&self) -> Result<ProgramPaths, StoreError> {
        let saved = self.with(|db| {
            db.query_row(
                "SELECT claude_path, codex_path, agy_path FROM server_settings WHERE id = 1",
                [],
                |row| {
                    Ok(ProgramPaths {
                        claude_path: row.get::<_, Option<String>>(0)?.map(PathBuf::from),
                        codex_path: row.get::<_, Option<String>>(1)?.map(PathBuf::from),
                        agy_path: row.get::<_, Option<String>>(2)?.map(PathBuf::from),
                    })
                },
            )
            .optional()
        })?;
        Ok(saved.unwrap_or_default())
    }

    pub(crate) fn set_program_paths(&self, paths: &ProgramPaths) -> Result<(), StoreError> {
        let text = |path: &Option<PathBuf>| {
            path.as_ref()
                .map(|path| path.to_string_lossy().into_owned())
        };
        self.with(|db| {
            db.execute(
                "INSERT INTO server_settings (id, claude_path, codex_path, agy_path)
                 VALUES (1, ?1, ?2, ?3)
                 ON CONFLICT (id) DO UPDATE SET
                     claude_path = excluded.claude_path, codex_path = excluded.codex_path,
                     agy_path = excluded.agy_path",
                params![
                    text(&paths.claude_path),
                    text(&paths.codex_path),
                    text(&paths.agy_path)
                ],
            )
            .map(drop)
        })
    }
}
