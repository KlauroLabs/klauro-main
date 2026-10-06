use regex::Regex;

use super::{balanced, line_of, top_level, Attribute, Model, Relation};
use super::{MANY_TO_ONE, ONE_TO_MANY};

pub fn declared(text: &str) -> Vec<Model> {
    if !text.contains("mongoose") && !text.contains("Schema(") {
        return Vec::new();
    }
    let schema = Regex::new(r"(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:mongoose\.)?Schema(?:<[^>]*>)?\(\s*\{").expect("a schema pattern");
    let registration = Regex::new(r#"\bmodel(?:<[^>]*>)?\(\s*['"](\w+)['"]\s*,\s*(\w+)"#).expect("a model pattern");
    let reference = Regex::new(r#"\bref\s*:\s*['"](\w+)['"]"#).expect("a ref pattern");
    let kind = Regex::new(r"\btype\s*:\s*([\w.]+)").expect("a type pattern");
    let mut found = Vec::new();
    for opening in schema.captures_iter(text) {
        let variable = &opening[1];
        let open_at = opening.get(0).expect("a whole match").end() - 1;
        let Some(body) = balanced(text, open_at) else { continue };
        let Some(name) = registration
            .captures_iter(text)
            .find(|held| &held[2] == variable)
            .map(|held| held[1].to_string())
        else {
            continue;
        };
        let mut model = Model {
            name,
            file: 0,
            line: line_of(text, open_at),
            bases: Vec::new(),
            evidence: Some("mongoose Schema".to_string()),
            table: None,
            fields: Vec::new(),
            relations: Vec::new(),
            shared_base: false,
            module: String::new(),
            base_homes: Vec::new(),
        };
        for entry in top_level(body) {
            let Some((key, value)) = entry.split_once(':') else { continue };
            let key = key.trim().trim_matches(['"', '\'']);
            let value = value.trim();
            if key.is_empty() || !key.chars().all(|letter| letter.is_alphanumeric() || letter == '_') {
                continue;
            }
            let spelled = kind
                .captures(value)
                .map(|held| held[1].to_string())
                .or_else(|| Some(value.trim_start_matches('[').split(['{', ',', ']']).next()?.trim().to_string()).filter(|held| !held.is_empty()));
            model.fields.push(Attribute { name: key.to_string(), declared_as: spelled, key_to: None });
            if let Some(target) = reference.captures(value) {
                let many = value.starts_with('[');
                model.relations.push(Relation {
                    field: key.to_string(),
                    target: target[1].to_string(),
                    cardinality: Some(if many { ONE_TO_MANY } else { MANY_TO_ONE }.to_string()),
                    scalar: false,
                    declared_by: "decorator".to_string(),
                });
            }
        }
        found.push(model);
    }
    found
}
