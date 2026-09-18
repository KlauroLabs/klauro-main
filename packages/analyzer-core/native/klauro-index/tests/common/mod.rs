use std::io::Cursor;
use std::path::PathBuf;
use std::process::Command;

use serde_json::{Map, Value};

/// The index as the product's own typed reader sees it. The emitted form interns every string
/// into a table, and a reader without the schema cannot always tell an index from a count —
/// `exits` is a list of exit points under ICELOT and a number under a unit's metrics. Tests
/// have no schema, so they ask for the uninterned form. `the_interned_form_carries_the_same_
/// strings` in tests/wire.rs keeps the two honest.
pub fn read(fixture: &str) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(fixture);
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_klauro-index"));
    let output = Command::new(binary)
        .arg(&root)
        .env("KLAURO_UNINTERNED", "1")
        .output()
        .expect("index runs");
    let mut stream = Cursor::new(output.stdout);
    let body = rmpv::decode::read_value(&mut stream).expect("index emits an index");
    plain(&body)
}

fn plain(value: &rmpv::Value) -> Value {
    match value {
        rmpv::Value::Nil => Value::Null,
        rmpv::Value::Boolean(found) => Value::Bool(*found),
        rmpv::Value::Integer(found) => match found.as_i64() {
            Some(found) => Value::from(found),
            None => Value::from(found.as_u64().unwrap_or_default()),
        },
        rmpv::Value::F32(found) => Value::from(*found),
        rmpv::Value::F64(found) => Value::from(*found),
        rmpv::Value::String(found) => Value::String(found.as_str().unwrap_or_default().to_string()),
        rmpv::Value::Binary(found) => Value::from(found.len()),
        rmpv::Value::Array(found) => Value::Array(found.iter().map(plain).collect()),
        rmpv::Value::Map(found) => {
            let mut map = Map::new();
            for (key, value) in found {
                map.insert(key.as_str().unwrap_or_default().to_string(), plain(value));
            }
            Value::Object(map)
        }
        rmpv::Value::Ext(_, found) => Value::from(found.len()),
    }
}
