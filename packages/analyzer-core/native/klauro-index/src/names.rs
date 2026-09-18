
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
