//! The hosts a chat turn may read pages on: only those of links the user wrote in this chat, so
//! neither a page nor Jet itself can name a site that the user's data is sent to.

use std::collections::BTreeSet;

use crate::chat::{Entry, Role};

/// The hosts of every web link in the user's messages, sorted, each once.
pub(super) fn linked_hosts(entries: &[Entry]) -> Vec<String> {
    let users = entries.iter().filter(|entry| entry.role == Role::User);
    let hosts: BTreeSet<String> = users.flat_map(|entry| hosts_in(&entry.text)).collect();
    hosts.into_iter().collect()
}

/// Hosts are kept only when they are plain names, because the provider reads the list as text
/// split on commas.
fn hosts_in(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| c.is_whitespace() || "<>()[]{}\"'`".contains(c))
        .filter_map(|word| {
            let start = word.find("https://").or_else(|| word.find("http://"))?;
            let link = word[start..].trim_end_matches(['.', ',', ';', ':', '!', '?']);
            let host = url::Url::parse(link).ok()?.host_str()?.to_ascii_lowercase();
            let plain = |c: char| c.is_ascii_alphanumeric() || c == '.' || c == '-';
            host.chars().all(plain).then_some(host)
        })
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{Chat, message};
    use crate::turn::scripted::{Script, Scripted, reply_lines};

    #[test]
    fn the_host_list_holds_only_links_the_user_wrote_in_this_chat() {
        let scripted = Scripted::new()
            .then(Script::lines(reply_lines("s1", "mood: neutral\nok")))
            .then(Script::lines(reply_lines(
                "s2",
                "mood: neutral\nTry https://jet-said.example/page",
            )))
            .then(Script::lines(reply_lines("s3", "mood: neutral\nok")));
        let chat = Chat::with_transport(scripted);
        chat.send(message("an older chat: https://older-chat.example/x"));
        chat.conversation.forget().unwrap();
        chat.send(message("where can I read about it?"));
        chat.send(message(
            "Look at https://GitHub.com/anthropics, (https://docs.rs/serde). and http://user:pw@a,b.example/",
        ));

        let requests = chat.requests();
        assert_eq!(requests[1].hosts, Vec::<String>::new());
        assert_eq!(requests[2].hosts, ["docs.rs", "github.com"]);
    }
}
