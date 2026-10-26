//! Finds the nearest key file without changing the process environment.

use std::path::Path;

pub(super) const VARIABLE: &str = "JEV_API_KEY";

pub(super) fn discover(environment: Option<String>, directory: &Path) -> Option<String> {
    if let Some(key) = environment.filter(|key| !key.trim().is_empty()) {
        return Some(key);
    }
    // Match dotenv's nearest-file rule; a nearer file owns the configuration even without a key.
    let path = directory
        .ancestors()
        .map(|parent| parent.join(".env"))
        .find(|path| path.is_file())?;
    dotenvy::from_path_iter(path)
        .ok()?
        .filter_map(Result::ok)
        .find(|(name, value)| name == VARIABLE && !value.trim().is_empty())
        .map(|(_, value)| value)
}
