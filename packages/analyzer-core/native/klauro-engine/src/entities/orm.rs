use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::{Deserialize, Serialize};

mod java;
mod mongoose;
mod php;
mod python;
mod ruby;

pub const ONE_TO_ONE: &str = "1:1";
pub const ONE_TO_MANY: &str = "1:N";
pub const MANY_TO_ONE: &str = "N:1";
pub const MANY_TO_MANY: &str = "N:M";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attribute {
    pub name: String,
    pub declared_as: Option<String>,
    pub key_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Relation {
    pub field: String,
    pub target: String,
    pub cardinality: Option<String>,
    pub scalar: bool,
    pub declared_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Model {
    pub name: String,
    pub file: u32,
    pub line: u32,
    pub extends: Option<String>,
    pub evidence: Option<String>,
    pub table: Option<String>,
    pub fields: Vec<Attribute>,
    pub relations: Vec<Relation>,
    pub shared_base: bool,
}

pub fn declared_cardinality(decorator: &str) -> Option<&'static str> {
    match last_segment(decorator) {
        "OneToMany" => Some(ONE_TO_MANY),
        "ManyToOne" => Some(MANY_TO_ONE),
        "OneToOne" => Some(ONE_TO_ONE),
        "ManyToMany" => Some(MANY_TO_MANY),
        _ => None,
    }
}

pub fn is_many(cardinality: &str) -> bool {
    cardinality == ONE_TO_MANY || cardinality == MANY_TO_MANY
}

pub fn declared(source: &[u8], path: &str, file: u32) -> Vec<Model> {
    let Ok(text) = std::str::from_utf8(source) else {
        return Vec::new();
    };
    if crate::paths::is_test(path) {
        return Vec::new();
    }
    let extension = path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    let mut found = match extension.as_str() {
        "java" => java::declared(text),
        "rb" => ruby::declared(text),
        "php" => php::declared(text),
        "py" => python::declared(text),
        "ts" | "js" | "mjs" | "cjs" | "tsx" | "jsx" => mongoose::declared(text),
        _ => Vec::new(),
    };
    for model in found.iter_mut() {
        model.file = file;
    }
    found
}

pub fn refile(models: &mut [Model], file: u32) {
    models.iter_mut().for_each(|held| held.file = file);
}

pub fn standing(models: Vec<Model>) -> Vec<Model> {
    let mut established: HashSet<String> = models
        .iter()
        .filter(|model| model.evidence.is_some())
        .map(|model| model.name.clone())
        .collect();
    loop {
        let before = established.len();
        for model in &models {
            if model.extends.as_ref().is_some_and(|base| established.contains(base)) {
                established.insert(model.name.clone());
            }
        }
        if established.len() == before {
            break;
        }
    }
    let kept: Vec<Model> = models
        .into_iter()
        .filter(|model| established.contains(&model.name))
        .map(|mut model| {
            if model.evidence.is_none() {
                model.evidence = model.extends.as_ref().map(|base| format!("extends {base}"));
            }
            model
        })
        .collect();
    let named: HashMap<&str, usize> = kept.iter().enumerate().map(|(at, model)| (model.name.as_str(), at)).collect();
    let keyed_to = |holder: &Model, target: &Model| {
        let table = target.table.as_ref().map(|table| table.to_ascii_lowercase());
        holder
            .fields
            .iter()
            .any(|field| field.key_to.as_ref().is_some_and(|key| Some(key.to_ascii_lowercase()) == table))
    };
    let resolved: Vec<Vec<Relation>> = kept
        .iter()
        .map(|model| {
            model
                .relations
                .iter()
                .map(|relation| {
                    let mut relation = relation.clone();
                    if relation.cardinality.is_none() {
                        let target = named.get(relation.target.as_str()).map(|at| &kept[*at]);
                        let outward = target.is_some_and(|target| keyed_to(model, target));
                        let inward = target.is_some_and(|target| keyed_to(target, model));
                        relation.cardinality = Some(
                            match (outward, inward, relation.scalar) {
                                (true, _, true) => ONE_TO_ONE,
                                (true, _, false) => MANY_TO_ONE,
                                (false, true, true) => ONE_TO_ONE,
                                (false, true, false) => ONE_TO_MANY,
                                (false, false, true) => MANY_TO_ONE,
                                (false, false, false) => ONE_TO_MANY,
                            }
                            .to_string(),
                        );
                    }
                    relation
                })
                .collect()
        })
        .collect();
    let tabled: HashMap<String, &str> = kept
        .iter()
        .filter_map(|model| Some((model.table.as_ref()?.to_ascii_lowercase(), model.name.as_str())))
        .collect();
    let keyed: Vec<Vec<Relation>> = kept
        .iter()
        .map(|model| {
            model
                .fields
                .iter()
                .filter_map(|field| {
                    let target = tabled.get(&field.key_to.as_ref()?.to_ascii_lowercase())?;
                    Some(Relation {
                        field: field.name.clone(),
                        target: target.to_string(),
                        cardinality: Some(MANY_TO_ONE.to_string()),
                        scalar: false,
                        declared_by: "foreign key".to_string(),
                    })
                })
                .collect()
        })
        .collect();
    kept.into_iter()
        .zip(resolved)
        .zip(keyed)
        .filter(|((model, _), _)| !model.shared_base)
        .map(|((mut model, mut relations), keys)| {
            for key in keys {
                if !relations.iter().any(|held| held.target == key.target) {
                    relations.push(key);
                }
            }
            model.relations = relations;
            model
        })
        .collect()
}

pub(crate) fn last_segment(name: &str) -> &str {
    name.rsplit(['\\', '.', ':']).next().unwrap_or(name)
}

pub(crate) fn camel(word: &str) -> String {
    word.split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut letters = part.chars();
            letters.next().map(|first| first.to_uppercase().chain(letters).collect::<String>()).unwrap_or_default()
        })
        .collect()
}

pub(crate) fn line_of(text: &str, at: usize) -> u32 {
    text[..at].matches('\n').count() as u32 + 1
}

pub(crate) fn balanced(text: &str, open_at: usize) -> Option<&str> {
    let bytes = text.as_bytes();
    let (open, close) = match bytes.get(open_at)? {
        b'{' => (b'{', b'}'),
        b'(' => (b'(', b')'),
        b'[' => (b'[', b']'),
        _ => return None,
    };
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut at = open_at;
    while at < bytes.len() {
        let letter = bytes[at];
        match quote {
            Some(held) => {
                if letter == b'\\' {
                    at += 1;
                } else if letter == held {
                    quote = None;
                }
            }
            None => {
                let next = bytes.get(at + 1).copied();
                if letter == b'/' && next == Some(b'/') || letter == b'#' && next != Some(b'[') {
                    at += bytes[at..].iter().position(|held| *held == b'\n').unwrap_or(bytes.len() - at);
                } else if letter == b'/' && next == Some(b'*') {
                    at += text[at + 2..].find("*/").map(|end| end + 3).unwrap_or(bytes.len() - at);
                } else if letter == b'"' || letter == b'\'' || letter == b'`' {
                    quote = Some(letter);
                } else if letter == open {
                    depth += 1;
                } else if letter == close {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return Some(&text[open_at + 1..at]);
                    }
                }
            }
        }
        at += 1;
    }
    None
}

pub(crate) fn top_level(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut start = 0;
    let mut skip = false;
    for (at, letter) in text.char_indices() {
        if skip {
            skip = false;
            continue;
        }
        match quote {
            Some(held) => {
                if letter == '\\' {
                    skip = true;
                } else if letter == held {
                    quote = None;
                }
            }
            None => match letter {
                '"' | '\'' | '`' => quote = Some(letter),
                '(' | '[' | '{' => depth += 1,
                ')' | ']' | '}' => depth -= 1,
                ',' if depth == 0 => {
                    parts.push(&text[start..at]);
                    start = at + 1;
                }
                _ => {}
            },
        }
    }
    parts.push(&text[start..]);
    parts
}

#[cfg(test)]
mod tests {
    use super::declared;

    const HOSTILE: &[(&str, &str)] = &[
        ("a.rb", "class 名前 < ApplicationRecord\n  has_many :🦀s,\n"),
        ("a.rb", "class A < ApplicationRecord\n  belongs_to :e\u{301}toile, class_name: 'É"),
        ("a.rb", "class A < ApplicationRecord\n  has_many"),
        ("a.php", "<?php\n#[ORM\\Entity\nclass 日本 {\n  #[ORM\\OneToMany(targetEntity: \u{1F980}::class\n  private $x"),
        ("a.php", "<?php\nclass A extends Model { function é() { return $this->hasMany(É::class"),
        ("a.php", "<?php\n#[ORM\\Entity]\nclass A { class B { } }\nclass C {"),
        ("a.php", "<?php\n/* \u{1F980}\n#[ORM\\Entity] class A {\n// \u{301}\n"),
        ("A.java", "@Entity\nclass 日本 {\n  @OneToMany(targetEntity = \n  private List<\u{1F980}> x;\n"),
        ("A.java", "@Entity class A { @ManyToOne private"),
        ("A.java", "@Entity class A { class B { } } class C {"),
        ("a.py", "import django\nclass A(models.Model):\n    x = models.ForeignKey(\n        '\u{1F980}"),
        ("a.py", "import sqlalchemy\nclass A(Base):\n    é = relationship(\"\n"),
        ("a.py", "import django\nclass A(models.Model):\n    x = models.ForeignKey()\n    y = models.ManyToManyField(\"\")\n"),
        ("a.ts", "import mongoose from 'mongoose';\nconst s = new Schema({ \u{1F980}: [{ ref: '日"),
        ("a.ts", "const s = new Schema({ a: { ref: '' }, : 1, , });\nmodel('A', s)"),
        ("a.ts", "const s = new Schema({ /* \u{301}\nmodel('A', s)"),
    ];

    #[test]
    fn malformed_and_multibyte_sources_are_skipped_and_never_panic() {
        for (path, source) in HOSTILE {
            for end in (0..=source.len()).filter(|at| source.is_char_boundary(*at)) {
                declared(source[..end].as_bytes(), path, 0);
            }
        }
        assert!(declared(&[0xff, 0xfe, 0x41], "a.rb", 0).is_empty());
        assert!(declared(b"", "a.php", 0).is_empty());
    }

    #[test]
    fn a_multibyte_model_name_is_kept_whole() {
        let found = declared("<?php\n#[ORM\\Entity]\nclass 名前 {\n}\n".as_bytes(), "a.php", 0);
        assert_eq!(found.first().map(|model| model.name.as_str()), Some("名前"));
    }
}
