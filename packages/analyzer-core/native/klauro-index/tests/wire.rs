use std::collections::BTreeSet;
use std::io::Cursor;
use std::path::PathBuf;
use std::process::Command;

fn emitted(fixture: &str, uninterned: bool) -> Vec<u8> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(fixture);
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_klauro-index"));
    let mut command = Command::new(binary);
    command.arg(&root);
    if uninterned {
        command.env("KLAURO_UNINTERNED", "1");
    }
    command.output().expect("index runs").stdout
}

fn strings_in(value: &rmpv::Value, found: &mut BTreeSet<String>) {
    match value {
        rmpv::Value::String(text) => {
            found.insert(text.as_str().unwrap_or_default().to_string());
        }
        rmpv::Value::Array(items) => items.iter().for_each(|item| strings_in(item, found)),
        rmpv::Value::Map(entries) => {
            for (key, item) in entries {
                strings_in(key, found);
                strings_in(item, found);
            }
        }
        _ => {}
    }
}

fn shape(value: &rmpv::Value) -> (usize, usize, usize) {
    match value {
        rmpv::Value::Array(items) => {
            items.iter().fold((1, 0, items.len()), |total, item| {
                let part = shape(item);
                (total.0 + part.0, total.1 + part.1, total.2 + part.2)
            })
        }
        rmpv::Value::Map(entries) => {
            entries.iter().fold((0, 1, entries.len()), |total, (key, item)| {
                let key = shape(key);
                let part = shape(item);
                (total.0 + key.0 + part.0, total.1 + key.1 + part.1, total.2 + key.2 + part.2)
            })
        }
        _ => (0, 0, 0),
    }
}

/// Tests read the uninterned index because they have no schema. This keeps the emitted form
/// honest about carrying the same content: every string reachable in one is in the other, and
/// the two have the same structure.
#[test]
fn the_interned_form_carries_the_same_strings_and_shape() {
    let mut stream = Cursor::new(emitted("icelot", false));
    let table = rmpv::decode::read_value(&mut stream).expect("a string table");
    let body = rmpv::decode::read_value(&mut stream).expect("an index");
    let mut interned: BTreeSet<String> = BTreeSet::new();
    strings_in(&table, &mut interned);

    let plain = rmpv::decode::read_value(&mut Cursor::new(emitted("icelot", true)))
        .expect("an uninterned index");
    let mut written: BTreeSet<String> = BTreeSet::new();
    strings_in(&plain, &mut written);

    let missing: Vec<&String> = written.difference(&interned).collect();
    assert!(missing.is_empty(), "these strings never reached the table: {missing:?}");
    assert_eq!(shape(&body), shape(&plain), "the two forms describe different structures");
}
