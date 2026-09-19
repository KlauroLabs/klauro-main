use std::collections::HashMap;

use crate::model::{IndexNode, NodeKind};
use crate::paths::{basename, contains, directory_of, join, normalize};

pub struct Aliases {
    entries: Vec<Entry>,
}

struct Entry {
    scope: String,
    prefix: String,
    wildcard: bool,
    target: String,
}

impl Aliases {
    pub fn read(files: &[String], nodes: &[IndexNode]) -> Aliases {
        let mut children: HashMap<&str, Vec<&IndexNode>> = HashMap::new();
        for node in nodes {
            if let Some(parent) = node.parent.as_deref() {
                children.entry(parent).or_default().push(node);
            }
        }
        let mut entries = Vec::new();
        for path in files {
            let name = basename(path).to_ascii_lowercase();
            let home = directory_of(path);
            if name.ends_with(".json") && (name.starts_with("tsconfig") || name.starts_with("jsconfig"))
            {
                declared_paths(&children, path, home, &mut entries);
            }
            if name.starts_with("nuxt.config.") {
                for prefix in ["~", "@"] {
                    for target in [join(home, "app"), home.to_string()] {
                        entries.push(Entry {
                            scope: home.to_string(),
                            prefix: prefix.to_string(),
                            wildcard: true,
                            target,
                        });
                    }
                }
                for prefix in ["~~", "@@"] {
                    entries.push(Entry {
                        scope: home.to_string(),
                        prefix: prefix.to_string(),
                        wildcard: true,
                        target: home.to_string(),
                    });
                }
                entries.push(Entry {
                    scope: home.to_string(),
                    prefix: "#shared".to_string(),
                    wildcard: true,
                    target: join(home, "shared"),
                });
            }
            if name == "go.mod"
                && let Some(module) = value_of(&children, path, "module")
            {
                entries.push(Entry {
                    scope: home.to_string(),
                    prefix: module,
                    wildcard: true,
                    target: home.to_string(),
                });
            }
            if name == "package.json" {
                subpath_imports(&children, path, home, &mut entries);
            }
            if name.starts_with("svelte.config.") {
                entries.push(Entry {
                    scope: home.to_string(),
                    prefix: "$lib".to_string(),
                    wildcard: true,
                    target: join(home, "src/lib"),
                });
            }
            if name == "pubspec.yaml"
                && let Some(package) = value_of(&children, path, "name")
            {
                entries.push(Entry {
                    scope: home.to_string(),
                    prefix: format!("package:{package}"),
                    wildcard: true,
                    target: join(home, "lib"),
                });
            }
        }
        entries.sort_by(|left, right| {
            right
                .prefix
                .len()
                .cmp(&left.prefix.len())
                .then(right.scope.len().cmp(&left.scope.len()))
        });
        Aliases { entries }
    }

    pub fn declares(&self, from: &str, specifier: &str) -> bool {
        self.entries
            .iter()
            .filter(|entry| !entry.prefix.is_empty() && contains(&entry.scope, from))
            .any(|entry| entry.matched(specifier).is_some())
    }

    pub fn expand(&self, from: &str, specifier: &str) -> Vec<String> {
        self.entries
            .iter()
            .filter(|entry| contains(&entry.scope, from))
            .filter_map(|entry| entry.matched(specifier))
            .collect()
    }
}

impl Entry {
    fn matched(&self, specifier: &str) -> Option<String> {
        if !self.wildcard {
            return (specifier == self.prefix).then(|| self.target.clone());
        }
        let rest = match self.prefix.is_empty() {
            true => specifier,
            false => match specifier.strip_prefix(&self.prefix)? {
                "" => "",
                rest => rest.strip_prefix('/')?,
            },
        };
        Some(match self.target.split_once('*') {
            Some((head, tail)) => format!("{head}{rest}{tail}"),
            None => join(&self.target, rest),
        })
    }
}

fn declared_paths(
    children: &HashMap<&str, Vec<&IndexNode>>,
    path: &str,
    home: &str,
    entries: &mut Vec<Entry>,
) {
    let Some(options) = section(children, path, "compilerOptions") else { return };
    let base = match value_of(children, &options.id, "baseUrl") {
        Some(base) => normalize(&join(home, &base)),
        None => home.to_string(),
    };
    let Some(paths) = section(children, &options.id, "paths") else { return };
    for alias in children.get(paths.id.as_str()).into_iter().flatten() {
        let (prefix, wildcard) = match alias.name.split_once('*') {
            Some((prefix, _)) => (prefix.trim_end_matches('/').to_string(), true),
            None => (alias.name.clone(), false),
        };
        let targets: Vec<String> = match alias.kind {
            NodeKind::Property => alias
                .type_annotation
                .as_deref()
                .map(|value| vec![unquoted(value).to_string()])
                .unwrap_or_default(),
            _ => children
                .get(alias.id.as_str())
                .into_iter()
                .flatten()
                .map(|target| target.name.clone())
                .collect(),
        };
        for target in targets {
            entries.push(Entry {
                scope: home.to_string(),
                prefix: prefix.clone(),
                wildcard,
                target: normalize(&join(&base, &target)),
            });
        }
    }
}

fn subpath_imports(
    children: &HashMap<&str, Vec<&IndexNode>>,
    path: &str,
    home: &str,
    entries: &mut Vec<Entry>,
) {
    let Some(imports) = section(children, path, "imports") else { return };
    for subpath in children.get(imports.id.as_str()).into_iter().flatten() {
        if !subpath.name.starts_with('#') {
            continue;
        }
        let (prefix, wildcard) = match subpath.name.split_once('*') {
            Some((prefix, _)) => (prefix.trim_end_matches('/').to_string(), true),
            None => (subpath.name.clone(), false),
        };
        let Some(target) = subpath.type_annotation.as_deref().map(unquoted) else { continue };
        entries.push(Entry {
            scope: home.to_string(),
            prefix,
            wildcard,
            target: normalize(&join(home, target)),
        });
    }
}

fn section<'a>(
    children: &HashMap<&str, Vec<&'a IndexNode>>,
    parent: &str,
    name: &str,
) -> Option<&'a IndexNode> {
    children
        .get(parent)?
        .iter()
        .find(|node| node.name == name && node.kind == NodeKind::Class)
        .copied()
}

fn value_of(children: &HashMap<&str, Vec<&IndexNode>>, parent: &str, name: &str) -> Option<String> {
    children
        .get(parent)?
        .iter()
        .find(|node| node.name == name && node.kind == NodeKind::Property)
        .and_then(|node| node.type_annotation.as_deref())
        .map(|value| unquoted(value).to_string())
}

fn unquoted(value: &str) -> &str {
    value.trim().trim_matches('"')
}
