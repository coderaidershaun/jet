//! agy takes its tool limit from files in the folder it runs in, so Jet writes every one of them
//! itself before each turn, in a folder that only this user can open and no checkout holds.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value, json};

use super::super::Request;
use crate::chat::{FACADE_TOOLS, McpConnection, TURN_HEADER};

/// agy reads agents, hooks and tool servers from this folder of the one it runs in.
const AGENTS: &str = ".agents";
/// Every name under which agy takes such a folder.
const AGY_FOLDERS: [&str; 4] = [AGENTS, ".agent", "_agents", "_agent"];
const MCP_CONFIG: &str = "mcp_config.json";
const ALLOW_PROGRAM: &str = "allow.awk";

/// The tool agy gives an agent so that it can answer in a schema.
const FINISH: &str = "finish";

/// Held while a turn's token file is written or removed. Without it, a turn that has just ended
/// could remove the file the next turn wrote.
static TOKEN_FILE: Mutex<()> = Mutex::new(());

/// The agent one request runs as. A request with a schema gets an agent of its own, because the
/// schema needs agy's `finish` tool and a chat turn must not have it.
pub(super) struct Agent {
    pub name: &'static str,
    hooks_file: &'static str,
    /// agy's own tools the agent lists.
    tools: &'static [&'static str],
    /// The only tool names the hook lets through, as agy writes them.
    pub allowed: Vec<String>,
}

impl Agent {
    pub(super) fn of(request: &Request) -> Agent {
        let mut allowed: Vec<String> = match &request.mcp {
            Some(_) => FACADE_TOOLS.map(tool_name).into(),
            None => Vec::new(),
        };
        if request.schema.is_none() {
            return Agent {
                name: "jet",
                hooks_file: "hooks.json",
                tools: &[],
                allowed,
            };
        }
        allowed.push(FINISH.to_owned());
        Agent {
            name: "jet-review",
            hooks_file: "hooks-review.json",
            tools: &[FINISH],
            allowed,
        }
    }

    /// The agent file. Its tool list, and the two switches that keep out agy's own tools, skills
    /// and rules, make the limit; the hook it names refuses the tools agy adds regardless.
    fn file(&self, request: &Request) -> String {
        format!(
            "---\nname: {name}\ndescription: Jet\ntools: [{tools}]\nmainAgent: true\n\
             subagent: false\nexcludeDefaultComponents: true\ninheritMcp: {inherit_mcp}\n\
             inheritCustomizations: false\nhooks:\n  - ../{hooks}\n---\n\n# System Prompt\n{prompt}\n",
            name = self.name,
            tools = self.tools.join(", "),
            inherit_mcp = request.mcp.is_some(),
            hooks = self.hooks_file,
            prompt = request.system_prompt,
        )
    }

    /// Asks the allow program before every tool call. agy refuses the call when the program
    /// fails, but drops the hook without a word when this file is not valid JSON, so the file is
    /// built as a JSON value and never as text.
    fn hooks(&self) -> Value {
        let command = format!(
            "awk -v allowed='{}' -f {ALLOW_PROGRAM}",
            self.allowed.join(",")
        );
        let hook = json!({"type": "command", "command": command, "timeout": 10});
        json!({format!("{}-allow", self.name): {"PreToolUse": [{"matcher": "*", "hooks": [hook]}]}})
    }
}

/// A facade tool as agy names it for the model, in the stream and for the hook.
fn tool_name(tool: &str) -> String {
    format!("mcp_jet_{tool}")
}

/// Jet's tool server for one turn. Without `eager`, agy gives the model one tool that can call
/// any server instead of these tools.
fn mcp_config(mcp: &McpConnection) -> Value {
    let eager: Map<String, Value> = FACADE_TOOLS
        .iter()
        .map(|tool| ((*tool).to_owned(), json!({"eager": true})))
        .collect();
    json!({"mcpServers": {"jet": {
        "url": mcp.url,
        "headers": {TURN_HEADER: mcp.token},
        "enabledTools": FACADE_TOOLS,
        "tools": eager,
    }}})
}

/// Why the folder cannot be used.
#[derive(Debug, thiserror::Error)]
pub enum FolderError {
    #[error("agy cannot run in {}: it lies below {}, whose {found} agy would read", folder.display(), above.display())]
    BelowCheckout {
        folder: PathBuf,
        above: PathBuf,
        found: &'static str,
    },
    #[error("agy cannot run in {}: a link or a file is in its place", folder.display())]
    NotAFolder { folder: PathBuf },
    #[error("agy cannot run in {}: it belongs to another user (user id {owner})", folder.display())]
    OtherOwner { folder: PathBuf, owner: u32 },
    #[error("agy cannot run in {}: other users can read or write it (mode {mode:o})", folder.display())]
    NotPrivate { folder: PathBuf, mode: u32 },
    #[error("could not write {}: {source}", path.display())]
    Write {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// What a prepared folder holds for the turn.
pub(super) struct Prepared {
    /// True when no turn that ended well has run with this agent file yet.
    pub prompt_changed: bool,
    /// Records the agent file once the turn has ended well.
    pub read_prompt: ReadPrompt,
    /// Removes the turn's token file when dropped.
    pub token_file: Option<TokenFile>,
}

/// Writes every file the turn needs. All of them are written again each time, so a file that was
/// lost or changed since the last turn cannot weaken the limit.
pub(super) fn prepare(
    folder: &Path,
    agent: &Agent,
    request: &Request,
) -> Result<Prepared, FolderError> {
    let agents = folder.join(AGENTS);
    let agent_files = agents.join("agents");
    check_nothing_above(folder)?;
    // Nothing is written into the folder before it is known to be this user's own.
    make_private(folder)?;
    check_private(folder, &Found::at(folder)?)?;
    make_private(&agent_files)?;

    let agent_file = agent_files.join(format!("{}.md", agent.name));
    let text = agent.file(request);
    let read_prompt = ReadPrompt {
        path: agents.join(format!("{}-read-prompt.txt", agent.name)),
        text: text.clone(),
    };
    let prompt_changed = !read_prompt.is_read();
    write(&agent_file, &text)?;
    write(&agents.join(ALLOW_PROGRAM), include_str!("allow.awk"))?;
    write(&agents.join(agent.hooks_file), &agent.hooks().to_string())?;
    let token_file = match &request.mcp {
        Some(mcp) => {
            let file = TokenFile {
                path: agents.join(MCP_CONFIG),
                text: mcp_config(mcp).to_string(),
            };
            let _held = crate::lock(&TOKEN_FILE);
            write(&file.path, &file.text)?;
            Some(file)
        }
        None => None,
    };
    Ok(Prepared {
        prompt_changed,
        read_prompt,
        token_file,
    })
}

/// Makes the folder, and any folder above it that is missing, open to this user only.
fn make_private(folder: &Path) -> Result<(), FolderError> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(folder).map_err(|source| FolderError::Write {
        path: folder.to_owned(),
        source,
    })
}

/// What is at the place of the folder, and which user this program runs as.
struct Found {
    is_folder: bool,
    owner: u32,
    mode: u32,
    this_user: u32,
}

impl Found {
    /// A link is not followed, so a link to a folder is not a folder here.
    fn at(folder: &Path) -> Result<Found, FolderError> {
        let failed = |source| FolderError::Write {
            path: folder.to_owned(),
            source,
        };
        let place = std::fs::symlink_metadata(folder).map_err(failed)?;
        #[cfg(unix)]
        let (owner, mode, this_user) = {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            // The standard library does not say which user the program runs as; a file it has
            // just made does.
            let made = tempfile::tempfile().and_then(|file| file.metadata());
            let this_user = made.map_err(failed)?.uid();
            (place.uid(), place.permissions().mode() & 0o777, this_user)
        };
        #[cfg(not(unix))]
        let (owner, mode, this_user) = (0, 0, 0);
        Ok(Found {
            is_folder: place.is_dir(),
            owner,
            mode,
            this_user,
        })
    }
}

/// Refuses a folder that someone else made or can open: the turn's token lies in it, and a file
/// planted in it would reach agy.
fn check_private(folder: &Path, found: &Found) -> Result<(), FolderError> {
    let folder = folder.to_owned();
    if !found.is_folder {
        return Err(FolderError::NotAFolder { folder });
    }
    if found.owner != found.this_user {
        let owner = found.owner;
        return Err(FolderError::OtherOwner { folder, owner });
    }
    if found.mode & 0o077 != 0 {
        let mode = found.mode;
        return Err(FolderError::NotPrivate { folder, mode });
    }
    Ok(())
}

/// agy also reads rules, hooks and tool servers from the folders above the one it runs in, up
/// to the root of a Git checkout, so none of them may hold any. The folders above are those of
/// the real path, with every link followed.
fn check_nothing_above(folder: &Path) -> Result<(), FolderError> {
    for above in real_path(folder).ancestors().skip(1) {
        for found in AGY_FOLDERS.into_iter().chain([".git"]) {
            if above.join(found).exists() {
                return Err(FolderError::BelowCheckout {
                    folder: folder.to_owned(),
                    above: above.to_owned(),
                    found,
                });
            }
        }
    }
    Ok(())
}

/// The path with the links in it followed. The folder itself may not exist yet, so the nearest
/// folder above that does exist is resolved, and the rest of the path is put back on it.
fn real_path(folder: &Path) -> PathBuf {
    let existing = folder.ancestors().find_map(|above| {
        let real = std::fs::canonicalize(above).ok()?;
        Some(real.join(folder.strip_prefix(above).ok()?))
    });
    existing.unwrap_or_else(|| folder.to_owned())
}

/// Puts the whole text in place in one step, so agy never reads half a file.
fn write(path: &Path, text: &str) -> Result<(), FolderError> {
    let parent = path.parent().unwrap_or(Path::new("."));
    let replace = || {
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(text.as_bytes())?;
        file.persist(path).map_err(|error| error.error)?;
        Ok(())
    };
    replace().map_err(|source| FolderError::Write {
        path: path.to_owned(),
        source,
    })
}

/// The agent file of the last turn that ended well. A turn that fails may end before the model
/// reads a changed prompt, so only a turn that ended well records it.
pub(super) struct ReadPrompt {
    path: PathBuf,
    text: String,
}

impl ReadPrompt {
    fn is_read(&self) -> bool {
        std::fs::read_to_string(&self.path).is_ok_and(|read| read == self.text)
    }

    /// A record that cannot be written only means that the next continued turn sends the
    /// prompt again, which does no harm.
    pub(super) fn record(&self) {
        if let Err(error) = write(&self.path, &self.text) {
            eprintln!("jet: the agy prompt will be sent again: {error}");
        }
    }
}

/// The file that names Jet's tool server and holds the turn's token.
pub(super) struct TokenFile {
    path: PathBuf,
    text: String,
}

impl Drop for TokenFile {
    /// Removes the file unless a later turn has already written its own.
    fn drop(&mut self) {
        let _held = crate::lock(&TOKEN_FILE);
        if std::fs::read_to_string(&self.path).is_ok_and(|now| now == self.text) {
            // The token is dead once the turn is over, so a file that stays does no harm.
            std::fs::remove_file(&self.path).ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_folder_of_this_user_that_no_one_else_can_open_is_private() {
        let folder = Path::new("/tmp/jet-agy-chat-1");
        let found = |is_folder, owner, mode| Found {
            is_folder,
            owner,
            mode,
            this_user: 1000,
        };
        assert!(check_private(folder, &found(true, 1000, 0o700)).is_ok());
        assert!(matches!(
            check_private(folder, &found(true, 0, 0o700)),
            Err(FolderError::OtherOwner { owner: 0, .. })
        ));
        assert!(matches!(
            check_private(folder, &found(false, 1000, 0o700)),
            Err(FolderError::NotAFolder { .. })
        ));
        assert!(matches!(
            check_private(folder, &found(true, 1000, 0o750)),
            Err(FolderError::NotPrivate { mode: 0o750, .. })
        ));
    }
}
