//! Prove, through the real host with the provider stand-ins, that an admin restores the server to
//! factory defaults: every table and the data folder end as a new install has them, the host goes
//! on with no restart, and anyone else, or a request without the typed word, deletes nothing.
use super::{
    objectives::{MANAGER, create, database, objectives, run_turn},
    support::{
        Host, OWNER, PASSWORD, User, cookie_header, host, listening_url, request, send, sign_in,
    },
};
use rusqlite::{Connection, types::Value as Cell};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

/// The columns a new install fills differently each time: a salted hash and two times.
const DIFFERS_BY_INSTALL: [&str; 3] = ["password_hash", "created_at", "imported_at"];

/// The schema, and every table of `sqlite_master` with its rows, so a table that a later
/// migration adds is compared with no change here.
fn contents(db: &Connection) -> BTreeMap<String, Vec<String>> {
    let texts = |sql: &str| -> Vec<String> {
        let mut statement = db.prepare(sql).unwrap();
        let columns: Vec<String> = statement.column_names().map(str::to_owned).collect();
        let rows = statement
            .query_map([], |row| {
                let cells: Vec<String> = columns
                    .iter()
                    .enumerate()
                    .map(|(at, name)| match row.get::<_, Cell>(at) {
                        Ok(_) if DIFFERS_BY_INSTALL.contains(&name.as_str()) => name.clone(),
                        cell => format!("{name}={cell:?}"),
                    })
                    .collect();
                Ok(cells.join(", "))
            })
            .unwrap();
        let mut rows: Vec<String> = rows.map(Result::unwrap).collect();
        rows.sort();
        rows
    };
    let mut all = BTreeMap::new();
    all.insert(
        "(schema)".to_owned(),
        texts("SELECT type, name, tbl_name, sql FROM sqlite_master"),
    );
    all.insert("(version)".to_owned(), texts("PRAGMA user_version"));
    let tables: Vec<String> = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    for table in tables {
        let rows = texts(&format!("SELECT * FROM \"{table}\""));
        all.insert(table, rows);
    }
    all
}

/// Starts Jet on the folder as an operator does, with these flags and this password for the demo
/// accounts, and signs nobody in. The caller ends it.
fn start(dir: &Path, flags: &[&str], seed_password: Option<&str>) -> (Child, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_jet"));
    command
        .args(["--listen", "127.0.0.1:0", "--data-dir"])
        .arg(dir)
        .args(["--disable-feelings", "--disable-voice"])
        .args(flags)
        .env_remove("JET_SEED_PASSWORD")
        .stdout(Stdio::piped());
    if let Some(password) = seed_password {
        command.env("JET_SEED_PASSWORD", password);
    }
    let mut child = command.spawn().unwrap();
    let url = listening_url(&mut child);
    (child, url)
}

fn end(mut host: Child) {
    host.kill().unwrap();
    host.wait().unwrap();
}

/// What a new install holds: the database of a host after its first start on an empty folder.
fn new_install() -> BTreeMap<String, Vec<String>> {
    let dir = tempfile::tempdir().unwrap();
    end(start(dir.path(), &[], None).0);
    contents(&Connection::open(dir.path().join("jet.sqlite3")).unwrap())
}

/// The folders in the system's temporary folder whose names start as the folder of an agy turn
/// of this host's chats does, found through the agy provider's own naming.
fn named_as_agy_folders(host: &Host) -> Vec<PathBuf> {
    let fake = Path::new(env!("CARGO_BIN_EXE_jet")).with_file_name("fake-agy");
    let of_chat_0 = agent::AgyCli::locate(Some(&fake), host.dir.path(), 0).unwrap();
    let name = of_chat_0.folder().file_name().unwrap().to_str().unwrap();
    let every_chat = name.strip_suffix('0').unwrap().to_owned();
    let mut folders: Vec<PathBuf> = std::fs::read_dir(of_chat_0.folder().parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            let name = path.file_name().and_then(|name| name.to_str());
            name.is_some_and(|name| name.starts_with(&every_chat))
        })
        .collect();
    folders.sort();
    folders
}

/// The name and the bytes of each entry of a folder; a folder or a link has no bytes.
fn entries(dir: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            let bytes = entry
                .file_type()
                .unwrap()
                .is_file()
                .then(|| std::fs::read(entry.path()).unwrap());
            (entry.file_name().to_string_lossy().into_owned(), bytes)
        })
        .collect()
}

/// The provider programs the host runs now, each a child of it.
fn providers(host: &Host) -> Vec<String> {
    let found = Command::new("pgrep")
        .args(["-P", &host.child.id().to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&found.stdout)
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

fn running(pid: &str) -> bool {
    Command::new("kill")
        .args(["-0", pid])
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success()
}

/// Sends a message and waits for Jet's whole reply to it.
fn answered(user: &User, id: &str) {
    let mut message = request(id);
    message["text"] = "hello".into();
    let (status, body) = user.post("/api/chat/send", message);
    assert_eq!(status, 200, "{body}");
    user.until(|snapshot| {
        snapshot["active"].is_null()
            && snapshot["history"][1]["text"] == "Partial browser reply"
            && snapshot["history"][1]["status"] == "complete"
    });
}

#[test]
fn a_reset_leaves_what_a_new_install_holds_and_the_host_goes_on() {
    let host = host();
    let (owner, dir) = (host.owner(), host.dir.path());
    let outside = tempfile::tempdir().unwrap();
    let kept = outside.path().join("keep.txt");
    std::fs::write(&kept, "outside the data folder").unwrap();

    // The old world: an objective with its chat, a loose task, a file, notes, a second user's
    // sign-in and settings, and in the data folder a file, a folder and a link that leads outside.
    run_turn(
        &host,
        &owner,
        "fill",
        "I am building a kite.",
        json!([
            create(json!([])),
            objectives(json!({"action":"step_add","title":"Buy string"})),
        ]),
    );
    // A turn through agy leaves the user's instructions in a folder of the system's temporary
    // folder. A folder beside it that names no chat is not Jet's to delete.
    send(&host, "agy", "gemini-4-neon", json!([]), Value::Null);
    owner.until(|snapshot| {
        snapshot["active"].is_null() && snapshot["history"][4]["status"] == "complete"
    });
    let [agy_folder] = &named_as_agy_folders(&host)[..] else {
        panic!(
            "one chat ran an agy turn: {:?}",
            named_as_agy_folders(&host)
        );
    };
    let not_a_chats = agy_folder.with_file_name(format!(
        "{}-kept",
        agy_folder.file_name().unwrap().to_str().unwrap()
    ));
    std::fs::create_dir(&not_a_chats).unwrap();
    assert_eq!(host.upload("notes.txt", b"what the user kept").0, 200);
    let notes = json!({"memory":"likes kites","user":"","recent":""});
    assert_eq!(owner.put("/api/memory", notes).0, 200);
    let manager = host.sign_in_as(MANAGER);
    assert_eq!(
        manager.put("/api/settings", json!({"model":"haiku"})).0,
        200
    );
    std::fs::write(dir.join("old.txt"), "old").unwrap();
    std::fs::create_dir(dir.join("old-folder")).unwrap();
    std::fs::write(dir.join("old-folder/inner.txt"), "old").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), dir.join("link")).unwrap();
    // A turn that hangs is running when the reset starts.
    host.set_programs(json!({"claudePath": dir.join("provider.py")}));
    assert_eq!(owner.post("/api/chat/send", request("hang")).0, 200);
    owner.until(|snapshot| snapshot["active"]["text"] == "Partial browser reply");
    let turns = providers(&host);
    assert!(!turns.is_empty(), "no provider turn was running");
    let before = entries(dir);

    let (status, body) = owner.post("/api/factory-reset", json!({"confirm":"RESET"}));
    assert_eq!(status, 200, "{body}");

    let deadline = Instant::now() + Duration::from_secs(5);
    while turns.iter().any(|pid| running(pid)) {
        assert!(
            Instant::now() < deadline,
            "the running turn was not stopped"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // The data folder holds a new database and new keys, and nothing else.
    let after = entries(dir);
    let fresh_names = ["github-token-key", "jet.sqlite3", "signing-secret"];
    for (name, bytes) in &after {
        let part_of_database = name.starts_with("jet.sqlite3");
        assert!(
            part_of_database || fresh_names.contains(&name.as_str()),
            "{name} is still in the data folder"
        );
        assert!(
            part_of_database || before.get(name) != Some(bytes),
            "{name} was kept as it was"
        );
    }
    assert!(fresh_names.iter().all(|name| after.contains_key(*name)));
    assert_eq!(
        std::fs::read_to_string(&kept).unwrap(),
        "outside the data folder"
    );
    // The agy folder of the old chat is gone, and the folder that names no chat is not.
    let left = named_as_agy_folders(&host);
    std::fs::remove_dir(&not_a_chats).unwrap();
    assert_eq!(left, [not_a_chats]);
    // Every table holds what a new install holds.
    let expected = new_install();
    let found = contents(&database(&host));
    assert!(
        expected.len() > 20,
        "the tables were not read: {expected:?}"
    );
    for (table, rows) in &expected {
        assert_eq!(found.get(table), Some(rows), "table {table}");
    }
    assert_eq!(found.len(), expected.len());
    // Every browser is signed out, the manager's too.
    assert_eq!(owner.fetch("/api/snapshot").0, 401);
    assert_eq!(manager.fetch("/api/snapshot").0, 401);

    // The seeded admin signs in, and a turn records an objective through Jet's tools, with no
    // restart.
    let signed_in = sign_in(&host.url, &host.origin, OWNER, PASSWORD);
    assert_eq!(signed_in.status(), 200);
    let admin = User {
        cookie: cookie_header(&signed_in),
        ..owner
    };
    assert_eq!(admin.get("/api/snapshot")["history"], json!([]));
    let fake = Path::new(env!("CARGO_BIN_EXE_jet")).with_file_name("fake-claude");
    let (status, body) = admin.put("/api/settings", json!({"claudePath": fake}));
    assert_eq!(status, 200, "{body}");
    let recorded = run_turn(
        &host,
        &admin,
        "after",
        "After the reset.",
        json!([create(json!([]))]),
    );
    assert_eq!(recorded[0]["isError"], false, "{recorded:?}");

    // And again after a restart of the host, which signs the owner in as it starts.
    let host = host.restart();
    let history = host.get("/api/snapshot")["history"].to_string();
    assert!(
        history.contains("After the reset.") && !history.contains("I am building a kite."),
        "{history}"
    );
    let goals = host.get("/api/task-list")["goals"].clone();
    assert_eq!(goals.as_array().unwrap().len(), 1, "{goals}");
}

#[test]
fn a_reset_is_refused_for_anyone_but_an_admin_and_without_the_typed_word() {
    let host = Host::start();
    let (owner, dir) = (host.owner(), host.dir.path());
    answered(&owner, "kept");
    std::fs::write(dir.join("old.txt"), "old").unwrap();
    // The stand-in appends to its record of calls as a reply ends, so it is left out.
    let folder = || {
        let mut found = entries(dir);
        found.retain(|name, _| !name.starts_with("jet.sqlite3") && name != "calls");
        found
    };
    let manager = host.sign_in_as(MANAGER);
    let before = (folder(), contents(&database(&host)));

    let (status, body) = manager.post("/api/factory-reset", json!({"confirm":"RESET"}));
    assert_eq!(
        (status, &body["kind"]),
        (403, &json!("adminOnly")),
        "{body}"
    );
    for word in [json!({}), json!({"confirm":"reset"})] {
        let (status, body) = owner.post("/api/factory-reset", word);
        assert_eq!(
            (status, &body["kind"]),
            (400, &json!("invalidRequest")),
            "{body}"
        );
    }

    let after = (folder(), contents(&database(&host)));

    // A public host that runs with no password for the demo accounts would seed nobody after a
    // reset, so it refuses, and its admin stays signed in.
    let public = "https://jet.test";
    let (seeded, operator) = (tempfile::tempdir().unwrap(), "the operator's own password");
    let (first, url) = start(seeded.path(), &["--public-origin", public], Some(operator));
    let cookie = cookie_header(&sign_in(&url, public, OWNER, operator));
    end(first);
    let (second, url) = start(seeded.path(), &["--public-origin", public], None);
    let admin = User {
        url,
        origin: public.to_owned(),
        cookie,
    };
    let refused = admin.post("/api/factory-reset", json!({"confirm":"RESET"}));
    let still_signed_in = admin.fetch("/api/auth/me").0;
    end(second);
    assert_eq!(
        (refused.0, &refused.1["kind"]),
        (400, &json!("invalidRequest")),
        "{refused:?}"
    );
    assert!(
        refused.1["message"]
            .as_str()
            .is_some_and(|message| message.contains("JET_SEED_PASSWORD")
                && message.contains("nothing was deleted")),
        "{refused:?}"
    );
    assert_eq!(still_signed_in, 200);
    assert_eq!(after, before, "a refused reset changed something");
    assert_eq!(owner.get("/api/snapshot")["history"][0]["text"], "hello");
}
