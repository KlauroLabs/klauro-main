use regex::Regex;

use super::{camel, last_segment, line_of, Model, Relation, MANY_TO_MANY, MANY_TO_ONE, ONE_TO_MANY, ONE_TO_ONE};

const RECORD_BASES: &[&str] = &["ApplicationRecord", "ActiveRecord::Base"];

pub fn declared(text: &str) -> Vec<Model> {
    let class = Regex::new(r"(?m)^([ \t]*)class\s+([A-Z][\w:]*)\s*<\s*([A-Z][\w:]*)").expect("a class pattern");
    let association = Regex::new(r"^\s*(has_many|has_one|belongs_to|has_and_belongs_to_many)\s+:(\w+)(.*)$").expect("an association pattern");
    let class_name = Regex::new(r#"class_name:\s*['"]([\w:]+)['"]"#).expect("a class_name pattern");
    let through = Regex::new(r"through:\s*:(\w+)").expect("a through pattern");
    let lines: Vec<&str> = text.lines().collect();
    let mut found = Vec::new();
    for opening in class.captures_iter(text) {
        let whole = opening.get(0).expect("a whole match");
        let first = (line_of(text, whole.start()) as usize).saturating_sub(1);
        let indent = opening[1].len();
        let base = opening[3].to_string();
        let name = last_segment(&opening[2]).to_string();
        let mut relations = Vec::new();
        let mut shared = false;
        let mut at = first + 1;
        while at < lines.len() {
            let Some(line) = lines.get(at).copied() else { break };
            let depth = line.len() - line.trim_start().len();
            if line.trim() == "end" && depth <= indent {
                break;
            }
            shared |= line.contains("abstract_class");
            let mut statement = line.to_string();
            while statement.trim_end().ends_with(',') {
                at += 1;
                let Some(next) = lines.get(at) else { break };
                statement.push(' ');
                statement.push_str(next.trim());
            }
            at += 1;
            let Some(held) = association.captures(&statement) else { continue };
            let options = &held[3];
            if options.contains("polymorphic: true") {
                continue;
            }
            let field = held[2].to_string();
            let through_one = through.captures(options).map(|found| found[1].to_string());
            let target = class_name
                .captures(options)
                .map(|found| last_segment(&found[1]).to_string())
                .unwrap_or_else(|| camel(&crate::rails_routes::singular(&field)));
            let cardinality = match (&held[1], through_one.is_some()) {
                ("has_and_belongs_to_many", _) | ("has_many", true) => MANY_TO_MANY,
                ("has_many", false) => ONE_TO_MANY,
                ("belongs_to", _) => MANY_TO_ONE,
                _ => ONE_TO_ONE,
            };
            relations.push(Relation {
                field,
                target,
                cardinality: Some(cardinality.to_string()),
                scalar: false,
                declared_by: "call".to_string(),
            });
        }
        found.push(Model {
            name,
            file: 0,
            line: first as u32 + 1,
            evidence: RECORD_BASES.contains(&base.as_str()).then(|| format!("extends {base}")),
            extends: Some(last_segment(&base).to_string()),
            table: None,
            fields: Vec::new(),
            relations,
            shared_base: shared,
        });
    }
    found
}
