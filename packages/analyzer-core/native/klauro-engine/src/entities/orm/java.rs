use regex::Regex;

use super::{balanced, declared_cardinality, last_segment, line_of, Attribute, Model, Relation};

pub fn declared(text: &str) -> Vec<Model> {
    let class = Regex::new(r"(?m)^[ \t]*((?:(?:public|abstract|final|static)\s+)*)class\s+(\w+)(?:\s+extends\s+([\w.]+))?[^{]*\{").expect("a class pattern");
    let entity = Regex::new(r"@(?:\w+\.)*Entity\b").expect("an entity pattern");
    let table = Regex::new(r#"@Table\([^)]*name\s*=\s*"(\w+)""#).expect("a table pattern");
    let mut found = Vec::new();
    let mut previous_end = 0;
    for opening in class.captures_iter(text) {
        let whole = opening.get(0).expect("a whole match");
        let open_at = whole.end() - 1;
        let Some(body) = balanced(text, open_at) else { continue };
        let preface = text.get(previous_end..whole.start()).unwrap_or_default();
        previous_end = previous_end.max(open_at + body.len() + 2);
        let tail_start = preface.rfind(['}', ';']).map(|at| at + 1).unwrap_or(0);
        let mut model = Model {
            name: opening[2].to_string(),
            file: 0,
            line: line_of(text, whole.start()),
            bases: opening.get(3).map(|base| last_segment(base.as_str()).to_string()).into_iter().collect(),
            evidence: entity.is_match(&preface[tail_start..]).then(|| "@Entity".to_string()),
            table: table.captures(&preface[tail_start..]).map(|held| held[1].to_string()),
            fields: Vec::new(),
            relations: Vec::new(),
            shared_base: opening[1].contains("abstract") || preface[tail_start..].contains("MappedSuperclass"),
        };
        persisted_fields(body, &mut model);
        found.push(model);
    }
    found
}

fn persisted_fields(body: &str, model: &mut Model) {
    let field = Regex::new(r"^\s*(?:(?:private|protected|public|final)\s+)*([\w.]+(?:<[^;=()]*>)?(?:\[\])?)\s+(\w+)\s*(?:=[^;]*)?;").expect("a field pattern");
    let annotation = Regex::new(r"@(\w+)").expect("an annotation pattern");
    let target_class = Regex::new(r"targetEntity\s*=\s*([\w.]+)\.class").expect("a target pattern");
    let generic = Regex::new(r"<(?:[\w.]+,\s*)?([\w.]+)>").expect("a generic pattern");
    let stripped = Regex::new(r"@\w+(?:\([^)]*\))?").expect("a stripping pattern");
    let mut pending = String::new();
    for line in body.lines() {
        let rest = stripped.replace_all(line, "");
        pending.push_str(line);
        pending.push('\n');
        if rest.trim().is_empty() {
            continue;
        }
        let Some(held) = field.captures(&rest).filter(|_| !rest.contains('(')) else {
            pending.clear();
            continue;
        };
        let spelled = held[1].to_string();
        let name = held[2].to_string();
        let cardinality = annotation.captures_iter(&pending).find_map(|found| declared_cardinality(&found[1]));
        match cardinality {
            Some(cardinality) => {
                let target = target_class
                    .captures(&pending)
                    .map(|found| last_segment(&found[1]).to_string())
                    .or_else(|| generic.captures(&spelled).map(|found| last_segment(&found[1]).to_string()))
                    .unwrap_or_else(|| last_segment(&spelled).to_string());
                model.relations.push(Relation {
                    field: name,
                    target,
                    cardinality: Some(cardinality.to_string()),
                    scalar: false,
                    declared_by: "decorator".to_string(),
                });
            }
            None if pending.contains("@Column") || pending.contains("@Id") => {
                model.fields.push(Attribute { name, declared_as: Some(spelled), key_to: None });
            }
            None => {}
        }
        pending.clear();
    }
}
