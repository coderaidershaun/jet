//! Prove a chat on Gemini 4 Neon runs through the agy stand-in in a folder of its own: it answers,
//! calls Jet's tools, continues its conversation, and never shares its folder with another chat.
use super::support::{Host, User, host, replay, request, send};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn fake_agy() -> PathBuf {
    let bins = Path::new(env!("CARGO_BIN_EXE_jet")).parent().unwrap();
    bins.join("fake-agy")
}

/// The folders the agy turns of this host's chats ran in, one for each chat that had a turn.
fn work_folders(host: &Host) -> Vec<PathBuf> {
    let of_chat_0 = agent::AgyCli::locate(Some(&fake_agy()), host.dir.path(), 0).unwrap();
    let name = of_chat_0.folder().file_name().unwrap().to_str().unwrap();
    let every_chat = name.strip_suffix('0').unwrap();
    let mut folders: Vec<PathBuf> = std::fs::read_dir(of_chat_0.folder().parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            let name = path.file_name().and_then(|name| name.to_str());
            name.is_some_and(|name| name.starts_with(every_chat))
        })
        .collect();
    folders.sort();
    folders
}

/// A JSON file the stand-in wrote in the folder it ran in.
fn written(work: &Path, name: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Ok(text) = std::fs::read_to_string(work.join(name))
            && let Ok(value) = serde_json::from_str(&text)
        {
            return value;
        }
        assert!(Instant::now() < deadline, "missing {name}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_chat_on_gemini_answers_through_agy_calls_jets_tools_and_continues() {
    let host = host();
    let no_app = json!({"appId": "00000000-0000-4000-8000-000000000000", "tool": "echo"});
    let script = json!([
        {"tool": "apps_list"},
        {"tool": "tools_search", "arguments": {"query": "echo"}},
        {"tool": "tools_describe", "arguments": no_app},
    ]);
    send(&host, "first", "gemini-4-neon", script, Value::Null);
    let answered = |count: usize| {
        host.until(|value| {
            value["active"].is_null()
                && value["history"]
                    .as_array()
                    .is_some_and(|history| history.len() == count)
        })
    };
    let reply = answered(2)["history"][1].clone();
    assert_eq!(reply["status"], "complete", "{reply}");
    assert_eq!(reply["text"], "Fixture app answered.\n");
    let [work] = &work_folders(&host)[..] else {
        panic!(
            "one chat answered, so one folder: {:?}",
            work_folders(&host)
        );
    };
    assert!(
        !work.starts_with(host.dir.path()),
        "agy must not run in the data folder"
    );
    let results = written(work, "facade-results.json");
    assert_eq!(results[0]["structuredContent"], json!([]), "{results}");
    assert_eq!(results[1]["isError"], false, "{results}");
    let calls: Vec<(&Value, &Value, &Value)> = reply["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|call| (&call["server"], &call["tool"], &call["ok"]))
        .collect();
    let (jet, yes, no) = (json!("jet"), json!(true), json!(false));
    assert_eq!(
        calls,
        [
            (&jet, &json!("apps_list"), &yes),
            (&jet, &json!("tools_search"), &yes),
            (&jet, &json!("tools_describe"), &no),
        ]
    );
    assert_eq!(reply["tools"][1]["input"], json!({"query": "echo"}));
    assert_eq!(
        reply["tools"][2]["result"]["error"]["message"],
        "app is no longer registered"
    );
    let kinds: Vec<Value> = replay(&host)
        .into_iter()
        .map(|event| event["kind"].clone())
        .collect();
    for kind in ["mood", "toolStarted", "toolFinished", "text", "finished"] {
        assert!(kinds.contains(&json!(kind)), "no {kind} event in {kinds:?}");
    }
    let first_args = written(work, "fake-agy-args.json");
    assert!(
        !first_args
            .as_array()
            .unwrap()
            .contains(&json!("--conversation"))
    );
    // The turn is told that it has no web tools, as a Codex turn is.
    let agent_file = std::fs::read_to_string(work.join(".agents/agents/jet.md")).unwrap();
    assert!(
        agent_file.contains("You cannot search or read the web here"),
        "{agent_file}"
    );

    send(
        &host,
        "second",
        "gemini-4-neon",
        json!([{"tool": "apps_list"}]),
        Value::Null,
    );
    assert_eq!(answered(4)["history"][3]["status"], "complete");
    let args = written(work, "fake-agy-args.json");
    let args = args.as_array().unwrap();
    assert_eq!(
        args[args.len() - 2..],
        [json!("--conversation"), json!("fake-agy-conversation")],
        "the second message continues the provider's conversation"
    );

    // With the model chosen in Settings, the status names the provider and where it was found.
    let mut chosen = host.get("/api/settings");
    assert_eq!(chosen["agyPath"], json!(fake_agy()), "{chosen}");
    chosen["model"] = json!("gemini-4-neon");
    assert_eq!(host.put("/api/settings", chosen).0, 200);
    let status = host.get("/api/status")["program"].clone();
    assert_eq!(
        (&status["provider"], &status["found"], &status["path"]),
        (&json!("agy"), &json!(true), &json!(fake_agy()))
    );
    std::fs::remove_dir_all(work).unwrap();
}

/// Starts a turn that calls one tool and then waits for the file `end` in its folder.
fn start_waiting_turn(user: &User, id: &str) {
    let mut message = request(id);
    message["model"] = json!("gemini-4-neon");
    message["text"] = json!(r#"facade:[{"tool":"apps_list"},{"wait":"end"}]"#);
    let (status, accepted) = user.post("/api/chat/send", message);
    assert_eq!(status, 200, "{accepted}");
    user.until(|snapshot| {
        let tools = snapshot["active"]["tools"].as_array();
        tools.is_some_and(|tools| tools.iter().any(|tool| tool["kind"] == "toolFinished"))
    });
}

#[test]
fn two_users_turns_at_the_same_time_run_in_folders_of_their_own() {
    let host = host();
    let users = [host.owner(), host.sign_in_as("admin1@gmail.com")];
    start_waiting_turn(&users[0], "owner-turn");
    start_waiting_turn(&users[1], "second-turn");

    // Both turns are running now. Each folder holds the token of its own turn and no other.
    let folders = work_folders(&host);
    assert_eq!(folders.len(), 2, "{folders:?}");
    let tokens: Vec<Value> = folders
        .iter()
        .map(|work| {
            let config = written(work, ".agents/mcp_config.json");
            let token = config["mcpServers"]["jet"]["headers"]["x-jet-turn"].clone();
            assert_eq!(token, written(work, "facade-connection.json")["token"]);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(work).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o700, "{}", work.display());
            }
            token
        })
        .collect();
    assert!(
        tokens[0].is_string() && tokens[0] != tokens[1],
        "{tokens:?}"
    );

    for work in &folders {
        std::fs::write(work.join("end"), "").unwrap();
    }
    for user in &users {
        let ended = user.until(|snapshot| snapshot["active"].is_null());
        let history = ended["history"].as_array().unwrap();
        assert_eq!(history.last().unwrap()["status"], "complete", "{ended}");
    }
    for work in folders {
        std::fs::remove_dir_all(work).unwrap();
    }
}

#[test]
fn an_agy_that_replaced_itself_with_a_newer_version_answers_no_message() {
    let host = host();
    // The stand-in says it is the version in the name it is started under.
    let newer = host.dir.path().join("agy-1.5.17");
    std::os::unix::fs::symlink(fake_agy(), &newer).unwrap();
    host.set_programs(json!({"agyPath": newer}));

    send(&host, "first", "gemini-4-neon", json!([]), Value::Null);
    let reply = host.until(|value| value["active"].is_null() && value["history"][1].is_object());
    let reply = &reply["history"][1];
    assert_eq!(reply["status"], "failed", "{reply}");
    let said = reply["error"].as_str().unwrap();
    assert!(
        said.contains("version 1.5.17") && said.contains("only at version 1.5.16"),
        "{said}"
    );
    assert!(work_folders(&host).is_empty(), "agy ran");
}
