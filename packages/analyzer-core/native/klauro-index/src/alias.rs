use std::collections::{HashMap, HashSet};

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
        let mut packages: HashMap<String, String> = HashMap::new();
        for path in files {
            if basename(path) == "package.json"
                && let Some(name) = value_of(&children, path, "name")
            {
                packages.entry(name).or_insert_with(|| directory_of(path).to_string());
            }
        }
        let mut entries = Vec::new();
        for path in files {
            let name = basename(path).to_ascii_lowercase();
            let home = directory_of(path);
            if name.ends_with(".json") && (name.starts_with("tsconfig") || name.starts_with("jsconfig"))
            {
                declared_paths(&children, &packages, path, home, &mut entries);
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
            if name == "cargo.toml" {
                entries.push(Entry {
                    scope: home.to_string(),
                    prefix: "crate".to_string(),
                    wildcard: true,
                    target: join(home, "src"),
                });
                if let Some(package) = section(&children, path, "package")
                    && let Some(crate_name) = value_of(&children, &package.id, "name")
                {
                    entries.push(Entry {
                        scope: String::new(),
                        prefix: crate_name.replace('-', "_"),
                        wildcard: true,
                        target: join(home, "src"),
                    });
                }
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
            if crate::bundler::is_config(path) {
                bundled_aliases(&children, path, home, &mut entries);
                if let Some(mapped) = section(&children, path, "moduleNameMapper") {
                    mapped_modules(&children, &mapped.id, home, &mut entries);
                }
            }
            if name == "package.json" {
                subpath_imports(&children, path, home, &mut entries);
                if let Some(runner) = section(&children, path, "jest")
                    && let Some(mapped) = section(&children, &runner.id, "moduleNameMapper")
                {
                    mapped_modules(&children, &mapped.id, home, &mut entries);
                }
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
        let held = holdings(files);
        entries.retain(|entry| entry.holds(&held));
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
        let written = specifier.replace("::", "/");
        self.entries
            .iter()
            .filter(|entry| !entry.prefix.is_empty() && contains(&entry.scope, from))
            .any(|entry| entry.matched(&written).is_some())
    }

    pub fn expand(&self, from: &str, specifier: &str) -> Vec<String> {
        let written = specifier.replace("::", "/");
        self.entries
            .iter()
            .filter(|entry| contains(&entry.scope, from))
            .filter_map(|entry| entry.matched(&written))
            .collect()
    }
}

fn holdings(files: &[String]) -> HashSet<&str> {
    let mut held = HashSet::new();
    for path in files {
        held.insert(path.as_str());
        let mut folder = directory_of(path);
        while !folder.is_empty() {
            if !held.insert(folder) {
                break;
            }
            folder = directory_of(folder);
        }
    }
    held
}

impl Entry {
    fn holds(&self, held: &HashSet<&str>) -> bool {
        let target = match self.target.split_once('*') {
            Some((head, _)) => head.trim_end_matches('/'),
            None => self.target.as_str(),
        };
        target.is_empty() || held.contains(target) || held.contains(directory_of(target))
    }

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
    packages: &HashMap<String, String>,
    path: &str,
    scope: &str,
    entries: &mut Vec<Entry>,
) {
    let mut read = vec![path.to_string()];
    let mut seen: HashSet<String> = HashSet::new();
    while let Some(config) = read.pop() {
        if !seen.insert(config.clone()) {
            continue;
        }
        mapped_paths(children, &config, scope, entries);
        read.extend(extended(children, packages, &config));
    }
}

fn extended(
    children: &HashMap<&str, Vec<&IndexNode>>,
    packages: &HashMap<String, String>,
    path: &str,
) -> Vec<String> {
    let home = directory_of(path);
    let mut named = Vec::new();
    if let Some(value) = value_of(children, path, "extends") {
        named.push(value);
    }
    if let Some(several) = section(children, path, "extends") {
        named.extend(
            children
                .get(several.id.as_str())
                .into_iter()
                .flatten()
                .map(|base| base.name.clone()),
        );
    }
    named
        .iter()
        .filter_map(|base| located(packages, home, base))
        .collect()
}

fn located(packages: &HashMap<String, String>, home: &str, base: &str) -> Option<String> {
    let base = match base.starts_with('.') {
        true => normalize(&join(home, base)),
        false => {
            let segments: Vec<&str> = base.split('/').collect();
            let owned = match base.starts_with('@') {
                true => segments.first().zip(segments.get(1)).map(|(scope, name)| {
                    (format!("{scope}/{name}"), segments[2.min(segments.len())..].join("/"))
                }),
                false => segments
                    .first()
                    .map(|name| ((*name).to_string(), segments[1.min(segments.len())..].join("/"))),
            }?;
            let (package, rest) = owned;
            let home = packages.get(&package)?;
            match rest.is_empty() {
                true => join(home, "tsconfig.json"),
                false => join(home, &rest),
            }
        }
    };
    Some(match base.ends_with(".json") {
        true => base,
        false => format!("{base}.json"),
    })
}

fn mapped_paths(
    children: &HashMap<&str, Vec<&IndexNode>>,
    path: &str,
    scope: &str,
    entries: &mut Vec<Entry>,
) {
    let home = directory_of(path);
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
                scope: scope.to_string(),
                prefix: prefix.clone(),
                wildcard,
                target: normalize(&join(&base, &target)),
            });
        }
    }
}

fn bundled_aliases(
    children: &HashMap<&str, Vec<&IndexNode>>,
    path: &str,
    home: &str,
    entries: &mut Vec<Entry>,
) {
    let Some(declared) = section(children, path, "alias") else { return };
    for alias in children.get(declared.id.as_str()).into_iter().flatten() {
        let Some(target) = alias.type_annotation.as_deref() else { continue };
        entries.push(Entry {
            scope: home.to_string(),
            prefix: alias.name.trim_end_matches('/').to_string(),
            wildcard: true,
            target: normalize(&join(home, target)),
        });
    }
}

fn mapped_modules(
    children: &HashMap<&str, Vec<&IndexNode>>,
    declared: &str,
    home: &str,
    entries: &mut Vec<Entry>,
) {
    for mapped in children.get(declared).into_iter().flatten() {
        let (Some((prefix, wildcard)), Some(target)) = (
            matched_prefix(&mapped.name),
            mapped.type_annotation.as_deref(),
        ) else {
            continue;
        };
        let target = target.replace("<rootDir>/", "").replace("<rootDir>", "").replace("$1", "*");
        entries.push(Entry {
            scope: home.to_string(),
            prefix,
            wildcard,
            target: normalize(&join(home, &target)),
        });
    }
}

fn matched_prefix(pattern: &str) -> Option<(String, bool)> {
    let body = pattern.trim().trim_start_matches('^');
    let body = body.strip_suffix('$').unwrap_or(body);
    let mut literal = String::new();
    let mut letters = body.char_indices();
    let mut rest = "";
    while let Some((at, letter)) = letters.next() {
        match letter {
            '\\' => match letters.next() {
                Some((_, escaped)) => literal.push(escaped),
                None => return None,
            },
            '(' | '[' | '{' | '*' | '+' | '?' | '.' | '|' | ')' | ']' | '}' => {
                rest = &body[at..];
                break;
            }
            plain => literal.push(plain),
        }
    }
    let literal = literal.trim_end_matches('/').to_string();
    if literal.is_empty() {
        return None;
    }
    match rest {
        "" => Some((literal, false)),
        "(.*)" | "(.+)" | ".*" | ".+" => Some((literal, true)),
        _ => None,
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
