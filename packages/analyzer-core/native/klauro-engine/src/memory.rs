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
    let keyed = |told: &str| format!("{context}\u{1}{told}");
    let mut known = std::collections::BTreeMap::new();
    let mut missing: Vec<(String, String)> = Vec::new();
    for (id, told) in items {
        match recalled::<T>(kind, &keyed(told)) {
            Some(held) => {
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
            }
            known.insert(id.clone(), held);
        }
    }
    known
}
