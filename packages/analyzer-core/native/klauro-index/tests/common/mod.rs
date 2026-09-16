use std::io::Cursor;
use std::path::PathBuf;
use std::process::Command;

use serde_json::{Map, Value};

const TEXT: &[&str] = &[
    "annotation", "at", "bundled_into", "callback_of", "callee", "caller", "category",
    "composition", "constructed", "declared_by", "default_value", "documentation", "entry_point",
    "from", "from_call", "handler", "id", "imported", "kind", "label", "language", "local",
    "method", "name", "node", "operation", "parent", "path", "project", "reason", "receiver",
    "reexport_from", "registrar", "registration_label", "return_type", "role", "root", "runs",
    "shape", "source", "specifier", "target", "type_annotation", "unit", "value",
];

const TEXT_LISTS: &[&str] = &[
    "categories", "consumed_by", "exits", "literals", "members", "nested_repositories",
    "projects", "reaches", "reads", "ships", "ships_in", "skipped_directories", "throws",
    "type_parameters", "types", "writes",
];

pub fn read(fixture: &str) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(fixture);
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_klauro-index"));
    let output = Command::new(binary).arg(&root).output().expect("index runs");
    let mut stream = Cursor::new(output.stdout);
    let table = rmpv::decode::read_value(&mut stream).expect("index emits a string table");
    let body = rmpv::decode::read_value(&mut stream).expect("index emits an index");
    let strings: Vec<String> = table
        .as_array()
        .expect("the table is an array")
        .iter()
        .map(|value| value.as_str().expect("the table holds strings").to_string())
        .collect();
    rehydrate(&body, &strings, false)
}

fn rehydrate(value: &rmpv::Value, strings: &[String], text: bool) -> Value {
    match value {
        rmpv::Value::Nil => Value::Null,
        rmpv::Value::Boolean(flag) => Value::Bool(*flag),
        rmpv::Value::Integer(number) => {
            let index = number.as_u64().unwrap_or_default() as usize;
            match text {
                true => Value::String(strings[index].clone()),
                false => Value::Number(number.as_i64().unwrap_or_default().into()),
            }
        }
        rmpv::Value::F32(number) => serde_json::json!(number),
        rmpv::Value::F64(number) => serde_json::json!(number),
        rmpv::Value::String(word) => Value::String(word.as_str().unwrap_or_default().to_string()),
        rmpv::Value::Array(items) => {
            Value::Array(items.iter().map(|item| rehydrate(item, strings, text)).collect())
        }
        rmpv::Value::Map(pairs) => {
            let mut fields = Map::new();
            for (key, value) in pairs {
                let name = match key {
                    rmpv::Value::Integer(number) => {
                        strings[number.as_u64().unwrap_or_default() as usize].clone()
                    }
                    other => other.as_str().unwrap_or_default().to_string(),
                };
                let text = match value {
                    rmpv::Value::Array(_) => TEXT_LISTS.contains(&name.as_str()),
                    _ => TEXT.contains(&name.as_str()),
                };
                fields.insert(name, rehydrate(value, strings, text));
            }
            Value::Object(fields)
        }
        rmpv::Value::Binary(_) | rmpv::Value::Ext(_, _) => Value::Null,
    }
}
