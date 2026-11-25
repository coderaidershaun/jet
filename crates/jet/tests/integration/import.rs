//! Prove that the first start on a data directory an older Jet left copies its files into the
//! owner's account and nobody else's, leaves every old file as it was, and copies nothing twice.
use super::support::{Host, User};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

const APP: &str = "b35da07b-1164-4d24-8d9f-b7b95289db1c";
const FILE: &str = "6f1e8a52-3a3b-4c43-9a43-0d1b2f0e7c11";

const TRANSCRIPT: &str = concat!(
    r#"{"id":1,"role":"user","text":"read https://github.com/anthropics","status":"complete","at":10,"reactions":[{"by":"jet","emoji":"👍","at":12}]}"#,
    "\n",
    r#"{"id":2,"role":"jet","text":"It is the Claude Code page.","mood":"neutral","status":"complete","at":11,"tools":[{"id":"w1","server":"web","tool":"fetch","input":{"url":"https://github.com/anthropics"},"ok":true,"result":"A page about Claude Code.","summary":"web · fetch","durationMs":40}]}"#,
    "\n",
);
const SESSION: &str = r#"{"sessionId":"0b2147e5-0135-4323-960e-f86c85cc09a7","lastRequestAt":11,"contextTokens":29435,"context":{"model":"sonnet","usedTokens":15049,"limitTokens":1000000,"estimated":false},"promptHash":"398c5dd712491b41","reviewedThrough":2,"reviewedAt":12}"#;
const APPS: &str = r#"{"version":1,"apps":[{"id":"b35da07b-1164-4d24-8d9f-b7b95289db1c","label":"Quanty","baseUrl":"http://127.0.0.1:7878/","uiUrl":"http://127.0.0.1:7878/","mcpUrl":null,"embedding":"relative-paths","enabled":true,"overrides":{"label":null,"ui":null,"mcp":{"mode":"discover"},"embedding":null}}]}"#;

/// An older Jet's data directory: the thread with a reaction and a web card, the provider session,
/// the three notes, the settings with the provider program, the app registry and one file.
fn older_jet() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let program = dir.path().join("provider.py");
    std::fs::write(&program, include_str!("provider.py")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let settings = json!({"reducedMotion":true,"persona":{"name":"Ada","jobTitle":"First-mate","notes":""},"model":"sonnet","effort":"medium","turnBudgetUsd":2.5,"drawerOpen":true,"claudePath":program,"codexPath":null});
    for (name, text) in [
        ("transcript.jsonl", TRANSCRIPT.to_owned()),
        ("session.json", SESSION.to_owned()),
        ("MEMORY.md", "- Shaun flies kites".to_owned()),
        ("USER.md", "- Name: Shaun".to_owned()),
        ("RECENT.md", "- the move to SQLite".to_owned()),
        ("settings.json", settings.to_string()),
        ("apps.json", APPS.to_owned()),
    ] {
        std::fs::write(dir.path().join(name), text).unwrap();
    }
    let folder = dir.path().join("files").join(FILE);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("brief.md"), "# Brief\n").unwrap();
    dir
}

/// Fails unless every file in `before` is still there with the same bytes.
fn assert_unchanged(before: &BTreeMap<PathBuf, Vec<u8>>, dir: &Path) {
    let now = old_files(dir);
    for (path, bytes) in before {
        assert_eq!(now.get(path), Some(bytes), "{} changed", path.display());
    }
}

/// Every file under `dir` but the database, with its bytes.
fn old_files(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut found = BTreeMap::new();
    let mut pending = vec![dir.to_owned()];
    while let Some(folder) = pending.pop() {
        for entry in std::fs::read_dir(&folder).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else if !path.to_string_lossy().contains("jet.sqlite3") {
                found.insert(path.clone(), std::fs::read(&path).unwrap());
            }
        }
    }
    found
}

/// What the owner was given by the import.
fn assert_imported(owner: &User) {
    let history = owner.get("/api/snapshot")["history"].clone();
    assert_eq!(history.as_array().unwrap().len(), 2, "{history}");
    assert_eq!(history[0]["reactions"][0]["emoji"], "👍", "{history}");
    assert_eq!(history[1]["tools"][0]["server"], "web", "{history}");
    assert_eq!(
        history[1]["tools"][0]["result"],
        "A page about Claude Code."
    );
    let notes = owner.get("/api/memory");
    assert_eq!(
        (&notes["memory"], &notes["user"], &notes["recent"]),
        (
            &json!("- Shaun flies kites"),
            &json!("- Name: Shaun"),
            &json!("- the move to SQLite")
        )
    );
    let settings = owner.get("/api/settings");
    assert_eq!(settings["persona"]["name"], "Ada");
    assert_eq!(settings["turnBudgetUsd"], 2.5);
    assert!(
        settings["claudePath"]
            .as_str()
            .unwrap()
            .ends_with("provider.py")
    );
    let apps = owner.get("/api/apps");
    assert_eq!(apps.as_array().unwrap().len(), 1, "{apps}");
    assert_eq!(apps[0]["id"], APP);
    assert_eq!(owner.get("/api/status")["context"]["usedTokens"], 15049);
    assert_eq!(owner.fetch(&format!("/api/files/{FILE}")).0, 200);
    let pane = owner.get("/api/pane");
    assert_eq!(
        pane["artifacts"][0]["id"], FILE,
        "an imported file is in the main chat: {pane}"
    );
}

#[test]
fn the_older_jets_files_reach_the_owner_only_once_and_stay_as_they_were() {
    let dir = older_jet();
    let before = old_files(dir.path());
    let host = Host::launch_with(dir, &[]);
    let (owner, second) = (host.owner(), host.sign_in_as("admin123@gmail.com"));
    assert_imported(&owner);

    assert_eq!(second.get("/api/snapshot")["history"], json!([]));
    assert_eq!(second.get("/api/memory")["memory"], "");
    assert_eq!(second.get("/api/settings")["persona"]["name"], "Jet");
    assert_eq!(second.get("/api/apps"), json!([]));
    assert_eq!(
        second.get("/api/status")["context"]["usedTokens"],
        Value::Null
    );
    assert_eq!(second.fetch(&format!("/api/files/{FILE}")).0, 404);
    assert_unchanged(&before, host.dir.path());

    let host = host.restart();
    assert_imported(&host.owner());
    assert_unchanged(&before, host.dir.path());
}
