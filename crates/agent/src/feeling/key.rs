//! Finds the nearest key file without changing the process environment.

use std::path::Path;

pub(super) const VARIABLE: &str = "JEV_API_KEY";

pub(super) fn discover(environment: Option<String>, directory: &Path) -> Option<String> {
    if let Some(key) = environment.filter(|key| !key.trim().is_empty()) {
        return Some(key);
    }
    // Match dotenv's nearest-file rule; a nearer file owns the configuration even without a key.
    for parent in directory.ancestors() {
        let path = parent.join(".env");
        if !path.is_file() {
            continue;
        }
        return dotenvy::from_path_iter(path)
            .ok()?
            .filter_map(Result::ok)
            .find(|(name, value)| name == VARIABLE && !value.trim().is_empty())
            .map(|(_, value)| value);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_discovery_prefers_environment_then_nearest_parent_without_mutation() {
        let before = std::env::var_os(VARIABLE);
        let root = tempfile::tempdir().unwrap();
        let child = root.path().join("a/b");
        std::fs::create_dir_all(&child).unwrap();
        assert!(discover(None, &child).is_none());
        std::fs::write(
            root.path().join(".env"),
            "export JEV_API_KEY='parent-test-value'\n",
        )
        .unwrap();
        assert!(discover(None, &child).is_some_and(|key| key == "parent-test-value"));
        assert!(
            discover(Some("environment-test-value".into()), &child)
                .is_some_and(|key| key == "environment-test-value")
        );
        std::fs::write(child.join(".env"), "JEV_API_KEY=nearest-test-value\n").unwrap();
        assert!(discover(None, &child).is_some_and(|key| key == "nearest-test-value"));
        std::fs::write(child.join(".env"), "OTHER=present\n").unwrap();
        assert!(discover(None, &child).is_none());
        assert!(std::env::var_os(VARIABLE) == before);
    }
}
