//! Turns the promises that the notes review found in Jet's own lines into follow-ups, so that a
//! promise to come back to something is never lost with the reply that made it.

use std::collections::HashSet;
use std::sync::Arc;

use agent::Promise;
use jiff::{Timestamp, civil, tz::TimeZone};

use super::{ChatState, Chats};
use crate::store::{ChatId, NewTask, SetBy, TaskKind, TaskState, UserId};

/// A promise with no usable time is due this long after it was said.
const DEFAULT_WAIT_SECONDS: u64 = 24 * 60 * 60;

impl Chats {
    /// The user's local date, weekday and time zone at `now_ms`, for the review's prompt.
    pub(super) fn local_now(&self, user: UserId, now_ms: u64) -> String {
        let name = self.store.time_zone(user).ok().flatten();
        let (zone_name, zone) = known_zone(name.as_deref());
        let at = Timestamp::from_millisecond(i64::try_from(now_ms).unwrap_or(0))
            .unwrap_or(Timestamp::UNIX_EPOCH);
        let shown = zone.to_datetime(at).strftime("%A %Y-%m-%d %H:%M");
        match name {
            Some(_) => format!("{shown}, time zone {zone_name}"),
            None => format!("{shown} UTC, the user's time zone is not known"),
        }
    }

    /// Sets one follow-up for each promise, in the chat where Jet made it, unless an open
    /// follow-up or check of that chat already covers it. Tells the pane when any was added.
    pub(super) fn schedule_promises(
        &self,
        user: UserId,
        chats: &[(String, Arc<ChatState>)],
        promises: &[Promise],
        now_ms: u64,
    ) {
        if promises.is_empty() {
            return;
        }
        let tasks = match self.store.agent_tasks(user) {
            Ok(tasks) => tasks,
            Err(error) => {
                return eprintln!("jet: could not read the tasks to match promises: {error}");
            }
        };
        let mut covered: HashSet<ChatId> = tasks
            .iter()
            .filter(|task| matches!(task.state, TaskState::Scheduled | TaskState::Running))
            // A colleague's message waiting to be brought up says nothing of what Jet promised.
            .filter(|task| matches!(self.store.item_of_task(task.id), Ok(None)))
            .map(|task| task.chat_id)
            .collect();
        let zone = self.store.time_zone(user).ok().flatten();
        let mut added = false;
        for promise in promises {
            let chat = chats[promise.chat].1.chat.id;
            if covered.contains(&chat) {
                continue;
            }
            let due = Due::of(promise, zone.as_deref(), now_ms);
            let task = NewTask {
                kind: TaskKind::FollowUp,
                why: &promise.words,
                due_at: due.at,
                local_time: &due.local_time,
                time_zone: &due.zone,
                set_by: SetBy::Review,
            };
            match self.store.add_follow_up(user, chat, &task, now_ms / 1000) {
                Ok(_) => {
                    covered.insert(chat);
                    added = true;
                }
                Err(error) => eprintln!("jet: could not set a follow-up for a promise: {error}"),
            }
        }
        if added {
            self.signals.changed();
            self.pane_changed(user);
        }
    }
}

struct Due {
    at: u64,
    local_time: String,
    zone: String,
}

impl Due {
    /// The time Jet named, in the user's zone, when it is a real time still ahead; otherwise a
    /// day after the promise was said.
    fn of(promise: &Promise, zone_name: Option<&str>, now_ms: u64) -> Self {
        let (zone, tz) = known_zone(zone_name);
        let named = zone_name
            .and(promise.at.as_deref())
            .and_then(|at| civil::DateTime::strptime("%Y-%m-%dT%H:%M", at).ok())
            .and_then(|local| tz.to_ambiguous_timestamp(local).earlier().ok())
            .and_then(|instant| u64::try_from(instant.as_second()).ok())
            .filter(|at| *at > now_ms / 1000);
        let at = named.unwrap_or(promise.said_at / 1000 + DEFAULT_WAIT_SECONDS);
        let instant =
            Timestamp::from_second(i64::try_from(at).unwrap_or(0)).unwrap_or(Timestamp::UNIX_EPOCH);
        Self {
            at,
            local_time: tz
                .to_datetime(instant)
                .strftime("%Y-%m-%dT%H:%M")
                .to_string(),
            zone,
        }
    }
}

/// The zone of that name, or UTC when there is none or the server does not know it.
fn known_zone(name: Option<&str>) -> (String, TimeZone) {
    name.and_then(|name| Some((name.to_owned(), TimeZone::get(name).ok()?)))
        .unwrap_or_else(|| ("UTC".to_owned(), TimeZone::UTC))
}
