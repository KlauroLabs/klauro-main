static DISCRIMINANTS: &[&str] = &["action", "cmd", "command", "event", "intent", "kind", "msg", "op", "t", "type"];

static DISCRIMINANT_ENDINGS: &[&str] = &["_kind", "_tag", "_type", "Kind", "Tag", "Type"];

static DELIVERING: &[&str] = &[
    "broadcast", "emit", "notify", "post", "publish", "reply", "request", "respond", "send",
];

const LONGEST_TAG: usize = 48;

pub fn a_delivery(callee: &str) -> bool {
    let named = crate::names::leaf(callee).to_ascii_lowercase();
    DELIVERING.iter().any(|verb| named.contains(verb))
}

pub fn a_discriminant(word: &str) -> bool {
    DISCRIMINANTS.contains(&word) || DISCRIMINANT_ENDINGS.iter().any(|ending| word.len() > ending.len() && word.ends_with(ending))
}

pub fn a_tag(written: &str) -> Option<&str> {
    let tag = written.trim();
    let plain = !tag.is_empty()
        && tag.len() <= LONGEST_TAG
        && tag.chars().all(|letter| letter.is_alphanumeric() || matches!(letter, '.' | ':' | '-' | '_' | '/'));
    plain.then_some(tag)
}

pub fn the_discriminant_in(subject: &str) -> bool {
    subject
        .split(|letter: char| !(letter.is_alphanumeric() || letter == '_'))
        .any(a_discriminant)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_discriminant_is_named_for_the_field_a_message_is_told_apart_by() {
        assert!(a_discriminant("t"));
        assert!(a_discriminant("type"));
        assert!(a_discriminant("intent_type"));
        assert!(a_discriminant("messageType"));
        assert!(!a_discriminant("name"));
        assert!(!a_discriminant("_type"));
    }

    #[test]
    fn a_call_delivers_when_its_name_says_it_sends_something_away() {
        assert!(a_delivery("this.sendFrame"));
        assert!(a_delivery("relay_send"));
        assert!(a_delivery("client.request"));
        assert!(!a_delivery("render"));
    }

    #[test]
    fn a_tag_is_a_short_plain_word_and_never_a_sentence() {
        assert_eq!(a_tag(" file.offer "), Some("file.offer"));
        assert_eq!(a_tag("session.create"), Some("session.create"));
        assert_eq!(a_tag("a whole sentence"), None);
        assert_eq!(a_tag(""), None);
    }

    #[test]
    fn a_subject_names_a_discriminant_through_any_of_its_words() {
        assert!(the_discriminant_in("f.get(\"t\").and_then(Value::as_str).unwrap_or(\"\")"));
        assert!(the_discriminant_in("intent_type"));
        assert!(!the_discriminant_in("channel.as_str()"));
    }
}
