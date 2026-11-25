//! What the two models that run on the server share: the quick check of their weights, and the last
//! attempt to load them, which is kept even when it failed so the settings can say why until the
//! weights change.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Whether the file starts as every GGUF model does; `None` when it cannot be read.
pub(super) fn is_gguf(weights: &Path) -> Option<bool> {
    let mut magic = [0_u8; 4];
    let mut file = std::fs::File::open(weights).ok()?;
    file.read_exact(&mut magic).ok()?;
    Some(&magic == b"GGUF")
}

/// One attempt to load a model from its weights, on the CPU alone or not.
pub(super) struct Attempt<T> {
    weights: PathBuf,
    modified: Option<SystemTime>,
    // A Jet built without either model never loads one.
    #[cfg_attr(
        not(any(feature = "phonon2", feature = "phonon-tts")),
        expect(dead_code)
    )]
    on_cpu: bool,
    loaded: Result<T, String>,
}

/// The model loaded from these weights, loading it first when the last attempt was of other
/// weights, of a changed file or on another device. A failed attempt is not tried again until then.
#[cfg(any(feature = "phonon2", feature = "phonon-tts"))]
pub(super) fn load<'a, T>(
    slot: &'a mut Option<Attempt<T>>,
    weights: &Path,
    on_cpu: bool,
    load: impl FnOnce() -> Result<T, String>,
) -> Result<&'a T, String> {
    let current = slot.as_ref().is_some_and(|attempt| {
        attempt.weights == weights
            && attempt.modified == modified(weights)
            && attempt.on_cpu == on_cpu
    });
    if !current {
        // The old model goes first, so two are never in memory at once.
        *slot = None;
    }
    let attempt = slot.get_or_insert_with(|| Attempt {
        weights: weights.to_owned(),
        modified: modified(weights),
        on_cpu,
        loaded: load(),
    });
    attempt.loaded.as_ref().map_err(Clone::clone)
}

fn modified(weights: &Path) -> Option<SystemTime> {
    std::fs::metadata(weights)
        .and_then(|meta| meta.modified())
        .ok()
}

/// Why the last attempt to load these weights failed, while they are unchanged. A call in flight
/// holds the lock, and the model it uses has loaded, so this never waits for it.
pub(super) fn last_failure<T>(slot: &Mutex<Option<Attempt<T>>>, weights: &Path) -> Option<String> {
    let slot = slot.try_lock().ok()?;
    let attempt = slot.as_ref()?;
    let same = attempt.weights == weights && attempt.modified == modified(weights);
    match &attempt.loaded {
        Err(reason) if same => Some(reason.clone()),
        _ => None,
    }
}
