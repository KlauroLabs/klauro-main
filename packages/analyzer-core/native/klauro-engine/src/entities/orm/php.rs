use regex::Regex;

use super::{balanced, last_segment, line_of, Attribute, Model, Relation};
use super::{MANY_TO_MANY, MANY_TO_ONE, ONE_TO_MANY, ONE_TO_ONE};

const ELOQUENT_BASES: &[&str] = &["Model", "Pivot", "MorphPivot", "Authenticatable"];

const ELOQUENT_RELATIONS: &[(&str, &str)] = &[
    ("hasMany", ONE_TO_MANY),
    ("hasOne", ONE_TO_ONE),
    ("belongsTo", MANY_TO_ONE),
    ("belongsToMany", MANY_TO_MANY),
    ("hasManyThrough", ONE_TO_MANY),
    ("hasOneThrough", ONE_TO_ONE),
    ("morphMany", ONE_TO_MANY),
    ("morphOne", ONE_TO_ONE),
    ("morphToMany", MANY_TO_MANY),
    ("morphedByMany", MANY_TO_MANY),
];

const MAPPED_RELATIONS: &[(&str, &str)] = &[
    ("OneToMany", ONE_TO_MANY),
    ("ManyToOne", MANY_TO_ONE),
    ("OneToOne", ONE_TO_ONE),
    ("ManyToMany", MANY_TO_MANY),
];

pub fn declared(text: &str) -> Vec<Model> {
    let class = Regex::new(r"(?m)^[ \t]*((?:(?:abstract|final|readonly)\s+)*)class\s+(\w+)(?:\s+extends\s+([\\\w]+))?[^{]*\{").expect("a class pattern");
    let mut found = Vec::new();
    let mut previous_end = 0;
    for opening in class.captures_iter(text) {
        let whole = opening.get(0).expect("a whole match");
        let open_at = whole.end() - 1;
        let Some(body) = balanced(text, open_at) else { continue };
        let preface = text.get(previous_end..whole.start()).unwrap_or_default();
        previous_end = previous_end.max(open_at + body.len() + 2);
        let name = opening[2].to_string();
        let base = opening.get(3).map(|held| last_segment(held.as_str()).to_string());
        let line = line_of(text, whole.start());
        let mapped = mapped_entity(preface);
        let eloquent_family = text.contains("Illuminate\\") || text.contains("Eloquent");
        let evidence = match (&mapped, &base) {
            (Some(marker), _) => Some(marker.clone()),
            (None, Some(base)) if eloquent_family && ELOQUENT_BASES.contains(&base.as_str()) => Some(format!("extends {base}")),
            _ => None,
        };
        let mut model = Model {
            name,
            file: 0,
            line,
            bases: base.into_iter().collect(),
            evidence,
            table: mapped_table(preface),
            fields: Vec::new(),
            relations: Vec::new(),
            shared_base: opening[1].contains("abstract") || preface.contains("MappedSuperclass"),
            module: String::new(),
            base_homes: Vec::new(),
        };
        match mapped {
            Some(_) => mapped_properties(body, &mut model),
            None => eloquent_relations(body, &mut model),
        }
        found.push(model);
    }
    found
}

fn mapped_entity(preface: &str) -> Option<String> {
    let marker = Regex::new(r"(?:#\[\s*|@)((?:ORM\\)?Entity)\b").expect("an entity pattern");
    let tail_start = preface.rfind(['}', ';']).map(|at| at + 1).unwrap_or(0);
    marker.captures(&preface[tail_start..]).map(|held| format!("#[{}]", &held[1]))
}

fn mapped_table(preface: &str) -> Option<String> {
    let table = Regex::new(r#"Table\([^)]*name\s*[:=]\s*['"](\w+)['"]"#).expect("a table pattern");
    table.captures(preface).map(|held| held[1].to_string())
}

fn eloquent_relations(body: &str, model: &mut Model) {
    let method = Regex::new(r"function\s+(\w+)\s*\([^)]*\)[^{;]*\{[^}]*?\$this->(\w+)\(\s*([\\\w]+)::class").expect("a relation method pattern");
    for held in method.captures_iter(body) {
        let Some((_, cardinality)) = ELOQUENT_RELATIONS.iter().find(|(verb, _)| *verb == &held[2]) else { continue };
        model.relations.push(Relation {
            field: held[1].to_string(),
            target: last_segment(&held[3]).to_string(),
            cardinality: Some(cardinality.to_string()),
            scalar: false,
            declared_by: "call".to_string(),
        });
    }
}

fn mapped_properties(body: &str, model: &mut Model) {
    let property = Regex::new(r"^\s*(?:public|protected|private)\s+(?:static\s+)?(?:readonly\s+)?(\??[\w\\|]+)?\s*\$(\w+)").expect("a property pattern");
    let relation = Regex::new(r"(?:#\[\s*|@)(?:ORM\\)?(OneToMany|ManyToOne|OneToOne|ManyToMany)\b").expect("a relation pattern");
    let column = Regex::new(r"(?:#\[\s*|@)(?:ORM\\)?(?:Column|Id)\b").expect("a column pattern");
    let target_class = Regex::new(r#"targetEntity\s*[:=]\s*(?:([\\\w]+)::class|['"]([\\\w]+)['"])"#).expect("a target pattern");
    let column_type = Regex::new(r#"\btype\s*[:=]\s*(?:Types::)?['"]?(\w+)"#).expect("a column type pattern");
    let collection_of = Regex::new(r"@var\s+(?:Collection|ArrayCollection|array)<(?:\w+,\s*)?([\\\w]+)>|@var\s+([\\\w]+)\[\]").expect("a collection pattern");
    let mut pending = String::new();
    for line in body.lines() {
        let Some(held) = property.captures(line) else {
            if line.contains("function ") {
                pending.clear();
            } else {
                pending.push_str(line);
                pending.push('\n');
            }
            continue;
        };
        let declared_type = held.get(1).map(|kind| kind.as_str().trim_start_matches('?').to_string());
        let field = held[2].to_string();
        if let Some(kind) = relation.captures(&pending) {
            let cardinality = MAPPED_RELATIONS.iter().find(|(name, _)| *name == &kind[1]).map(|(_, found)| found.to_string());
            let named = target_class
                .captures(&pending)
                .and_then(|found| found.get(1).or(found.get(2)).map(|name| last_segment(name.as_str()).to_string()))
                .or_else(|| {
                    collection_of
                        .captures(&pending)
                        .and_then(|found| found.get(1).or(found.get(2)).map(|name| last_segment(name.as_str()).to_string()))
                })
                .or_else(|| {
                    declared_type
                        .as_deref()
                        .filter(|kind| !matches!(*kind, "Collection" | "ArrayCollection" | "array" | "iterable" | "self" | "static"))
                        .map(|kind| last_segment(kind).to_string())
                });
            if let Some(target) = named {
                model.relations.push(Relation {
                    field: field.clone(),
                    target,
                    cardinality,
                    scalar: false,
                    declared_by: "decorator".to_string(),
                });
            }
        } else if column.is_match(&pending) {
            let spelled = column_type.captures(&pending).map(|found| found[1].to_string()).or(declared_type);
            model.fields.push(Attribute { name: field, declared_as: spelled, key_to: None });
        }
        pending.clear();
    }
}
