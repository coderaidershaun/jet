//! Every parse of a stored file runs in a child of the running program, started with
//! `--read-file`. The child has a memory cap and the parent a time limit, so a file built to
//! exhaust memory or to hang kills only the child, never the server. The child gets the job and
//! the file's bytes on its standard input and opens no file itself.

use std::path::PathBuf;
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
#[cfg(target_os = "linux")]
const MEMORY_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// The memory cap off Linux. macOS refuses any cap below what a process has already mapped, about
/// 400 GiB at rest, so 2 GiB cannot be set there. 1 TiB still stops a runaway reservation, and the
/// time limits bound the rest.
#[cfg(all(unix, not(target_os = "linux")))]
const LOOSE_MEMORY_LIMIT_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
/// Readers allowed at once, so the memory cap cannot be multiplied without end.
const READERS_AT_ONCE: usize = 2;

/// The first line of the child's input; the file's bytes follow it.
#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Job {
    Describe { kind: FileKind },
    Read { kind: FileKind, range: Range },
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
    pub(super) readers: Arc<Semaphore>,
    /// The longest a job waits for a free reader.
    queue: Duration,
}

impl Sandbox {
    pub fn new(queue: Duration) -> Sandbox {
        Sandbox {
            readers: Arc::new(Semaphore::new(READERS_AT_ONCE)),
            queue,
        }
    }

    /// The details of the file, as [`describe`] works them out.
    ///
    /// # Errors
    /// [`FileError::Unreadable`] when the reader fails, runs out of memory or time, or says the
    /// file is not what its kind says.
    pub async fn describe(
        &self,
        kind: FileKind,
        contents: &[u8],
        name: &str,
    ) -> Result<String, FileError> {
        self.run(&Job::Describe { kind }, contents, name).await
    }

    /// The part of the file that `range` asks for.
    ///
    /// # Errors
    /// - [`FileError::Unreadable`] as for [`Sandbox::describe`].
    /// - [`FileError::NoSuchSheet`] when the workbook has no sheet of that name.
    pub async fn read(
        &self,
        kind: FileKind,
        contents: &[u8],
        name: &str,
        range: &Range,
    ) -> Result<Reading, FileError> {
        let job = Job::Read {
            kind,
            range: range.clone(),
        };
        self.run(&job, contents, name).await
    }

    /// Waits for a free reader, at most as long as `queue`, then runs the job in it.
    async fn run<T: DeserializeOwned>(
        &self,
        job: &Job,
        contents: &[u8],
        name: &str,
    ) -> Result<T, FileError> {
        let refuse = |why: &dyn std::fmt::Display| {
            eprintln!("jet: could not read {name:?}: {why}");
            FileError::Unreadable(name.to_owned())
        };
        let _permit = super::wait_for(&self.readers, self.queue).await?;
        let mut child = start_reader()?;
        let mut stdin = child.stdin.take().expect("stdin was piped");
        let mut stdout = child.stdout.take().expect("stdout was piped");
        let work = async {
            let mut request = serde_json::to_vec(job).expect("a job is plain data");
            request.push(b'\n');
            // The input is written while the output is read, because a child that fills its
            // output pipe stops until someone reads it, and would then never take the rest of a
            // large file.
            let write = async {
                stdin.write_all(&request).await?;
                stdin.write_all(contents).await?;
                drop(stdin);
                Ok::<(), std::io::Error>(())
            };
            let mut output = Vec::new();
            let mut limited = (&mut stdout).take(MAX_OUTPUT_BYTES as u64 + 1);
            let read = limited.read_to_end(&mut output);
            let (written, read) = tokio::join!(write, read);
            written.map_err(|why| refuse(&why))?;
            read.map_err(|why| refuse(&why))?;
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
        .map_err(|source| FileError::Reader { program, source })
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
    #[cfg(target_os = "linux")]
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
    let mut input = Vec::new();
    std::io::Read::read_to_end(&mut std::io::stdin(), &mut input).map_err(ServeError::Input)?;
    let end = input
        .iter()
        .position(|byte| *byte == b'\n')
        .unwrap_or(input.len());
    let job: Job = serde_json::from_slice(&input[..end]).map_err(ServeError::Job)?;
    let bytes = input.get(end + 1..).unwrap_or_default();
    let printed = match job {
        Job::Describe { kind } => serde_json::to_string(&answer(describe(kind, bytes))?),
        Job::Read { kind, range } => serde_json::to_string(&answer(read(kind, bytes, &range))?),
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

#[cfg(target_os = "linux")]
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

#[cfg(all(unix, not(target_os = "linux")))]
fn limit_resources() -> Result<(), ServeError> {
    use rlimit::{Resource, setrlimit};
    if let Err(error) = setrlimit(
        Resource::AS,
        LOOSE_MEMORY_LIMIT_BYTES,
        LOOSE_MEMORY_LIMIT_BYTES,
    ) {
        eprintln!(
            "jet: file reader: the memory cap could not be set on this system: {error}; the reader runs with the time limits only"
        );
    }
    let _ = setrlimit(Resource::CPU, DEADLINE.as_secs(), DEADLINE.as_secs());
    let _ = setrlimit(Resource::CORE, 1, 1);
    Ok(())
}

#[cfg(not(unix))]
fn limit_resources() -> Result<(), ServeError> {
    Ok(())
}
