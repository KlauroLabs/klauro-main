use regex::Regex;
use rustc_hash::FxHashMap as HashMap;

use super::{last_segment, top_level, Attribute, Model, Relation};
use super::{MANY_TO_MANY, MANY_TO_ONE, ONE_TO_MANY, ONE_TO_ONE};

const DJANGO_RELATIONS: &[(&str, &str)] = &[
    ("ForeignKey", MANY_TO_ONE),
    ("OneToOneField", ONE_TO_ONE),
    ("ManyToManyField", MANY_TO_MANY),
];

struct Imports {
    named: HashMap<String, (String, String)>,
    modules: HashMap<String, String>,
    stars: Vec<String>,
}

fn absolute(level: usize, written: &str, module: &str, in_package: bool) -> String {
    if level == 0 {
        return written.to_string();
    }
    let mut parts: Vec<&str> = module.split('.').filter(|part| !part.is_empty()).collect();
    if !in_package {
        parts.pop();
    }
    parts.truncate(parts.len().saturating_sub(level - 1));
    let mut joined = parts.join(".");
    if !written.is_empty() {
        if !joined.is_empty() {
            joined.push('.');
        }
        joined.push_str(written);
    }
    joined
}

impl Imports {
    fn of(text: &str, module: &str, in_package: bool) -> Imports {
        let from = Regex::new(r"(?m)^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)").expect("a from-import pattern");
        let plain = Regex::new(r"(?m)^[ \t]*import[ \t]+([^\n]+)").expect("an import pattern");
        let mut found = Imports { named: HashMap::default(), modules: HashMap::default(), stars: Vec::new() };
        for held in from.captures_iter(text) {
            let source = absolute(held[1].len(), &held[2], module, in_package);
            let listed = held[3].trim().trim_start_matches('(').trim_end_matches(')');
            for item in listed.split(',') {
                let item = item.split('#').next().unwrap_or_default().trim();
                if item == "*" {
                    found.stars.push(source.clone());
                    continue;
                }
                let (original, local) = match item.split_once(" as ") {
                    Some((original, local)) => (original.trim(), local.trim()),
                    None => (item, item),
                };
                if !original.is_empty() && original.chars().all(|letter| letter.is_alphanumeric() || letter == '_') {
                    found.named.insert(local.to_string(), (source.clone(), original.to_string()));
                }
            }
        }
        for held in plain.captures_iter(text) {
            for item in held[1].split(',') {
                let item = item.split('#').next().unwrap_or_default().trim();
                let (target, local) = match item.split_once(" as ") {
                    Some((target, local)) => (target.trim(), local.trim()),
                    None => (item, item.split('.').next().unwrap_or(item)),
                };
                if !target.is_empty() {
                    found.modules.insert(local.to_string(), if local == target { local.to_string() } else { target.to_string() });
                }
            }
        }
        found
    }

    fn reach(&self, written: &str, module: &str) -> (String, Vec<String>) {
        let written = written.trim();
        let name = last_segment(written).to_string();
        let Some((head, rest)) = written.split_once('.') else {
            return match self.named.get(written) {
                Some((source, original)) => (original.clone(), vec![source.clone()]),
                None => {
                    let mut homes = vec![module.to_string()];
                    homes.extend(self.stars.iter().cloned());
                    (name, homes)
                }
            };
        };
        let within = rest.rsplit_once('.').map(|(inner, _)| inner);
        let qualified = |base: &str| match within {
            Some(inner) => format!("{base}.{inner}"),
            None => base.to_string(),
        };
        match (self.named.get(head), self.modules.get(head)) {
            (Some((source, original)), _) => (name, vec![qualified(&format!("{source}.{original}"))]),
            (None, Some(target)) => (name, vec![qualified(target)]),
            (None, None) => (name, Vec::new()),
        }
    }
}

struct Patterns {
    class: Regex,
    assignment: Regex,
    tablename: Regex,
    first_string: Regex,
    foreign_key: Regex,
    mapped: Regex,
}

impl Patterns {
    fn new() -> Self {
        Patterns {
            class: Regex::new(r"(?m)^class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:").expect("a class pattern"),
            assignment: Regex::new(r"^    (\w+)\s*(?::\s*([^=]+?))?\s*=\s*([\w.]+)\((.*)$").expect("an assignment pattern"),
            tablename: Regex::new(r#"__tablename__\s*=\s*['"](\w+)['"]"#).expect("a tablename pattern"),
            first_string: Regex::new(r#"^\s*['"]([\w.]+)['"]"#).expect("a string pattern"),
            foreign_key: Regex::new(r#"ForeignKey\(\s*['"](?:[\w]+\.)?(\w+)\.\w+['"]"#).expect("a foreign key pattern"),
            mapped: Regex::new(r"Mapped\[\s*(?:Optional\[)?\s*(?:(?:List|list|Set|set)\[)?\s*['\x22]?(\w+)").expect("a mapped pattern"),
        }
    }
}

pub fn declared(text: &str, module: &str, in_package: bool) -> Vec<Model> {
    let framework = Framework::of(text);
    if framework == Framework::None {
        return Vec::new();
    }
    let patterns = Patterns::new();
    let imports = Imports::of(text, module, in_package);
    let mut found = Vec::new();
    let classes: Vec<_> = patterns.class.captures_iter(text).collect();
    for (at, opening) in classes.iter().enumerate() {
        let whole = opening.get(0).expect("a whole match");
        let end = classes.get(at + 1).and_then(|next| next.get(0)).map(|next| next.start()).unwrap_or(text.len());
        let body = &text[whole.end()..end];
        let bases: Vec<&str> = top_level(opening.get(2).map(|held| held.as_str()).unwrap_or_default()).into_iter().map(str::trim).filter(|base| !base.is_empty() && !base.contains('=')).collect();
        let name = opening[1].to_string();
        let line = super::line_of(text, whole.start());
        let mut model = Model {
            name: name.clone(),
            file: 0,
            line,
            bases: bases.iter().map(|base| imports.reach(generic_free(base), module).0).collect(),
            evidence: None,
            table: patterns.tablename.captures(body).map(|held| held[1].to_string()),
            fields: Vec::new(),
            relations: Vec::new(),
            shared_base: body.contains("__abstract__ = True") || body.contains("abstract = True"),
            module: String::new(),
            base_homes: bases.iter().map(|base| imports.reach(generic_free(base), module).1).collect(),
        };
        match framework {
            Framework::Django => {
                if let Some(base) = bases.iter().find(|base| last_segment(generic_free(base)) == "Model") {
                    model.evidence = Some(format!("extends {base}"));
                }
                django_fields(&patterns, body, &mut model);
            }
            Framework::Sqlalchemy => {
                sqlalchemy_fields(&patterns, body, &mut model);
                if !bases.is_empty() && (model.table.is_some() || !model.fields.is_empty()) {
                    model.evidence = Some(match &model.table {
                        Some(table) => format!("__tablename__ = {table}"),
                        None => "Column declarations".to_string(),
                    });
                }
            }
            Framework::None => {}
        }
        found.push(model);
    }
    found
}

#[derive(PartialEq, Clone, Copy)]
enum Framework {
    Django,
    Sqlalchemy,
    None,
}

impl Framework {
    fn of(text: &str) -> Self {
        if text.contains("django") {
            Framework::Django
        } else if text.contains("sqlalchemy") || text.contains("sqlmodel") {
            Framework::Sqlalchemy
        } else {
            Framework::None
        }
    }
}

fn generic_free(base: &str) -> &str {
    base.split('[').next().unwrap_or(base)
}

fn statements(body: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut current = String::new();
    let mut open = 0i32;
    for line in body.lines() {
        if open <= 0 {
            current.clear();
        } else {
            current.push(' ');
        }
        current.push_str(if open > 0 { line.trim() } else { line });
        open += line.matches(['(', '[', '{']).count() as i32 - line.matches([')', ']', '}']).count() as i32;
        if open <= 0 {
            found.push(current.clone());
        }
    }
    found
}

fn django_fields(patterns: &Patterns, body: &str, model: &mut Model) {
    for line in statements(body) {
        let Some(held) = patterns.assignment.captures(&line) else { continue };
        let callee = last_segment(&held[3]);
        if !callee.ends_with("Field") && callee != "ForeignKey" {
            continue;
        }
        let field = held[1].to_string();
        let Some((_, cardinality)) = DJANGO_RELATIONS.iter().find(|(name, _)| *name == callee) else {
            model.fields.push(Attribute { name: field, declared_as: Some(callee.to_string()), key_to: None });
            continue;
        };
        let arguments = top_level(held[4].trim_end().strip_suffix(')').unwrap_or(&held[4]));
        let first = arguments.first().map(|argument| argument.trim()).unwrap_or_default();
        let named = arguments.iter().find_map(|argument| argument.trim().strip_prefix("to=")).map(str::trim);
        let target = named.unwrap_or(first).trim_matches(['"', '\'']);
        let target = match last_segment(target) {
            "self" => model.name.clone(),
            other => other.to_string(),
        };
        if target.is_empty() || !target.chars().next().is_some_and(char::is_alphabetic) {
            continue;
        }
        model.relations.push(Relation {
            field,
            target,
            cardinality: Some(cardinality.to_string()),
            scalar: false,
            declared_by: "call".to_string(),
        });
    }
}

fn sqlalchemy_fields(patterns: &Patterns, body: &str, model: &mut Model) {
    for line in statements(body) {
        let Some(held) = patterns.assignment.captures(&line) else { continue };
        let callee = last_segment(&held[3]);
        let field = held[1].to_string();
        if field.starts_with("__") {
            continue;
        }
        let annotation = held.get(2).map(|found| found.as_str());
        match callee {
            "Column" | "mapped_column" => {
                let spelled = annotation
                    .and_then(|found| patterns.mapped.captures(found))
                    .map(|found| found[1].to_string())
                    .or_else(|| {
                        top_level(&held[4])
                            .first()
                            .map(|argument| argument.trim().trim_end_matches(')').trim().to_string())
                            .filter(|argument| argument.chars().next().is_some_and(char::is_uppercase))
                    });
                model.fields.push(Attribute {
                    name: field,
                    declared_as: spelled,
                    key_to: patterns.foreign_key.captures(&held[4]).map(|found| found[1].to_string()),
                });
            }
            "relationship" => {
                let arguments = &held[4];
                let target = patterns
                    .first_string
                    .captures(arguments)
                    .map(|found| found[1].to_string())
                    .or_else(|| annotation.and_then(|found| patterns.mapped.captures(found)).map(|found| found[1].to_string()));
                let Some(target) = target else { continue };
                let collection = annotation.is_some_and(|found| found.contains("List[") || found.contains("list[") || found.contains("Set[") || found.contains("set["));
                let scalar = arguments.contains("uselist=False") || annotation.is_some_and(|found| !collection && found.contains("Mapped["));
                let cardinality = match (arguments.contains("secondary="), collection) {
                    (true, _) => Some(MANY_TO_MANY.to_string()),
                    (false, true) => Some(ONE_TO_MANY.to_string()),
                    _ => None,
                };
                model.relations.push(Relation {
                    field,
                    target: last_segment(&target).to_string(),
                    cardinality,
                    scalar,
                    declared_by: "call".to_string(),
                });
            }
            _ => {}
        }
    }
}
