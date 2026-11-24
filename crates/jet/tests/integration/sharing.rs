//! Prove, through the real host with the provider stand-in and the seeded accounts, that an
//! objective is shared only by its owner's tap on a share card, that a colleague's Jet reads only
//! what is shared, and that an admin changes the directory through Jet.
use super::{
    objectives::{MANAGER, create, data, database, error_kind, objectives, run_turn},
    support::{Host, User, host},
};
use serde_json::{Value, json};

const OWNER: &str = "shaunsurfing@gmail.com";
const FIRST: &str = "admin1@gmail.com";
const SECOND: &str = "admin2@gmail.com";
const OUTSIDER: &str = "admin3@gmail.com";
const PRIVATE_NOTE: &str = "I think this will fail";

fn user_id(host: &Host, email: &str) -> i64 {
    database(host)
        .query_row("SELECT id FROM users WHERE email = ?1", [email], |row| {
            row.get(0)
        })
        .unwrap()
}

fn commercial(host: &Host) -> i64 {
    database(host)
        .query_row(
            "SELECT id FROM teams WHERE name = 'Commercial'",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

fn read_owner(owner: i64) -> Value {
    json!({"tool":"objectives_list","arguments":{"owner":owner}})
}

fn propose(id: &Value, people: Value, teams: Value) -> Value {
    objectives(json!({"action":"propose_share","id":id,"people":people,"teams":teams}))
}

fn tap(user: &User, card: &Value, people: Value, teams: Value) -> (u16, Value) {
    user.post(
        &format!("/api/shares/proposals/{}/apply", card["id"]),
        json!({"people":people,"teams":teams}),
    )
}

/// What the colleague's Jet is told when it reads `owner`'s objectives.
fn read_as(host: &Host, user: &User, turn: &str, owner: i64) -> Value {
    let words = "How is Shaun getting on?";
    let results = run_turn(host, user, turn, words, json!([read_owner(owner)]));
    data(&results[0])["objectives"].clone()
}

/// The owner agrees a kite objective with a public and a private note and one watched repository.
fn owner_makes_a_kite(host: &Host, owner: &User) -> Value {
    let sources = json!([{"kind":"jet"},{"kind":"github","repo":"octo/jet","login":"shaun"}]);
    let note = |moved: &str, private: bool| {
        objectives(
            json!({"action":"note","id":1,"status":"on track","moved":moved,"private":private}),
        )
    };
    let results = run_turn(
        host,
        owner,
        "kite",
        "I am building a kite.",
        json!([
            create("new", sources),
            note("The frame is built", false),
            note(PRIVATE_NOTE, true)
        ]),
    );
    data(&results[0])["objective"]["id"].clone()
}

fn owner_proposes(
    host: &Host,
    owner: &User,
    turn: &str,
    objective: &Value,
    people: Value,
    teams: Value,
) -> Value {
    let script = json!([propose(objective, people, teams)]);
    let results = run_turn(host, owner, turn, "Share it.", script);
    data(&results[0])["proposal"].clone()
}

#[test]
fn manager_jet_sees_only_shared_objectives_and_public_notes() {
    let host = host();
    let (owner, manager) = (host.owner(), host.sign_in_as(MANAGER));
    let (owner_id, manager_id) = (user_id(&host, OWNER), user_id(&host, MANAGER));
    let kite = owner_makes_a_kite(&host, &owner);

    let card = owner_proposes(
        &host,
        &owner,
        "propose",
        &kite,
        json!([manager_id]),
        json!([]),
    );
    assert_eq!(card["state"], "proposed");
    assert_eq!(
        card["people"],
        json!([{"id":manager_id,"name":"Admin 123","ticked":true}])
    );
    assert_eq!(
        read_as(&host, &manager, "before-tap", owner_id),
        json!([]),
        "a proposal shares nothing"
    );

    let (status, applied) = tap(&owner, &card, json!([manager_id]), json!([]));
    assert_eq!(
        (status, &applied["state"]),
        (200, &json!("applied")),
        "{applied}"
    );

    let seen = read_as(&host, &manager, "after-tap", owner_id);
    let kite = &seen[0];
    assert_eq!(
        (
            &kite["title"],
            &kite["deliverable"],
            &kite["start"],
            &kite["due"],
            &kite["durationDays"]
        ),
        (
            &json!("Ship the kite"),
            &json!("A kite that flies"),
            &json!("2099-06-01"),
            &json!("2099-07-01"),
            &json!(30)
        )
    );
    assert_eq!(kite["steps"].as_array().unwrap().len(), 2);
    let notes: Vec<&Value> = kite["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|note| &note["moved"])
        .collect();
    assert_eq!(notes, [&json!("The frame is built")]);
    for hidden in [
        PRIVATE_NOTE,
        "chatId",
        "sources",
        "octo/jet",
        "tasks",
        "isPrivate",
    ] {
        assert!(
            !seen.to_string().contains(hidden),
            "{hidden} leaked: {seen}"
        );
    }

    // A note the owner writes afterwards is read at once.
    let note = objectives(
        json!({"action":"note","id":1,"status":"on track","moved":"First flight is booked"}),
    );
    run_turn(
        &host,
        &owner,
        "later-note",
        "Flying it Friday.",
        json!([note]),
    );
    let later = read_as(&host, &manager, "after-note", owner_id);
    assert_eq!(later[0]["notes"].as_array().unwrap().len(), 2, "{later}");
}

#[test]
fn a_team_share_reaches_its_members_and_a_smaller_card_removes_people() {
    let host = host();
    let owner = host.owner();
    let owner_id = user_id(&host, OWNER);
    let (first, second) = (host.sign_in_as(FIRST), host.sign_in_as(SECOND));
    let (outsider, manager) = (host.sign_in_as(OUTSIDER), host.sign_in_as(MANAGER));
    let (team, manager_id) = (commercial(&host), user_id(&host, MANAGER));
    let kite = owner_makes_a_kite(&host, &owner);

    // The card lists the team with its members' names; the tap applies only what is ticked.
    let card = owner_proposes(
        &host,
        &owner,
        "team",
        &kite,
        json!([manager_id]),
        json!([team]),
    );
    assert_eq!(card["teams"][0]["members"], json!(["Admin 1", "Admin 2"]));
    assert_eq!(tap(&owner, &card, json!([]), json!([team])).0, 200);
    for (name, viewer) in [("first", &first), ("second", &second)] {
        assert_eq!(
            read_as(&host, viewer, name, owner_id)[0]["title"],
            "Ship the kite"
        );
    }
    assert_eq!(read_as(&host, &outsider, "outsider", owner_id), json!([]));
    assert_eq!(
        read_as(&host, &manager, "manager", owner_id),
        json!([]),
        "unticked, so not shared"
    );

    // An unshared objective answers like an owner who has none.
    let nobody = user_id(&host, OUTSIDER);
    assert_eq!(read_as(&host, &manager, "empty-owner", nobody), json!([]));

    // A later card with a smaller set shows who goes, and tapping it removes them.
    let smaller = owner_proposes(
        &host,
        &owner,
        "smaller",
        &kite,
        json!([manager_id]),
        json!([]),
    );
    assert_eq!(smaller["teams"][0]["ticked"], false, "{smaller}");
    assert_eq!(tap(&owner, &smaller, json!([manager_id]), json!([])).0, 200);
    assert_eq!(read_as(&host, &first, "first-again", owner_id), json!([]));
    assert_eq!(
        read_as(&host, &manager, "manager-again", owner_id)[0]["title"],
        "Ship the kite"
    );
}

#[test]
fn only_the_owners_tap_on_a_waiting_card_applies() {
    let host = host();
    let (owner, manager) = (host.owner(), host.sign_in_as(MANAGER));
    let (owner_id, manager_id) = (user_id(&host, OWNER), user_id(&host, MANAGER));
    let kite = owner_makes_a_kite(&host, &owner);
    let card = owner_proposes(
        &host,
        &owner,
        "propose",
        &kite,
        json!([manager_id]),
        json!([]),
    );

    let (status, refused) = tap(&manager, &card, json!([manager_id]), json!([]));
    assert_eq!(
        (status, &refused["kind"]),
        (404, &json!("noSuchProposal")),
        "{refused}"
    );
    assert_eq!(
        manager.get(&format!("/api/shares/proposals?ids={}", card["id"])),
        json!([]),
        "another user cannot even read the card"
    );
    let (status, refused) = tap(&owner, &card, json!([owner_id]), json!([]));
    assert_eq!(
        (status, &refused["kind"]),
        (400, &json!("notOnCard")),
        "{refused}"
    );
    assert_eq!(read_as(&host, &manager, "none", owner_id), json!([]));

    assert_eq!(tap(&owner, &card, json!([manager_id]), json!([])).0, 200);
    let (status, again) = tap(&owner, &card, json!([manager_id]), json!([]));
    assert_eq!(
        (status, &again["kind"]),
        (409, &json!("proposalNotOpen")),
        "{again}"
    );

    // Jet cannot name the owner, or an objective that is not the user's, on a card.
    let script = json!([
        propose(&kite, json!([owner_id]), json!([])),
        propose(&json!(999), json!([manager_id]), json!([]))
    ]);
    let results = run_turn(&host, &owner, "bad-cards", "Share it.", script);
    assert_eq!(error_kind(&results[0]), "shareWithOwner");
    assert_eq!(error_kind(&results[1]), "noSuchObjective");
}

#[test]
fn the_next_message_after_a_tap_tells_jet_of_it() {
    let host = host();
    let owner = host.owner();
    let (team, manager_id) = (commercial(&host), user_id(&host, MANAGER));
    let kite = owner_makes_a_kite(&host, &owner);
    let card = owner_proposes(
        &host,
        &owner,
        "propose",
        &kite,
        json!([manager_id]),
        json!([team]),
    );
    assert_eq!(
        tap(&owner, &card, json!([manager_id]), json!([team])).0,
        200
    );
    let prompt = || std::fs::read_to_string(host.dir.path().join("facade-prompt.txt")).unwrap();
    let notice = "[The user tapped Share on the card for \"Ship the kite\": it is now shared with Admin 123 and the Commercial team.]";

    let idle = json!([{"tool":"people_list","arguments":{}}]);
    run_turn(&host, &owner, "after-tap", "Thanks.", idle.clone());
    assert!(prompt().contains(notice), "{}", prompt());
    run_turn(&host, &owner, "after-that", "And again.", idle);
    assert!(
        !prompt().contains("tapped Share"),
        "the tap is told once: {}",
        prompt()
    );
}

#[test]
fn card_shows_applied_shares_after_reload() {
    let host = host();
    let owner = host.owner();
    let (manager_id, team) = (user_id(&host, MANAGER), commercial(&host));
    let kite = owner_makes_a_kite(&host, &owner);
    let card = owner_proposes(
        &host,
        &owner,
        "propose",
        &kite,
        json!([manager_id]),
        json!([team]),
    );
    assert_eq!(tap(&owner, &card, json!([manager_id]), json!([])).0, 200);

    // The thread still holds the card as it was proposed; the read gives it as it is now, also
    // after the host restarts.
    let host = host.restart();
    let owner = host.owner();
    let history = owner.get("/api/snapshot")["history"].clone();
    let cards: Vec<&Value> = history
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|entry| entry["tools"].as_array().into_iter().flatten())
        .filter(|call| call["result"]["proposal"].is_object())
        .collect();
    assert_eq!(cards.len(), 1, "{history}");
    assert_eq!(cards[0]["server"], "jet");
    assert_eq!(cards[0]["tool"], "objectives_update");
    assert_eq!(cards[0]["result"]["proposal"]["id"], card["id"]);
    assert_eq!(cards[0]["result"]["proposal"]["state"], "proposed");
    let shown = owner.get(&format!("/api/shares/proposals?ids={}", card["id"]));
    let card = &shown[0];
    assert_eq!(card["state"], "applied");
    assert_eq!(card["people"][0]["ticked"], true);
    assert_eq!(card["teams"][0]["ticked"], false);
    assert!(card["appliedAt"].is_u64(), "{card}");
}

#[test]
fn people_update_is_for_admins_and_refused_after_outside_text() {
    let host = host();
    let (owner, manager) = (host.owner(), host.sign_in_as(MANAGER));
    let outsider = host.sign_in_as(OUTSIDER);
    let (owner_id, outsider_id) = (user_id(&host, OWNER), user_id(&host, OUTSIDER));
    let team = commercial(&host);
    let kite = owner_makes_a_kite(&host, &owner);
    let card = owner_proposes(&host, &owner, "propose", &kite, json!([]), json!([team]));
    assert_eq!(tap(&owner, &card, json!([]), json!([team])).0, 200);
    let directory =
        |command: Value| json!({"tool":"people_update","arguments":{"command":command}});
    let add = directory(json!({"action":"member_add","team":team,"user":outsider_id}));

    // A user who is not an admin is refused, and nothing changes.
    let results = run_turn(&host, &manager, "not-admin", "Add Admin 3.", json!([add]));
    assert_eq!(error_kind(&results[0]), "adminOnly");
    assert_eq!(read_as(&host, &outsider, "still-out", owner_id), json!([]));

    // After a read of web text, or of a colleague's shared notes, even the admin is refused.
    let web = json!({"fetch": "github.com/anthropics/claude-code"});
    let words = "What is https://github.com/anthropics/claude-code about?";
    let results = run_turn(&host, &owner, "after-web", words, json!([web, add]));
    assert_eq!(error_kind(&results[1]), "writeAfterWebText");
    let script = json!([read_owner(user_id(&host, FIRST)), add]);
    let results = run_turn(&host, &owner, "after-shared", "How is Admin 1?", script);
    assert_eq!(error_kind(&results[1]), "writeAfterWebText");
    let script = json!([
        read_owner(outsider_id),
        propose(&kite, json!([outsider_id]), json!([]))
    ]);
    let results = run_turn(
        &host,
        &owner,
        "share-after-shared",
        "How is Admin 3?",
        script,
    );
    assert_eq!(error_kind(&results[1]), "writeAfterWebText");
    assert_eq!(
        read_as(&host, &outsider, "still-out-2", owner_id),
        json!([])
    );

    // The admin's own turn changes the directory, and the new member sees what the team is given.
    let results = run_turn(
        &host,
        &owner,
        "admin-adds",
        "Add Admin 3 to Commercial.",
        json!([add]),
    );
    assert!(
        data(&results[0])["teams"]
            .to_string()
            .contains(&outsider_id.to_string())
    );
    assert_eq!(
        read_as(&host, &outsider, "now-in", owner_id)[0]["title"],
        "Ship the kite"
    );

    let rename = directory(json!({"action":"team_rename","team":team,"name":"Sales"}));
    let clear = directory(json!({"action":"manager_clear","user":user_id(&host, MANAGER)}));
    let results = run_turn(
        &host,
        &owner,
        "admin-more",
        "Tidy up.",
        json!([rename, clear]),
    );
    assert_eq!(data(&results[0])["teams"][0]["name"], "Sales");
    assert!(data(&results[1])["users"].to_string().contains("Admin 123"));
}

#[test]
fn the_objective_pane_calls_show_change_and_flip() {
    let host = host();
    let owner = host.owner();
    let (owner_id, manager_id) = (user_id(&host, OWNER), user_id(&host, MANAGER));
    owner_makes_a_kite(&host, &owner);

    assert_eq!(
        owner.get("/api/objectives/1/shares"),
        json!({"people":[],"teams":[]})
    );
    let (status, card) = owner.post(
        "/api/objectives/1/share-proposals",
        json!({"people":[manager_id]}),
    );
    assert_eq!(
        (status, &card["state"]),
        (200, &json!("proposed")),
        "{card}"
    );
    assert_eq!(tap(&owner, &card, json!([manager_id]), json!([])).0, 200);
    assert_eq!(
        owner.get("/api/objectives/1/shares")["people"][0]["name"],
        "Admin 123"
    );

    // Deleting the chat that holds the card moves the card, with its objective, to the main chat.
    let chat_of_card = || -> i64 {
        database(&host)
            .query_row("SELECT chat_id FROM share_proposals", [], |row| row.get(0))
            .unwrap()
    };
    let chat = chat_of_card();
    assert_eq!(host.delete(&format!("/api/chats/{chat}")), 200);
    assert_ne!(chat_of_card(), chat);

    // A note the owner flips to shared is read by the manager; flipping it back hides it.
    let note: i64 = database(&host)
        .query_row(
            "SELECT id FROM objective_notes WHERE is_private = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let manager = host.sign_in_as(MANAGER);
    let path = format!("/api/objectives/1/notes/{note}");
    assert_eq!(owner.put(&path, json!({"private":false})).0, 200);
    let seen = read_as(&host, &manager, "flipped", owner_id);
    assert!(seen.to_string().contains(PRIVATE_NOTE), "{seen}");
    assert_eq!(owner.put(&path, json!({"private":true})).0, 200);
    let hidden = read_as(&host, &manager, "flipped-back", owner_id);
    assert!(!hidden.to_string().contains(PRIVATE_NOTE));
    assert_eq!(manager.put(&path, json!({"private":false})).0, 404);
}
