use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::author::Missed;
use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::IndexNode;

const FILES_ASKED_ABOUT: usize = 12;
const SOURCE_AT_MOST: usize = 6000;
const CLASS_AT_LONGEST: usize = 52;
const ENOUGH_TO_ASK_ABOUT: usize = 4;

pub fn asked() -> bool {
    std::env::var("KLAURO_AUDIT").is_ok_and(|held| held != "0")
}

fn into() -> PathBuf {
    std::env::var("KLAURO_AUDIT_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(".klauro/audit"))
}

fn numbered(source: &str) -> String {
    let mut shown = String::new();
    for (at, line) in source.lines().enumerate() {
        let written = format!("{:>5}| {line}\n", at + 1);
        if shown.len() + written.len() > SOURCE_AT_MOST {
            break;
        }
        shown.push_str(&written);
    }
    shown
}

fn slugged(what: &str) -> String {
    let mut held = String::new();
    for letter in what.chars() {
        if letter.is_ascii_alphanumeric() {
            held.push(letter.to_ascii_lowercase());
        } else if !held.ends_with('-') && !held.is_empty() {
            held.push('-');
        }
        if held.len() >= CLASS_AT_LONGEST {
            break;
        }
    }
    held.trim_matches('-').to_string()
}

fn spelled(path: &str) -> &str {
    Path::new(path).extension().and_then(|held| held.to_str()).unwrap_or("txt")
}

static NOT_CODE: &[&str] = &[
    "configuration", "css", "dockerfile", "graphql", "hcl", "html", "markdown", "proto", "shell",
    "sql", "text",
];

fn is_code(held: &crate::IndexedFile) -> bool {
    held.language.is_some_and(|named| NOT_CODE.binary_search(&named).is_err())
}

fn worth_asking_about(
    files: &[crate::IndexedFile],
    nodes: &[IndexNode],
    entries: &[EntryPoint],
    exits: &[ExitPoint],
) -> Vec<u32> {
    let mut held: BTreeMap<u32, (usize, usize)> = BTreeMap::new();
    for node in nodes {
        held.entry(node.file).or_default().0 += 1;
    }
    for entry in entries {
        held.entry(entry.file).or_default().1 += 1;
    }
    for exit in exits {
        held.entry(exit.file).or_default().1 += 1;
    }
    let mut ranked: Vec<(u32, usize, usize)> = held
        .into_iter()
        .filter(|(file, (declared, _))| {
            *declared >= ENOUGH_TO_ASK_ABOUT
                && files.get(*file as usize).is_some_and(|held| {
                    is_code(held)
                        && !held.path.contains("/test")
                        && !held.path.contains("test/")
                        && !held.path.contains(".test.")
                })
        })
        .map(|(file, (declared, recorded))| (file, declared, recorded))
        .collect();
    ranked.sort_by(|left, right| {
        (right.1 / (right.2 + 1)).cmp(&(left.1 / (left.2 + 1))).then(right.1.cmp(&left.1))
    });
    ranked.truncate(FILES_ASKED_ABOUT);
    ranked.into_iter().map(|(file, _, _)| file).collect()
}

fn recorded_for(
    file: u32,
    entries: &[EntryPoint],
    exits: &[ExitPoint],
    nodes: &[IndexNode],
) -> String {
    let mut held = Vec::new();
    for entry in entries.iter().filter(|held| held.file == file) {
        held.push(format!("  serves {} {}", entry.kind, entry.path.as_deref().unwrap_or(&entry.name)));
    }
    for exit in exits.iter().filter(|held| held.file == file) {
        held.push(format!("  reaches {} {}", exit.kind, exit.target));
    }
    let declared = nodes.iter().filter(|held| held.file == file).count();
    held.push(format!("  declares {declared} things"));
    held.join("\n")
}

static EXIT_FIELDS: &[&str] = &["addressed", "kind", "operation", "target"];
static ENTRY_FIELDS: &[&str] = &["kind", "method", "name", "path"];
static ENTITY_FIELDS: &[&str] = &["declared_as"];
static EXIT_KINDS: &[&str] = &[
    "api", "cache", "client_storage", "database", "file", "message", "network", "process",
];
static ENTRY_KINDS: &[&str] =
    &["background", "cli", "event", "export", "http", "ipc", "lifecycle", "message", "schedule", "test", "ui"];

fn well_formed(expect: &crate::author::Expectation) -> bool {
    let (fields, kinds) = match expect.at.as_str() {
        "exit_points" => (EXIT_FIELDS, EXIT_KINDS),
        "entry_points" => (ENTRY_FIELDS, ENTRY_KINDS),
        "comprehension.entities" => (ENTITY_FIELDS, &[] as &[&str]),
        _ => return false,
    };
    !expect.has.is_empty()
        && expect.has.iter().all(|(key, value)| {
            fields.binary_search(&key.as_str()).is_ok()
                && (key != "kind" || kinds.is_empty() || kinds.binary_search(&value.as_str()).is_ok())
        })
}

fn already_written(at: &Path, class: &str) -> bool {
    at.join("missed").join(format!("{class}.json")).exists()
}

fn write(
    at: &Path,
    class: &str,
    missed: &Missed,
    found_in: &str,
    path: &str,
    state: &str,
) -> std::io::Result<()> {
    let holding = at.join("fixtures/missed").join(class);
    std::fs::create_dir_all(&holding)?;
    std::fs::write(holding.join(format!("shown.{}", spelled(path))), &missed.smallest)?;
    std::fs::create_dir_all(at.join("missed"))?;
    let manifest = serde_json::json!({
        "class": class,
        "claim": missed.what,
        "kind": missed.kind,
        "state": state,
        "found_in": found_in,
        "expect": { "at": missed.expect.at, "has": missed.expect.has },
    });
    std::fs::write(
        at.join("missed").join(format!("{class}.json")),
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )
}

pub struct Looked {
    pub asked: usize,
    pub offered: usize,
    pub written: usize,
    pub malformed: usize,
    pub graded: bool,
}

pub fn look(
    root: &str,
    files: &[crate::IndexedFile],
    nodes: &[IndexNode],
    entries: &[EntryPoint],
    exits: &[ExitPoint],
) -> Looked {
    let at = into();
    let mut looked =
        Looked { asked: 0, offered: 0, written: 0, malformed: 0, graded: crate::jev::asked() };
    for file in worth_asking_about(files, nodes, entries, exits) {
        let Some(path) = files.get(file as usize).map(|held| held.path.as_str()) else { continue };
        let Ok(source) = std::fs::read_to_string(Path::new(root).join(path)) else { continue };
        let shown = numbered(&source);
        let recorded = recorded_for(file, entries, exits, nodes);
        looked.asked += 1;
        for missed in crate::author::look_for_missed(path, &shown, &recorded) {
            looked.offered += 1;
            let class = slugged(&missed.what);
            if class.is_empty() || already_written(&at, &class) || missed.smallest.trim().is_empty()
            {
                continue;
            }
            if !well_formed(&missed.expect) {
                looked.malformed += 1;
                continue;
            }
            let state = match looked.graded {
                true if crate::author::vet(&missed) => "pending",
                true => continue,
                false => "ungraded",
            };
            let found_in = format!("{path}:{}", missed.line);
            if write(&at, &class, &missed, &found_in, path, state).is_ok() {
                eprintln!("  audit noted {class} ({found_in})");
                looked.written += 1;
            }
        }
    }
    looked
}

#[cfg(test)]
mod tests {
    #[test]
    fn what_is_not_code_is_sorted() {
        for held in [super::NOT_CODE, super::EXIT_FIELDS, super::ENTRY_FIELDS, super::EXIT_KINDS, super::ENTRY_KINDS] {
            assert!(held.windows(2).all(|pair| pair[0] < pair[1]), "{held:?}");
        }
    }

    #[test]
    fn every_kind_that_may_be_named_says_what_it_means() {
        for (at, kinds) in [("exit_points", super::EXIT_KINDS), ("entry_points", super::ENTRY_KINDS)] {
            for kind in kinds {
                let expect = crate::author::Expectation {
                    at: at.to_string(),
                    has: [("kind".to_string(), kind.to_string())].into_iter().collect(),
                };
                assert!(
                    !crate::author::what_it_means(&expect).contains(" of kind "),
                    "{at} {kind} has no meaning to be judged against"
                );
            }
        }
    }

    #[test]
    fn an_expectation_must_be_spelled_the_way_the_index_is() {
        use crate::author::Expectation;
        let held = |at: &str, has: [(&str, &str); 2]| Expectation {
            at: at.to_string(),
            has: has.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect(),
        };
        assert!(super::well_formed(&held("exit_points", [("kind", "database"), ("target", "a_table")])));
        assert!(!super::well_formed(&held("exit_points", [("kind", "storage"), ("target", "cookies")])));
        assert!(!super::well_formed(&held("comprehension.entities", [("type", "foreign_key"), ("references", "user.id")])));
        assert!(!super::well_formed(&held("whatever", [("kind", "database"), ("target", "a")])));
    }

    #[test]
    fn the_source_shown_says_which_line_is_which() {
        let shown = super::numbered("first\nsecond\n\nfourth");
        assert!(shown.contains("    2| second"));
        assert!(shown.contains("    4| fourth"));
        assert!(super::numbered(&"x\n".repeat(100_000)).len() <= super::SOURCE_AT_MOST);
    }

    #[test]
    fn a_class_is_named_after_what_was_missed() {
        use super::slugged;
        assert_eq!(
            slugged("A query passed as text names the table it asks of"),
            "a-query-passed-as-text-names-the-table-it-asks-of"
        );
        assert_eq!(slugged("  "), "");
    }
}
