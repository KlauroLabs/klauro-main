use std::collections::HashMap;
use std::sync::OnceLock;

use crate::discovery::FileKind;

static HINTS: &str = include_str!("../data/languages.tsv");

const NO_LANGUAGE: &str = "-";

#[derive(Clone, Copy)]
pub struct Hint {
    pub language: Option<&'static str>,
    pub kind: FileKind,
}

#[derive(Default)]
struct Table {
    names: HashMap<&'static str, Hint>,
    extensions: HashMap<&'static str, Hint>,
    shebangs: HashMap<&'static str, Hint>,
}

fn kind_named(name: &str) -> FileKind {
    match name {
        "source" => FileKind::Source,
        "manifest" => FileKind::Manifest,
        "config" => FileKind::Config,
        "script" => FileKind::Script,
        other => panic!("language table names an unknown file kind {other}"),
    }
}

fn table() -> &'static Table {
    static HELD: OnceLock<Table> = OnceLock::new();
    HELD.get_or_init(|| {
        let mut table = Table::default();
        for line in HINTS.lines().filter(|line| !line.trim().is_empty()) {
            let held: Vec<&'static str> = line.split('\t').collect();
            let hint = Hint {
                language: Some(held[2]).filter(|language| *language != NO_LANGUAGE),
                kind: kind_named(held[3]),
            };
            let keyed = match held[0] {
                "name" => &mut table.names,
                "extension" => &mut table.extensions,
                "shebang" => &mut table.shebangs,
                other => panic!("language table names an unknown key kind {other}"),
            };
            keyed.insert(held[1], hint);
        }
        table
    })
}

pub fn for_name(lower: &str) -> Option<Hint> {
    table().names.get(lower).copied()
}

pub fn for_extension(lower: &str) -> Option<Hint> {
    table().extensions.get(lower).copied()
}

pub fn for_shebang(interpreter: &str) -> Option<Hint> {
    table().shebangs.get(interpreter).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_row_parses() {
        let table = table();
        assert!(!table.names.is_empty() && !table.extensions.is_empty() && !table.shebangs.is_empty());
    }

    #[test]
    fn names_resolve_to_a_language_and_kind() {
        let hint = for_name("rakefile").unwrap();
        assert_eq!(hint.language, Some("ruby"));
        assert_eq!(hint.kind, FileKind::Source);
        assert_eq!(for_name("procfile").unwrap().language, None);
    }

    #[test]
    fn shebangs_keep_their_case() {
        assert_eq!(for_shebang("Rscript").unwrap().language, Some("r"));
        assert!(for_shebang("rscript").is_none());
    }
}
