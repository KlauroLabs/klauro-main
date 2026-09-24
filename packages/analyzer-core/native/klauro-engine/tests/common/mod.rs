#![allow(dead_code)]

use std::io::Cursor;
use std::path::PathBuf;
use std::process::Command;

use serde_json::{Map, Value};

pub fn rehydrate_stream(stdout: &[u8]) -> Value {
    let mut stream = Cursor::new(stdout.to_vec());
    let table = rmpv::decode::read_value(&mut stream).expect("index emits a string table");
    let body = rmpv::decode::read_value(&mut stream).expect("index emits an index");
    spoken(&body, &symbols(&table))
}

pub fn read(fixture: &str) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(fixture);
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_klauro-engine"));
    let output = Command::new(binary).arg(&root).output().expect("index runs");
    rehydrate_stream(&output.stdout)
}

fn symbols(table: &rmpv::Value) -> Vec<String> {
    table
        .as_array()
        .expect("the table is an array")
        .iter()
        .map(|value| value.as_str().expect("the table holds strings").to_string())
        .collect()
}

fn spoken(value: &rmpv::Value, symbols: &[String]) -> Value {
    match value {
        rmpv::Value::Nil => Value::Null,
        rmpv::Value::Boolean(flag) => Value::Bool(*flag),
        rmpv::Value::Integer(number) => match number.as_i64() {
            Some(held) if held < 0 => Value::String(symbols[(-1 - held) as usize].clone()),
            _ => Value::Number(number.as_u64().unwrap_or_default().into()),
        },
        rmpv::Value::F32(number) => serde_json::json!(number),
        rmpv::Value::F64(number) => serde_json::json!(number),
        rmpv::Value::String(word) => Value::String(word.as_str().unwrap_or_default().to_string()),
        rmpv::Value::Array(items) => {
            Value::Array(items.iter().map(|item| spoken(item, symbols)).collect())
        }
        rmpv::Value::Map(pairs) => Value::Object(
            pairs
                .iter()
                .map(|(key, value)| match spoken(key, symbols) {
                    Value::String(name) => (name, spoken(value, symbols)),
                    other => (other.to_string(), spoken(value, symbols)),
                })
                .collect::<Map<String, Value>>(),
        ),
        rmpv::Value::Binary(_) | rmpv::Value::Ext(_, _) => Value::Null,
    }
}

pub fn names(id: &str, declared: &str) -> bool {
    id.ends_with(declared) || id.contains(&format!("{declared}:"))
}

pub fn calls(index: &Value, source: &str, target: &str) -> bool {
    index["edges"].as_array().unwrap().iter().any(|edge| {
        edge["kind"] == "calls"
            && names(edge["source"].as_str().unwrap(), source)
            && names(edge["target"].as_str().unwrap(), target)
    })
}
