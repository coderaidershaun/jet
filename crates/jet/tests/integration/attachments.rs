//! Prove an attached file reaches Jet as details only, is read through the real reader process
//! on request, and that hostile or unsent files are kept away from the model and the server.
use super::support::{Host, host, request, wait_file};
use serde_json::{Value, json};
use std::io::Cursor;

const SHEET: &[u8] = include_bytes!("../fixtures/uploads/sheet.xlsx");
const STRINGS: &[u8] = include_bytes!("../fixtures/uploads/strings.xlsx");
const SHEET_DETAILS: &str = "2 sheets: Prices 4 × 3, Notes 2 × 1";

/// Picture noise from a small xorshift, so the JPEG Jet is sent is far over one pipe buffer.
fn noisy_png(width: u32, height: u32) -> Vec<u8> {
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    let pixels: Vec<u8> = (0..width * height * 3)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect();
    let mut bytes = Vec::new();
    image::RgbImage::from_raw(width, height, pixels)
        .unwrap()
        .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .unwrap();
    bytes
}

fn send_with_files(host: &Host, id: &str, text: &str, files: &[&str]) -> (u16, Value) {
    let mut message = request(id);
    message["text"] = json!(text);
    message["attachments"] = json!(files);
    message["feeling"] = Value::Null;
    host.post("/api/chat/send", message)
}

fn settled(host: &Host, entries: usize) -> Value {
    host.until(|value| {
        value["active"].is_null()
            && value["history"]
                .as_array()
                .is_some_and(|history| history.len() == entries)
    })
}

fn prompt(host: &Host) -> String {
    std::fs::read_to_string(host.dir.path().join("facade-prompt.txt")).unwrap()
}

fn fetch(host: &Host, path: &str) -> (u16, String, String, Vec<u8>) {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent.get(format!("{}{path}", host.url)).call().unwrap();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .map(|value| value.to_str().unwrap().to_owned())
            .unwrap_or_default()
    };
    let (content_type, policy, nosniff) = (
        header("content-type"),
        header("content-security-policy"),
        header("x-content-type-options"),
    );
    assert_eq!(nosniff, "nosniff", "{path}");
    let status = response.status().as_u16();
    (
        status,
        content_type,
        policy,
        response.body_mut().read_to_vec().unwrap(),
    )
}

#[test]
fn attached_files_reach_jet_as_details_and_are_read_on_request() {
    let host = host();
    let picture = noisy_png(640, 480);

    let (status, sheet) = host.upload("sheet.xlsx", SHEET);
    assert_eq!(status, 200, "{sheet}");
    assert_eq!(sheet["details"], SHEET_DETAILS);
    assert_eq!(sheet["attached"], false);
    let (status, png) = host.upload("noise.png", &picture);
    assert_eq!(status, 200, "{png}");
    assert_eq!(png["details"], "640 × 480 px");
    let (status, draft) = host.upload("draft.txt", b"not sent yet\n");
    assert_eq!(status, 200, "{draft}");
    let (sheet_id, png_id, draft_id) = (
        sheet["id"].as_str().unwrap().to_owned(),
        png["id"].as_str().unwrap().to_owned(),
        draft["id"].as_str().unwrap().to_owned(),
    );

    assert_eq!(host.upload("bad.exe", b"MZ\x90\x00").0, 415);
    assert_eq!(
        host.upload("fake.png", b"this is only text").0,
        415,
        "the first bytes must match the extension"
    );
    let (status, refused) = host.upload("big.txt", &vec![b'x'; 32 * 1024 * 1024 + 1]);
    assert_eq!(status, 413, "{refused}");
    assert_eq!(refused["message"], "“big.txt” is over 32 MB.");
    let (status, refused) = host.upload("strings.xlsx", STRINGS);
    assert_eq!(status, 415, "{refused}");
    assert_eq!(refused["message"], "Jet couldn't read “strings.xlsx”.");
    assert!(
        host.get("/api/status")["program"].is_object(),
        "a workbook built to exhaust memory must leave the server answering"
    );

    let (status, _, policy, body) = fetch(&host, &format!("/api/files/{png_id}/view"));
    assert_eq!(status, 200);
    assert!(policy.contains("sandbox"), "{policy}");
    assert_eq!(body, picture, "an upload is served back as it was sent");
    let (status, content_type, _, _) = fetch(&host, &format!("/api/files/{sheet_id}"));
    assert_eq!(status, 200);
    assert_eq!(
        content_type,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    let strangers: Vec<String> = (0..11).map(|_| uuid::Uuid::new_v4().to_string()).collect();
    let refs: Vec<&str> = strangers.iter().map(String::as_str).collect();
    assert_eq!(send_with_files(&host, "too-many", "hi", &refs).0, 400);

    let script = json!([
        {"tool":"files_list"},
        {"tool":"files_read","arguments":{"id":sheet_id}},
        {"tool":"files_read","arguments":{"id":png_id}},
        {"tool":"files_read","arguments":{"id":draft_id}}
    ]);
    let (status, accepted) = send_with_files(
        &host,
        "with-files",
        &format!("facade:{script}"),
        &[&sheet_id, &png_id],
    );
    assert_eq!(status, 200, "{accepted}");
    let snapshot = settled(&host, 2);
    assert_eq!(snapshot["history"][1]["status"], "complete", "{snapshot}");

    let attached = &snapshot["history"][0]["attachments"];
    assert_eq!(attached.as_array().unwrap().len(), 2, "{attached}");
    assert_eq!(attached[0]["id"], sheet_id);
    assert_eq!(attached[0]["details"], SHEET_DETAILS);
    assert_eq!(attached[1]["details"], "640 × 480 px");
    let told = prompt(&host);
    for detail in [
        "sheet.xlsx",
        SHEET_DETAILS,
        "noise.png",
        "640 × 480 px",
        "files_read",
    ] {
        assert!(told.contains(detail), "{detail} is missing from: {told}");
    }
    assert!(
        !told.contains("ACME") && !told.contains("101.5"),
        "Jet is sent details, never contents: {told}"
    );

    let results = wait_file(&host, "facade-results.json");
    let listed: Vec<&str> = results[0]["structuredContent"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["id"].as_str().unwrap())
        .collect();
    assert_eq!(listed.len(), 2, "{results}");
    assert!(listed.contains(&sheet_id.as_str()) && listed.contains(&png_id.as_str()));
    assert!(
        !listed.contains(&draft_id.as_str()),
        "an upload that was never sent is invisible to Jet"
    );
    let rows = &results[1]["structuredContent"];
    assert_eq!(rows["unit"], "rows", "{rows}");
    assert!(rows["text"].as_str().unwrap().contains("ACME,101.5,12"));
    assert_eq!(rows["sheets"], json!(["Prices", "Notes"]));
    let blocks = results[2]["content"].as_array().unwrap();
    assert_eq!(blocks[0]["type"], "image");
    assert_eq!(blocks[0]["mimeType"], "image/jpeg");
    assert!(
        blocks[0]["data"].as_str().unwrap().len() > 65_536,
        "the picture is bigger than one pipe buffer, so the reader pipe is proven"
    );
    assert!(results[2]["structuredContent"].is_null());
    assert_eq!(results[3]["isError"], true, "{}", results[3]);

    let saved = &snapshot["history"][1]["tools"][2]["result"];
    assert_eq!(saved["mime"], "image/jpeg", "{saved}");
    assert_eq!(saved["width"], 640);
    assert!(
        saved.get("data").is_none(),
        "picture bytes stay out of the transcript"
    );
    let transcript = std::fs::read_to_string(host.dir.path().join("transcript.jsonl")).unwrap();
    assert!(!transcript.contains(&blocks[0]["data"].as_str().unwrap()[..200]));

    let (status, accepted) = send_with_files(&host, "files-alone", "", &[&png_id]);
    assert_eq!(status, 200, "{accepted}");
    let snapshot = settled(&host, 4);
    assert_eq!(snapshot["history"][2]["text"], "");
    assert_eq!(snapshot["history"][2]["attachments"][0]["id"], png_id);
    // The stand-in fails this reply, so Jet starts a fresh conversation and sends it again, and
    // then the time line comes first.
    let told = prompt(&host);
    let told = told.strip_prefix("[local time: Friday]\n").unwrap_or(&told);
    assert!(
        told.starts_with("[Attached files: only these details are shown;"),
        "a message of files alone is the details block alone: {told}"
    );
    assert_eq!(told.trim_end().lines().count(), 2, "{told}");

    assert_eq!(host.delete(&format!("/api/files/{draft_id}")), 204);
    assert_eq!(
        send_with_files(&host, "gone", "", &[&draft_id]).0,
        400,
        "a deleted upload cannot be sent"
    );
    assert_eq!(
        host.delete(&format!("/api/files/{sheet_id}")),
        404,
        "a file that was sent is not deleted"
    );
    assert_eq!(host.post("/api/chat/forget", json!({})).0, 200);
    assert!(!host.dir.path().join("files").exists());
}
