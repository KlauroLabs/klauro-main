use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Kept<T> {
    digest: String,
    held: T,
}

fn at(kind: &str, key: &str) -> Option<std::path::PathBuf> {
    let folder = crate::jev::kept()?.parent()?.join("memory").join(kind);
    std::fs::create_dir_all(&folder).ok()?;
    Some(folder.join(format!("{}.json", crate::jev::named(key))))
}

pub(crate) fn recalled<T: DeserializeOwned>(kind: &str, key: &str) -> Option<T> {
    if crate::jev::afresh() {
        return None;
    }
    serde_json::from_str(&std::fs::read_to_string(at(kind, key)?).ok()?).ok()
}

pub(crate) fn keep<T: Serialize>(kind: &str, key: &str, held: &T) {
    let Some(at) = at(kind, key) else { return };
    if let Ok(text) = serde_json::to_string(held) {
        let _ = std::fs::write(at, text);
    }
}

fn last_of(kind: &str) -> String {
    format!("{kind} last")
}

pub(crate) fn last<T: DeserializeOwned>(kind: &str, context: &str, id: &str) -> Option<T> {
    recalled::<Kept<T>>(&last_of(kind), id).filter(|kept| kept.digest == crate::jev::named(context)).map(|kept| kept.held)
}

fn keep_last<T: Serialize>(kind: &str, context: &str, id: &str, held: &T) {
    keep(&last_of(kind), id, &Kept { digest: crate::jev::named(context), held });
}

pub(crate) fn unless_changed<T: Serialize + DeserializeOwned>(
    kind: &str,
    key: &str,
    digest: &str,
    make: impl FnOnce() -> Option<T>,
) -> Option<T> {
    if let Some(kept) = recalled::<Kept<T>>(kind, key).filter(|kept| kept.digest == digest) {
        return Some(kept.held);
    }
    let held = make()?;
    if crate::author::asked() {
        keep(kind, key, &Kept { digest: digest.to_string(), held: &held });
    }
    Some(held)
}

pub(crate) fn each<T: Serialize + DeserializeOwned>(
    kind: &str,
    context: &str,
    items: &[(String, String)],
    ask: impl FnOnce(&[(String, String)]) -> std::collections::BTreeMap<String, T>,
) -> std::collections::BTreeMap<String, T> {
    each_holding(kind, context, items, |_, _| true, ask)
}

pub(crate) fn each_holding<T: Serialize + DeserializeOwned>(
    kind: &str,
    context: &str,
    items: &[(String, String)],
    holds: impl Fn(&str, &T) -> bool,
    ask: impl FnOnce(&[(String, String)]) -> std::collections::BTreeMap<String, T>,
) -> std::collections::BTreeMap<String, T> {
    let keyed = |told: &str| format!("{context}\u{1}{told}");
    let mut known = std::collections::BTreeMap::new();
    let mut missing: Vec<(String, String)> = Vec::new();
    for (id, told) in items {
        match recalled::<T>(kind, &keyed(told)).filter(|held| holds(id, held)) {
            Some(held) => {
                keep_last(kind, context, id, &held);
                known.insert(id.clone(), held);
            }
            None => missing.push((id.clone(), told.clone())),
        }
    }
    if missing.is_empty() {
        return known;
    }
    let mut answered = ask(&missing);
    for (id, told) in &missing {
        if let Some(held) = answered.remove(id) {
            if crate::author::asked() {
                keep(kind, &keyed(told), &held);
                keep_last(kind, context, id, &held);
            }
            known.insert(id.clone(), held);
        }
    }
    known
}

pub(crate) fn in_magnitudes(text: &str) -> String {
    let mut held = String::new();
    let mut digits = String::new();
    let flush = |digits: &mut String, held: &mut String| {
        if !digits.is_empty() {
            held.push_str(&format!("~1e{}", digits.trim_start_matches('0').len().saturating_sub(1)));
            digits.clear();
        }
    };
    for letter in text.chars() {
        match letter.is_ascii_digit() {
            true => digits.push(letter),
            false => {
                flush(&mut digits, &mut held);
                held.push(letter);
            }
        }
    }
    flush(&mut digits, &mut held);
    held
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_count_is_kept_only_to_its_order_of_magnitude() {
        assert_eq!(in_magnitudes("serves 334 requests"), in_magnitudes("serves 335 requests"));
        assert_ne!(in_magnitudes("serves 34 requests"), in_magnitudes("serves 334 requests"));
        assert_eq!(in_magnitudes("1996 files, 8376 declarations"), "~1e3 files, ~1e3 declarations");
    }
}
