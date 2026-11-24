//! The hosts a chat turn may read pages on: those of links the user wrote in this chat and of the
//! web page sources of the chat's objective. Jet records those sources, so the only thing between a
//! page Jet read and a new host is the persona's rule to record only after the user says yes.

use std::collections::BTreeSet;

use crate::chat::{Entry, Role};

/// The hosts of every web link in the user's messages, with the hosts of the objective's pages,
/// sorted, each once.
pub(super) fn linked_hosts(entries: &[Entry], pages: &[String]) -> Vec<String> {
    let users = entries.iter().filter(|entry| entry.role == Role::User);
    let mut hosts: BTreeSet<String> = users.flat_map(|entry| hosts_in(&entry.text)).collect();
    hosts.extend(pages.iter().filter(|host| is_plain(host)).cloned());
    hosts.into_iter().collect()
}

/// Hosts are kept only when they are plain names, because the provider reads the list as text
/// split on commas.
fn is_plain(host: &str) -> bool {
    host.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// The host of each link in the text, written with `https://` or without it, as `docs.rs/serde`.
fn hosts_in(text: &str) -> impl Iterator<Item = String> + '_ {
    let with_scheme = text
        .split(|c: char| c.is_whitespace() || "<>()[]{}\"'`".contains(c))
        .filter_map(|word| {
            let start = word.find("https://").or_else(|| word.find("http://"))?;
            let link = word[start..].trim_end_matches(['.', ',', ';', ':', '!', '?']);
            let host = url::Url::parse(link).ok()?.host_str()?.to_owned();
            is_plain(&host).then_some(host)
        });
    with_scheme.chain(text.split_whitespace().filter_map(bare_host))
}

/// The host of a word like `docs.rs/serde`: it must start like a site and end like one, so that
/// `v1.2.3`, an email address or a quoted script does not count.
fn bare_host(word: &str) -> Option<String> {
    let word = word
        .trim_matches(|c| "([{<\"'`".contains(c))
        .trim_end_matches(|c| ".,;:!?)]}>\"'`".contains(c));
    let host = word.split(['/', '?', '#']).next()?;
    let ends_like_site = host
        .rsplit_once('.')
        .is_some_and(|(_, tld)| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()));
    if !(ends_like_site && is_plain(host)) {
        return None;
    }
    let parsed = url::Url::parse(&format!("https://{word}")).ok()?;
    Some(parsed.host_str()?.to_owned())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{Chat, message};
    use super::linked_hosts;
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

    #[test]
    fn a_link_without_https_adds_its_host() {
        let said = "docs.rs/serde, (crates.io) and v1.2.3 or me@mail.example";
        let entries = [crate::NewEntry::user_text(said).into_entry(1, 0)];
        assert_eq!(linked_hosts(&entries, &[]), ["crates.io", "docs.rs"]);
        assert_eq!(linked_hosts(&[], &["a,b".into()]), Vec::<String>::new());
        assert_eq!(
            linked_hosts(&[], &["pages.example".into()]),
            ["pages.example"]
        );
    }
}
