//! The bridge between the chat page and the agent crate: the commands the page calls, the
//! channel that streams a reply to it, and the timer that keeps Jet's notes current.

mod error;
mod review_timer;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use agent::{
    CacheStatus, ClaudeCli, Conversation, DataDir, Effort, Event, Lines, MEMORY_LIMIT, McpServers,
    Message, Model, Notes, Persona, RECENT_LIMIT, Request, ShownEntry, Stopper, Tone, Transport,
    TransportError, USER_LIMIT,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::settings;
use error::BridgeError;
use review_timer::{ReviewTarget, ReviewTimer, review_now};

/// Entries the page gets when it opens.
const HISTORY_LIMIT: usize = 200;

/// How long closing the app waits for a stopped reply to be saved.
const EXIT_WAIT: Duration = Duration::from_secs(2);

/// Links the page may ask to open.
const OPENABLE_SCHEMES: [&str; 3] = ["http://", "https://", "mailto:"];

/// What the commands share: the conversation, the reply that is running, and the review timer.
pub struct ChatState {
    conversation: Conversation,
    data_dir: PathBuf,
    active: Mutex<Option<Stopper>>,
    review: ReviewTimer,
}

impl ChatState {
    pub fn new(data_dir: PathBuf) -> ChatState {
        ChatState {
            conversation: Conversation::new(DataDir::new(data_dir.clone())),
            data_dir,
            active: Mutex::new(None),
            review: ReviewTimer::new(),
        }
    }

    /// Called when the app closes: ends the running reply, then reads what was said since
    /// the last review so the notes are up to date next time.
    // SMELL: closing waits for that review, so a slow Claude keeps the app from quitting
    // until the review ends.
    pub fn shutdown(&self, app: &AppHandle) {
        if let Some(stopper) = lock(&self.active).as_ref() {
            stopper.stop();
        }
        let deadline = Instant::now() + EXIT_WAIT;
        while self.conversation.is_busy() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        match self.exit_review_target(app) {
            Ok(target) => review_now(&self.conversation, &target),
            Err(error) => eprintln!("jet: the notes review at exit could not start: {error}"),
        }
    }

    /// The review at exit follows the saved settings, because no reply may have run since
    /// the app started.
    fn exit_review_target(&self, app: &AppHandle) -> Result<ReviewTarget, BridgeError> {
        let settings = settings::read_from(&settings::settings_path(app)?)?;
        Ok(ReviewTarget {
            transport: transport_for(settings.claude_path.as_deref(), &self.data_dir)?,
            name: settings.persona.name,
        })
    }
}

/// A lock that still opens after another thread panicked while holding it.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Stands in for Claude Code when it cannot be found, so the failure reaches the page the
/// same way as every other one.
struct MissingClaude {
    searched: Vec<String>,
}

impl Transport for MissingClaude {
    fn start(&self, _request: &Request) -> Result<Lines, TransportError> {
        Err(TransportError::ClaudeMissing {
            searched: self.searched.clone(),
        })
    }
}

fn transport_for(
    configured: Option<&Path>,
    data_dir: &Path,
) -> Result<Arc<dyn Transport>, BridgeError> {
    match ClaudeCli::locate(configured, data_dir) {
        Ok(claude) => Ok(Arc::new(claude)),
        Err(TransportError::ClaudeMissing { searched }) => Ok(Arc::new(MissingClaude { searched })),
        Err(other) => Err(other.into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    claude: ClaudeStatus,
    data_dir: String,
    busy: bool,
    cache: CacheStatus,
}

#[derive(Serialize)]
struct ClaudeStatus {
    found: bool,
    path: Option<String>,
    searched: Vec<String>,
}

/// Where Claude Code is, whether a reply is running, and whether the prompt cache is warm.
#[tauri::command]
pub async fn agent_status(
    app: AppHandle,
    state: State<'_, ChatState>,
) -> Result<AgentStatus, BridgeError> {
    let configured = settings::read_from(&settings::settings_path(&app)?)?.claude_path;
    let claude = match ClaudeCli::locate(configured.as_deref(), &state.data_dir) {
        Ok(claude) => ClaudeStatus {
            found: true,
            path: Some(claude.program().display().to_string()),
            searched: Vec::new(),
        },
        Err(TransportError::ClaudeMissing { searched }) => ClaudeStatus {
            found: false,
            path: None,
            searched,
        },
        Err(other) => return Err(other.into()),
    };
    Ok(AgentStatus {
        claude,
        data_dir: state.data_dir.display().to_string(),
        busy: state.conversation.is_busy(),
        cache: state.conversation.cache_status()?,
    })
}

#[tauri::command]
pub fn load_history(state: State<'_, ChatState>) -> Result<Vec<ShownEntry>, BridgeError> {
    Ok(state.conversation.history(HISTORY_LIMIT)?)
}

/// What the page sends with each message.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    text: String,
    #[serde(default)]
    model: Model,
    #[serde(default)]
    effort: Effort,
    budget_usd: f64,
    persona: Persona,
    behaviour: Tone,
    local_time: String,
    #[serde(default)]
    claude_path: Option<PathBuf>,
    #[serde(default)]
    mcp: McpServers,
}

/// Saves the user's message, starts the answer on its own thread and returns the saved
/// message at once. The answer streams over `events`.
#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    state: State<'_, ChatState>,
    request: SendRequest,
    events: Channel<Event>,
) -> Result<ShownEntry, BridgeError> {
    let transport = transport_for(request.claude_path.as_deref(), &state.data_dir)?;
    let target = ReviewTarget {
        transport: Arc::clone(&transport),
        name: request.persona.name.clone(),
    };
    let message = Message {
        text: request.text,
        persona: request.persona,
        tone: request.behaviour,
        model: request.model,
        effort: request.effort,
        budget_usd: request.budget_usd,
        local_time: request.local_time,
        mcp: request.mcp,
    };
    let (user_entry, mut reply) = state.conversation.send(transport, message)?;
    state.review.note_activity();
    *lock(&state.active) = Some(reply.stopper());

    std::thread::spawn(move || {
        // The page may be gone while the answer is still coming in; keep going so that the
        // answer is still saved.
        for event in reply.by_ref() {
            events.send(event).ok();
        }
        let state = app.state::<ChatState>();
        *lock(&state.active) = None;
        drop(reply);
        state
            .review
            .schedule(app.clone(), state.conversation.clone(), target);
    });
    Ok(user_entry)
}

/// Ends the running reply. The text so far is kept.
#[tauri::command]
pub fn stop_reply(state: State<'_, ChatState>) {
    if let Some(stopper) = lock(&state.active).as_ref() {
        stopper.stop();
    }
}

#[tauri::command]
pub fn forget_conversation(state: State<'_, ChatState>) -> Result<(), BridgeError> {
    Ok(state.conversation.forget()?)
}

#[derive(Serialize)]
pub struct MemoryView {
    memory: String,
    user: String,
    recent: String,
    limits: MemoryLimits,
}

#[derive(Serialize)]
struct MemoryLimits {
    memory: usize,
    user: usize,
    recent: usize,
}

#[tauri::command]
pub fn load_memory(state: State<'_, ChatState>) -> Result<MemoryView, BridgeError> {
    let Notes {
        memory,
        user,
        recent,
    } = state.conversation.notes()?;
    Ok(MemoryView {
        memory,
        user,
        recent,
        limits: MemoryLimits {
            memory: MEMORY_LIMIT,
            user: USER_LIMIT,
            recent: RECENT_LIMIT,
        },
    })
}

/// Saves notes the user edited and returns them as saved (cut to their limits).
#[tauri::command]
pub fn save_memory(state: State<'_, ChatState>, notes: Notes) -> Result<Notes, BridgeError> {
    Ok(state.conversation.save_notes(notes)?)
}

#[tauri::command]
pub fn render_markdown(text: &str) -> String {
    agent::render_markdown(text)
}

/// Opens a web or mail link in the user's own browser or mail app.
#[tauri::command]
pub fn open_link(app: AppHandle, url: &str) -> Result<(), BridgeError> {
    let lowered = url.trim().to_ascii_lowercase();
    if !OPENABLE_SCHEMES
        .iter()
        .any(|scheme| lowered.starts_with(scheme))
    {
        return Err(BridgeError::BadLink(format!(
            "only web and mail links can be opened, not {url}"
        )));
    }
    app.opener()
        .open_url(url.trim(), None::<&str>)
        .map_err(|error| BridgeError::Io(error.to_string()))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use agent::Mood;

    #[test]
    fn every_mood_word_is_handled_by_the_director() {
        let director = include_str!("../../ui/jet/director.js");
        let mood_lines: Vec<&str> = director
            .lines()
            .filter(|line| line.starts_with("export const MOODS = ["))
            .collect();
        assert_eq!(
            mood_lines.len(),
            1,
            "director.js must have exactly one `export const MOODS = [` line, found {}",
            mood_lines.len()
        );
        let inside_brackets = mood_lines[0]
            .split_once('[')
            .and_then(|(_, rest)| rest.split_once(']'))
            .map(|(words, _)| words)
            .expect("the MOODS line has no closing bracket");
        let director_words: BTreeSet<&str> =
            inside_brackets.split('\'').skip(1).step_by(2).collect();
        let agent_words: BTreeSet<&str> = Mood::ALL.iter().map(|mood| mood.word()).collect();

        let missing_from_director: Vec<&str> =
            agent_words.difference(&director_words).copied().collect();
        let missing_from_agent: Vec<&str> =
            director_words.difference(&agent_words).copied().collect();
        assert!(
            missing_from_director.is_empty() && missing_from_agent.is_empty(),
            "mood words differ. Missing from MOODS in director.js: {missing_from_director:?}. \
             Missing from agent::Mood: {missing_from_agent:?}"
        );
    }
}
