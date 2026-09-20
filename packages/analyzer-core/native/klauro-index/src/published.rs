use std::collections::HashMap;

use crate::entry_exit::EntryPoint;
use crate::model::*;
use crate::paths::is_test;

const PUBLISHED_PER_PROJECT: usize = 120;

static HEADERS: &[&str] = &["h", "h++", "hh", "hpp", "hxx"];

fn extension(path: &str) -> &str {
    crate::paths::basename(path).rsplit_once('.').map(|(_, held)| held).unwrap_or("")
}

fn under(path: &str, root: &str) -> bool {
    root.is_empty() || path == root || path.starts_with(&format!("{root}/"))
}

fn within(path: &str, root: &str, folder: &str) -> bool {
    let inside = match root.is_empty() {
        true => path,
        false => match path.strip_prefix(&format!("{root}/")) {
            Some(held) => held,
            None => return false,
        },
    };
    inside.split('/').any(|part| part == folder)
}

fn spoken_for(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('_')
}

fn upper(name: &str) -> bool {
    name.chars().next().is_some_and(|letter| letter.is_uppercase())
}

struct Publishes<'a> {
    root: &'a str,
}

fn held_by(nodes: &[IndexNode]) -> HashMap<&str, Vec<&IndexNode>> {
    let mut children: HashMap<&str, Vec<&IndexNode>> = HashMap::new();
    for node in nodes {
        if let Some(parent) = node.parent.as_deref() {
            children.entry(parent).or_default().push(node);
        }
    }
    children
}

fn named(children: &HashMap<&str, Vec<&IndexNode>>, parent: &str, held: &str) -> Option<String> {
    children
        .get(parent)?
        .iter()
        .find(|node| node.name == held && node.kind == NodeKind::Property)
        .and_then(|node| node.type_annotation.as_deref())
        .map(|value| value.trim_matches(['"', '\'', ' ']).to_string())
}

fn manifest_files(
    files: &[String],
    children: &HashMap<&str, Vec<&IndexNode>>,
    root: &str,
) -> Vec<String> {
    let mut found = Vec::new();
    let held = |name: &str| match root.is_empty() {
        true => name.to_string(),
        false => format!("{root}/{name}"),
    };
    let manifest = held("package.json");
    if files.iter().any(|path| *path == manifest) {
        for key in ["main", "module", "types", "typings"] {
            if let Some(value) = named(children, &manifest, key) {
                let target = held(value.trim_start_matches("./"));
                found.push(target);
            }
        }
    }
    let cargo = held("Cargo.toml");
    if files.iter().any(|path| *path == cargo) {
        found.push(held("src/lib.rs"));
    }
    found
}

pub fn published(
    files: &[String],
    nodes: &[IndexNode],
    scope: &crate::scope::Scope,
) -> Vec<EntryPoint> {
    let children = held_by(nodes);
    let publishing: Vec<Publishes> = scope
        .deployables
        .iter()
        .filter(|unit| {
            unit.category == "library" && unit.runs.is_none() && unit.bundled_into.is_none()
        })
        .map(|unit| Publishes { root: unit.root.as_str() })
        .collect();

    let mut found = Vec::new();
    for held in &publishing {
        let names = manifest_files(files, &children, held.root);
        let mut kept: Vec<&IndexNode> = Vec::new();
        for node in nodes {
            if !node.kind.is_declaration() || node.parent.is_none() {
                continue;
            }
            let path = &files[node.file as usize];
            if is_test(path) || !under(path, held.root) {
                continue;
            }
            let owner = node.parent.as_deref().unwrap_or("");
            if !owner.ends_with(path.as_str()) {
                continue;
            }
            let language = extension(path);
            let open = match language {
                "go" => upper(&node.name),
                "py" => spoken_for(&node.name) && within(path, held.root, "src"),
                held_as if HEADERS.contains(&held_as) => {
                    within(path, held.root, "include")
                        || within(path, held.root, "single_include")
                }
                _ => {
                    node.modifiers.exported
                        || names.iter().any(|named| named == path)
                }
            };
            if open {
                kept.push(node);
            }
        }
        kept.sort_by(|left, right| {
            names
                .iter()
                .any(|named| named == &files[right.file as usize])
                .cmp(&names.iter().any(|named| named == &files[left.file as usize]))
                .then(left.id.cmp(&right.id))
        });
        kept.truncate(PUBLISHED_PER_PROJECT);
        for node in kept {
            found.push(EntryPoint {
                id: format!("entry:{}:published", node.id),
                kind: "export",
                name: node.name.clone(),
                method: None,
                path: None,
                handler: node.id.clone(),
                file: node.file,
                line: node.span.line,
                registrar: "published".to_string(),
            });
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_published_where_its_language_says_so() {
        assert!(upper("Marshal"));
        assert!(!upper("marshal"));
        assert!(spoken_for("parse"));
        assert!(!spoken_for("_parse"));
    }

    #[test]
    fn a_header_is_told_from_a_source_file() {
        assert!(HEADERS.contains(&extension("include/shape/tree.hpp")));
        assert!(HEADERS.contains(&extension("include/vec.h")));
        assert!(!HEADERS.contains(&extension("src/main.cpp")));
    }

    #[test]
    fn a_folder_is_read_relative_to_the_project_that_holds_it() {
        assert!(within("crates/dump/include/x.hpp", "crates/dump", "include"));
        assert!(!within("crates/dump/src/x.hpp", "crates/dump", "include"));
        assert!(within("include/x.hpp", "", "include"));
        assert!(!within("other/include/x.hpp", "crates/dump", "include"));
    }

    #[test]
    fn a_path_belongs_to_the_project_that_contains_it() {
        assert!(under("crates/dump/src/lib.rs", "crates/dump"));
        assert!(under("anything", ""));
        assert!(!under("crates/dumped/src/lib.rs", "crates/dump"));
    }
}
