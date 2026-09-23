mod common;

use std::path::{Path, PathBuf};

use serde_json::Value;

fn manifests() -> Vec<(String, Value)> {
    let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/missed");
    let Ok(held) = std::fs::read_dir(&folder) else { return Vec::new() };
    let mut found: Vec<(String, Value)> = held
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|held| held == "json"))
        .filter_map(|path| {
            let text = std::fs::read_to_string(&path).ok()?;
            let named = path.file_stem()?.to_str()?.to_string();
            Some((named, serde_json::from_str(&text).ok()?))
        })
        .collect();
    found.sort_by(|left, right| left.0.cmp(&right.0));
    found
}

fn at<'a>(index: &'a Value, dotted: &str) -> Option<&'a Vec<Value>> {
    let mut held = index;
    for step in dotted.split('.') {
        held = held.get(step)?;
    }
    held.as_array()
}

fn carries(held: &Value, has: &Value) -> bool {
    has.as_object().is_some_and(|wanted| {
        wanted.iter().all(|(key, value)| {
            held.get(key).is_some_and(|found| match (found, value) {
                (Value::String(found), Value::String(value)) => found == value,
                _ => found == value,
            })
        })
    })
}

fn holds(class: &str, expect: &Value) -> bool {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/missed").join(class);
    if !Path::new(&root).exists() {
        return false;
    }
    let index = common::read(&format!("missed/{class}"));
    let Some(dotted) = expect.get("at").and_then(Value::as_str) else { return false };
    let Some(has) = expect.get("has") else { return false };
    at(&index, dotted).is_some_and(|held| held.iter().any(|found| carries(found, has)))
}

#[test]
fn what_the_reader_once_missed_it_still_sees() {
    let mut broken = Vec::new();
    for (class, manifest) in manifests() {
        if manifest.get("state").and_then(Value::as_str) != Some("accepted") {
            continue;
        }
        let Some(expect) = manifest.get("expect") else { continue };
        if !holds(&class, expect) {
            broken.push(format!(
                "{class}: {}",
                manifest.get("claim").and_then(Value::as_str).unwrap_or("")
            ));
        }
    }
    assert!(broken.is_empty(), "the reader stopped seeing what it once saw:\n  {}", broken.join("\n  "));
}

#[test]
fn what_is_still_missed_is_reported_and_what_is_no_longer_missed_is_ready() {
    let mut missing = Vec::new();
    let mut ready = Vec::new();
    for (class, manifest) in manifests() {
        if manifest.get("state").and_then(Value::as_str) != Some("pending") {
            continue;
        }
        let Some(expect) = manifest.get("expect") else { continue };
        let claim = manifest.get("claim").and_then(Value::as_str).unwrap_or("");
        let found_in = manifest.get("found_in").and_then(Value::as_str).unwrap_or("");
        match holds(&class, expect) {
            true => ready.push(format!("{class}: {claim}")),
            false => missing.push(format!("{class}: {claim}  (seen at {found_in})")),
        }
    }
    if !missing.is_empty() {
        println!("still missed, waiting on the engine:\n  {}", missing.join("\n  "));
    }
    if !ready.is_empty() {
        println!("no longer missed, promote to accepted:\n  {}", ready.join("\n  "));
    }
}
