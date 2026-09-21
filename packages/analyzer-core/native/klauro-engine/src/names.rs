
pub fn leaf(name: &str) -> &str {
    let mut at = 0;
    let bytes = name.as_bytes();
    for (position, byte) in bytes.iter().enumerate() {
        match byte {
            b'.' => at = position + 1,
            b':' if bytes.get(position + 1) == Some(&b':') => at = position + 2,
            _ => {}
        }
    }
    &name[at.min(name.len())..]
}

pub fn root(receiver: &str) -> &str {
    let end = receiver.find(['.', '[', '(', ' ', '-']).unwrap_or(receiver.len());
    &receiver[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_read_the_same_however_it_is_qualified() {
        assert_eq!(leaf("app.Session.open"), "open");
        assert_eq!(leaf("app::Session::open"), "open");
        assert_eq!(leaf("open"), "open");
        assert_eq!(leaf(""), "");
    }

    #[test]
    fn a_receiver_starts_from_its_first_segment() {
        assert_eq!(root("this.client.Do"), "this");
        assert_eq!(root("session.query(Tag)"), "session");
        assert_eq!(root("values"), "values");
    }
}

pub fn spoken_as(declared: &str) -> String {
    let mut held = String::new();
    let mut previous = '\0';
    for letter in declared.chars() {
        if letter == '_' || letter == '-' || letter == '.' {
            held.push(' ');
            previous = ' ';
            continue;
        }
        if letter.is_uppercase() && !held.is_empty() && previous != ' ' && !previous.is_uppercase() {
            held.push(' ');
        }
        held.push(letter);
        previous = letter;
    }
    let held = held.trim();
    let mut spoken = String::with_capacity(held.len());
    for (at, letter) in held.chars().enumerate() {
        match at {
            0 => spoken.extend(letter.to_uppercase()),
            _ => match letter.is_uppercase() && held.chars().nth(at + 1).is_some_and(char::is_uppercase) {
                true => spoken.push(letter),
                false => spoken.extend(letter.to_lowercase()),
            },
        }
    }
    spoken
}

#[cfg(test)]
mod spoken {
    use super::spoken_as;

    #[test]
    fn a_record_is_spoken_as_its_declared_name_reads() {
        assert_eq!(spoken_as("AddressBookSubscription"), "Address book subscription");
        assert_eq!(spoken_as("ContactImportantDateType"), "Contact important date type");
        assert_eq!(spoken_as("life_event"), "Life event");
        assert_eq!(spoken_as("Call"), "Call");
        assert_eq!(spoken_as("booking"), "Booking");
    }
}
