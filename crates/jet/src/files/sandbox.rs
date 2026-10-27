//! Every parse of a stored file runs in a child of the running program, started with
//! `--read-file`. The child has a memory cap and the parent a time limit, so a file built to
//! exhaust memory or to hang kills only the child, never the server.

use std::path::{Path, PathBuf};
use std::process::{ExitCode, Stdio};
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::Semaphore;

use super::FileError;
use super::kind::FileKind;
use super::read::{Range, ReadError, Reading, describe, read};

/// The first argument that makes the program act as the file reader.
pub const READ_FILE_ARGUMENT: &str = "--read-file";

const DEADLINE: Duration = Duration::from_secs(30);
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const MEMORY_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Readers allowed at once, so the memory cap cannot be multiplied without end.
const READERS_AT_ONCE: usize = 2;

#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Job {
    Describe {
        kind: FileKind,
        path: PathBuf,
    },
    Read {
        kind: FileKind,
        path: PathBuf,
        range: Range,
    },
}

/// What the reader prints: the answer, or the message for a sheet that does not exist.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Answer<T> {
    Done(T),
    NoSuchSheet(String),
}

/// The parent side: starts readers, two at a time.
#[derive(Clone)]
pub(super) struct Sandbox {
    readers: Arc<Semaphore>,
}

impl Sandbox {
    pub fn new() -> Sandbox {
        Sandbox {
            readers: Arc::new(Semaphore::new(READERS_AT_ONCE)),
        }
    }

    /// The details of the file at `path`, as [`describe`] works them out.
    ///
    /// # Errors
    /// [`FileError::Unreadable`] when the reader fails, runs out of memory or time, or says the
    /// file is not what its kind says.
    pub async fn describe(
        &self,
        kind: FileKind,
        path: &Path,
        name: &str,
    ) -> Result<String, FileError> {
        let job = Job::Describe {
            kind,
            path: path.to_owned(),
        };
        self.run(&job, name).await
    }

    /// The part of the file at `path` that `range` asks for.
    ///
    /// # Errors
    /// - [`FileError::Unreadable`] as for [`Sandbox::describe`].
    /// - [`FileError::NoSuchSheet`] when the workbook has no sheet of that name.
    pub async fn read(
        &self,
        kind: FileKind,
        path: &Path,
        name: &str,
        range: &Range,
    ) -> Result<Reading, FileError> {
        let job = Job::Read {
            kind,
            path: path.to_owned(),
            range: range.clone(),
        };
        self.run(&job, name).await
    }

    // SMELL: the wait for a free reader has no deadline, so when many slow files arrive at once
    // an upload or a read of a file waits for as long as the queue ahead of it takes.
    async fn run<T: DeserializeOwned>(&self, job: &Job, name: &str) -> Result<T, FileError> {
        let refuse = |why: &dyn std::fmt::Display| {
            eprintln!("jet: could not read {name:?}: {why}");
            FileError::Unreadable(name.to_owned())
        };
        let _permit = self
            .readers
            .acquire()
            .await
            .expect("the semaphore is never closed");
        let mut child = start_reader()?;
        let mut stdin = child.stdin.take().expect("stdin was piped");
        let mut stdout = child.stdout.take().expect("stdout was piped");
        let work = async {
            let request = serde_json::to_vec(job).expect("a job is plain data");
            stdin
                .write_all(&request)
                .await
                .map_err(|why| refuse(&why))?;
            drop(stdin);
            // The output is read while the child runs, because a child that fills the pipe stops
            // until someone reads it and would then never exit.
            let mut output = Vec::new();
            (&mut stdout)
                .take(MAX_OUTPUT_BYTES as u64 + 1)
                .read_to_end(&mut output)
                .await
                .map_err(|why| refuse(&why))?;
            if output.len() > MAX_OUTPUT_BYTES {
                return Err(refuse(&"it printed too much"));
            }
            let status = child.wait().await.map_err(|why| refuse(&why))?;
            if !status.success() {
                return Err(refuse(&status));
            }
            serde_json::from_slice::<Answer<T>>(&output).map_err(|why| refuse(&why))
        };
        match tokio::time::timeout(DEADLINE, work).await {
            Err(_) => Err(refuse(&"it took too long")),
            Ok(Err(error)) => Err(error),
            Ok(Ok(Answer::Done(value))) => Ok(value),
            Ok(Ok(Answer::NoSuchSheet(message))) => Err(FileError::NoSuchSheet(message)),
        }
    }
}

/// A new reader with its input and output piped to this process. Dropping it kills it.
fn start_reader() -> Result<Child, FileError> {
    let program = reader_program();
    Command::new(&program)
        .arg(READ_FILE_ARGUMENT)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|source| FileError::Io {
            path: program,
            source,
        })
}

/// The running program itself. On Linux the path is `/proc/self/exe`, which keeps working after
/// a deploy replaces the file on disk but before the server restarts.
fn reader_program() -> PathBuf {
    if cfg!(target_os = "linux") {
        PathBuf::from("/proc/self/exe")
    } else {
        std::env::current_exe().unwrap_or_else(|_| PathBuf::from("jet"))
    }
}

#[derive(Debug, thiserror::Error)]
enum ServeError {
    #[error("could not set the memory limit: {0}")]
    Limit(#[source] std::io::Error),
    #[error("could not read the job: {0}")]
    Input(#[source] std::io::Error),
    #[error("the job is not valid: {0}")]
    Job(#[source] serde_json::Error),
    #[error("could not print the answer: {0}")]
    Output(#[source] std::io::Error),
    #[error(transparent)]
    Read(#[from] ReadError),
}

/// The child side: reads one job from standard input, does it under the limits, and prints the
/// answer as JSON. It exits with failure when the file cannot be read.
pub fn run_file_reader() -> ExitCode {
    match serve() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("jet: file reader: {error}");
            ExitCode::FAILURE
        }
    }
}

fn serve() -> Result<(), ServeError> {
    limit_resources()?;
    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input).map_err(ServeError::Input)?;
    let job: Job = serde_json::from_str(&input).map_err(ServeError::Job)?;
    let printed = match job {
        Job::Describe { kind, path } => {
            let bytes = std::fs::read(path).map_err(ServeError::Input)?;
            serde_json::to_string(&answer(describe(kind, &bytes))?)
        }
        Job::Read { kind, path, range } => {
            let bytes = std::fs::read(path).map_err(ServeError::Input)?;
            serde_json::to_string(&answer(read(kind, &bytes, &range))?)
        }
    };
    let printed = printed.map_err(|error| ServeError::Output(error.into()))?;
    println!("{printed}");
    Ok(())
}

/// A missing sheet is the asker's mistake and is passed on as a message; any other failure is
/// the file's and ends the reader.
fn answer<T>(result: Result<T, ReadError>) -> Result<Answer<T>, ReadError> {
    match result {
        Ok(value) => Ok(Answer::Done(value)),
        Err(error @ ReadError::NoSuchSheet { .. }) => Ok(Answer::NoSuchSheet(error.to_string())),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn limit_resources() -> Result<(), ServeError> {
    use rlimit::{Resource, setrlimit};
    // Without the memory cap nothing here is safe, so a failure to set it ends the reader.
    setrlimit(Resource::AS, MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES).map_err(ServeError::Limit)?;
    // The parent's own deadline still holds if either of these cannot be set.
    let _ = setrlimit(Resource::CPU, DEADLINE.as_secs(), DEADLINE.as_secs());
    // The value is 1, not 0: the host sends core dumps to a helper program, and the kernel skips
    // that helper only when the limit is exactly 1.
    let _ = setrlimit(Resource::CORE, 1, 1);
    Ok(())
}

#[cfg(not(unix))]
fn limit_resources() -> Result<(), ServeError> {
    Ok(())
}
