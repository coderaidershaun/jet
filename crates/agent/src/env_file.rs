//! Finds a setting in the environment or in the nearest `.env` file, without changing the
//! process environment, so that an edited `.env` is picked up by the next call.

use std::path::Path;

/// The value of `variable` as it is now: the environment first, then the nearest `.env` file.
pub(crate) fn read(variable: &str) -> Option<String> {
    let directory = std::env::current_dir().unwrap_or_default();
    lookup(variable, std::env::var(variable).ok(), &directory)
}

/// `environment` is the variable's value in the process environment. A blank value counts as
/// missing, in the environment and in the file.
pub(crate) fn lookup(
    variable: &str,
    environment: Option<String>,
    directory: &Path,
) -> Option<String> {
    if let Some(value) = environment.filter(|value| !value.trim().is_empty()) {
        return Some(value);
    }
    // Match dotenv's nearest-file rule; a nearer file owns the configuration even without the variable.
    let path = directory
        .ancestors()
        .map(|parent| parent.join(".env"))
        .find(|path| path.is_file())?;
    dotenvy::from_path_iter(path)
        .ok()?
        .filter_map(Result::ok)
        .find(|(name, value)| name == variable && !value.trim().is_empty())
        .map(|(_, value)| value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_variable_is_found_in_the_environment_then_the_nearest_env_file() {
        // The value comes from the environment first, then from the nearest .env file above the
        // folder, and finding it never changes the environment.
        const VARIABLE: &str = "JEV_API_KEY";
        let before = std::env::var_os(VARIABLE);
        let root = tempfile::tempdir().unwrap();
        let child = root.path().join("a/b");
        std::fs::create_dir_all(&child).unwrap();
        assert!(lookup(VARIABLE, None, &child).is_none());
        std::fs::write(
            root.path().join(".env"),
            "export JEV_API_KEY='parent-value'\n",
        )
        .unwrap();
        assert_eq!(
            lookup(VARIABLE, None, &child).as_deref(),
            Some("parent-value")
        );
        assert_eq!(
            lookup(VARIABLE, Some("environment-value".into()), &child).as_deref(),
            Some("environment-value")
        );
        std::fs::write(child.join(".env"), "JEV_API_KEY=nearest-value\n").unwrap();
        assert_eq!(
            lookup(VARIABLE, None, &child).as_deref(),
            Some("nearest-value")
        );
        std::fs::write(child.join(".env"), "OTHER=present\n").unwrap();
        assert!(
            lookup(VARIABLE, None, &child).is_none(),
            "a nearer file owns the configuration"
        );
        assert_eq!(std::env::var_os(VARIABLE), before);
    }
}
