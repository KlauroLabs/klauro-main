use rustc_hash::FxHashMap as HashMap;

use crate::entry_exit::EntryPoint;
use crate::model::*;
use crate::paths::{is_not_shipped, is_test};

static HEADERS: &[&str] = &["h", "h++", "hh", "hpp", "hxx"];

static BUILD_SCRIPTS: &[&str] = &[".gradle", ".gradle.kts"];

fn extension(path: &str) -> &str {
    crate::paths::basename(path).rsplit_once('.').map(|(_, held)| held).unwrap_or("")
}

fn under(path: &str, root: &str) -> bool {
    if root.is_empty() || path == root {
        return true;
    }
    path.len() > root.len()
        && path.starts_with(root)
        && path.as_bytes()[root.len()] == b'/'
}

fn within(path: &str, root: &str, folder: &str) -> bool {
    let inside = match root.is_empty() {
        true => path,
        false => match path.strip_prefix(root).and_then(|held| held.strip_prefix('/')) {
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
    let mut children: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
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
            unit.category == "library" && unit.runs.is_none() && unit.offered_to_others
        })
        .map(|unit| Publishes { root: unit.root.as_str() })
        .collect();
    let mut every: Vec<&str> = scope.deployables.iter().map(|unit| unit.root.as_str()).collect();
    every.sort_by_key(|root| std::cmp::Reverse(root.len()));

    if publishing.is_empty() {
        return Vec::new();
    }
    let manifests: Vec<Vec<String>> =
        publishing.iter().map(|held| manifest_files(files, &children, held.root)).collect();
    let mut innermost: Vec<usize> = (0..publishing.len()).collect();
    innermost.sort_by_key(|at| std::cmp::Reverse(publishing[*at].root.len()));
    let holds: Vec<Option<usize>> = files
        .iter()
        .map(|path| {
            let nearest = every.iter().find(|root| under(path, root))?;
            innermost
                .iter()
                .copied()
                .find(|at| under(path, publishing[*at].root))
                .filter(|at| publishing[*at].root.len() >= nearest.len())
        })
        .collect();

    let mut kept: Vec<Vec<&IndexNode>> = vec![Vec::new(); publishing.len()];
    for node in nodes {
        if !node.kind.is_declaration() || node.parent.is_none() {
            continue;
        }
        let Some(at) = holds.get(node.file as usize).copied().flatten() else { continue };
        let path = &files[node.file as usize];
        if is_test(path) || is_not_shipped(path) || is_a_declaration_file(path) || BUILD_SCRIPTS.iter().any(|ending| path.ends_with(ending)) {
            continue;
        }
        let owner = node.parent.as_deref().unwrap_or("");
        if !owner.ends_with(path.as_str()) {
            continue;
        }
        let held = &publishing[at];
        let language = extension(path);
        let open = match language {
            "go" => upper(&node.name),
            "py" => spoken_for(&node.name) && within(path, held.root, "src"),
            "dart" => spoken_for(&node.name),
            "jl" => {
                spoken_for(&node.name)
                    && within(path, held.root, "src")
                    && !node.modifiers.private_member
            }
            "rb" | "ex" | "exs" | "kt" | "kts" | "lua" => {
                spoken_for(&node.name)
                    && !node.modifiers.private_member
                    && !node.modifiers.protected_member
            }
            held_as if HEADERS.contains(&held_as) => {
                within(path, held.root, "include") || within(path, held.root, "single_include")
            }
            _ => node.modifiers.exported || manifests[at].iter().any(|named| named == path),
        };
        if open {
            kept[at].push(node);
        }
    }

    let mut found = Vec::new();
    for (at, mut kept) in kept.into_iter().enumerate() {
        let names = &manifests[at];
        kept.sort_by(|left, right| {
            names
                .iter()
                .any(|named| named == &files[right.file as usize])
                .cmp(&names.iter().any(|named| named == &files[left.file as usize]))
                .then(left.id.cmp(&right.id))
        });
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
                guards: Vec::new(),
                registrar: "published".to_string(),
                unshipped: None,
            });
        }
    }
    found
}

fn is_a_declaration_file(path: &str) -> bool {
    [".d.ts", ".d.mts", ".d.cts"].iter().any(|ending| path.ends_with(ending))
}

pub fn offered_from(path: &str) -> &str {
    let held = path.rsplit_once('.').map(|(held, _)| held).unwrap_or(path);
    held.strip_suffix("/mod").or_else(|| held.strip_suffix("/index")).unwrap_or(held)
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
    fn a_language_that_writes_no_keyword_is_not_read_as_publishing_nothing() {
        assert!(spoken_for("Acoustics.Playback"));
        assert!(spoken_for("Pages::Renderer"));
        assert!(!spoken_for("_internal"));
    }

    #[test]
    fn a_name_is_offered_from_the_module_that_declares_it() {
        assert_eq!(offered_from("middleware/cors.go"), "middleware/cors");
        assert_eq!(offered_from("bind.go"), "bind");
        assert_eq!(offered_from("src/router/mod.rs"), "src/router");
        assert_eq!(offered_from("lib/parse/index.ts"), "lib/parse");
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
