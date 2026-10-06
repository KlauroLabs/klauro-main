use std::path::Path;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::model::*;
use crate::names;

static COMPONENTS: &str = include_str!("../data/components.tsv");

struct Table {
    bases: HashSet<&'static str>,
    markers: HashSet<&'static str>,
}

fn table() -> Table {
    let mut bases = HashSet::default();
    let mut markers = HashSet::default();
    for row in COMPONENTS.lines().filter(|row| !row.trim().is_empty()) {
        match row.split_once('\t') {
            Some(("base", named)) => bases.insert(named),
            Some(("marker", named)) => markers.insert(named),
            _ => false,
        };
    }
    Table { bases, markers }
}

fn tag_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'$')
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= haystack.len() {
        return None;
    }
    haystack[from..].windows(needle.len()).position(|window| window == needle).map(|offset| from + offset)
}

fn is_a_block(source: &[u8], at: usize) -> Option<&'static [u8]> {
    [&b"script"[..], &b"style"[..]].into_iter().find(|name| {
        let end = at + 1 + name.len();
        source.get(at + 1..end).is_some_and(|held| held.eq_ignore_ascii_case(name))
            && source.get(end).is_none_or(|next| !tag_name_byte(*next))
    })
}

pub fn tags(source: &[u8]) -> Vec<(String, u32)> {
    let mut found = Vec::new();
    let mut line = 1u32;
    let mut at = 0;
    while at < source.len() {
        match source[at] {
            b'\n' => {
                line += 1;
                at += 1;
            }
            b'<' if source[at..].starts_with(b"<!--") => {
                let end = find(source, b"-->", at + 4).map_or(source.len(), |end| end + 3);
                line += source[at..end].iter().filter(|byte| **byte == b'\n').count() as u32;
                at = end;
            }
            b'<' if source.get(at + 1).is_some_and(|next| next.is_ascii_alphabetic()) => {
                if let Some(block) = is_a_block(source, at) {
                    let mut closing = b"</".to_vec();
                    closing.extend_from_slice(block);
                    let end = find(source, &closing, at).map_or(source.len(), |end| end + closing.len());
                    line += source[at..end].iter().filter(|byte| **byte == b'\n').count() as u32;
                    at = end;
                    continue;
                }
                let start = at + 1;
                let mut end = start;
                while end < source.len() && tag_name_byte(source[end]) {
                    end += 1;
                }
                if let Ok(named) = std::str::from_utf8(&source[start..end]) {
                    found.push((named.to_string(), line));
                }
                at = end;
            }
            _ => at += 1,
        }
    }
    found
}

fn component_name(tag: &str) -> Option<String> {
    if tag.contains(['.', ':']) {
        return None;
    }
    if !tag.contains('-') {
        return Some(tag.to_string());
    }
    Some(
        tag.split('-')
            .filter(|part| !part.is_empty())
            .map(|part| {
                let mut letters = part.chars();
                letters.next().map(|first| first.to_ascii_uppercase().to_string() + letters.as_str()).unwrap_or_default()
            })
            .collect(),
    )
}

pub fn template_renders(source: &[u8], file: u32, path: &str, imports: &[ImportFact]) -> Vec<CallFact> {
    let bound: HashSet<&str> = imports
        .iter()
        .filter(|held| !held.type_only)
        .flat_map(|held| held.names.iter().map(|name| name.local.as_str()))
        .collect();
    let mut seen: HashSet<String> = HashSet::default();
    let mut found = Vec::new();
    for (tag, line) in tags(source) {
        let Some(named) = component_name(&tag).filter(|named| bound.contains(named.as_str())) else { continue };
        if !seen.insert(named.clone()) {
            continue;
        }
        found.push(CallFact {
            file,
            caller: Some(path.to_string()),
            callee: named,
            receiver: None,
            line,
            column: 0,
            argument_count: 0,
            literals: Vec::new(),
            constructs: true,
            renders: true,
            type_arguments: Vec::new(),
            context: CallContext::default(),
            passes: Vec::new(),
        });
    }
    found
}

pub fn property_text(object: &str, key: &str) -> Option<String> {
    let mut from = 0;
    while let Some(at) = object[from..].find(key).map(|found| found + from) {
        from = at + key.len();
        let before = object[..at].chars().next_back();
        if before.is_some_and(|held| held.is_alphanumeric() || held == '_') {
            continue;
        }
        let rest = object[from..].trim_start();
        let Some(rest) = rest.strip_prefix(':').or_else(|| rest.strip_prefix('=')) else { continue };
        let rest = rest.trim_start();
        let quote = rest.chars().next().filter(|held| matches!(held, '\'' | '"' | '`'))?;
        let inner = &rest[1..];
        let mut escaped = false;
        for (position, letter) in inner.char_indices() {
            if escaped {
                escaped = false;
            } else if letter == '\\' {
                escaped = true;
            } else if letter == quote {
                return Some(inner[..position].to_string());
            }
        }
        return None;
    }
    None
}

fn selectors(declared: &str) -> Vec<String> {
    declared
        .split(',')
        .map(str::trim)
        .filter(|selector| !selector.is_empty() && selector.chars().all(|held| held.is_ascii_alphanumeric() || matches!(held, '-' | '_')))
        .map(str::to_string)
        .collect()
}

struct Declared<'a> {
    class: &'a IndexNode,
    selectors: Vec<String>,
    template: Option<Vec<u8>>,
}

fn angular_components<'a>(root: &Path, paths: &[String], nodes: &'a [IndexNode]) -> Vec<Declared<'a>> {
    nodes
        .iter()
        .filter(|node| node.kind == NodeKind::Class)
        .filter_map(|node| {
            let decorator = node.decorators.iter().find(|held| names::leaf(&held.name) == "Component")?;
            let object = &decorator.arguments.first()?.value;
            let selectors = property_text(object, "selector").map(|written| selectors(&written)).unwrap_or_default();
            let template = property_text(object, "template").map(String::into_bytes).or_else(|| {
                let url = property_text(object, "templateUrl")?;
                let here = paths.get(node.file as usize)?;
                let directory = Path::new(here).parent().unwrap_or(Path::new(""));
                crate::paths::read_bytes_inside(root, directory.join(url.trim_start_matches("./")))
            });
            Some(Declared { class: node, selectors, template })
        })
        .collect()
}

fn lifted<'a>(id: &'a str, callbacks: &HashSet<&str>, parents: &HashMap<&'a str, &'a str>) -> &'a str {
    let mut at = id;
    for _ in 0..4 {
        match parents.get(at) {
            Some(parent) if callbacks.contains(at) => at = parent,
            _ => break,
        }
    }
    at
}

fn owner_of<'a>(id: &'a str, components: &HashSet<&str>, parents: &HashMap<&'a str, &'a str>) -> Option<&'a str> {
    if components.contains(id) {
        return Some(id);
    }
    let parent = parents.get(id).copied()?;
    components.contains(parent).then_some(parent)
}

fn is_a_page(path: &str) -> bool {
    path.ends_with(".vue") || path.ends_with(".svelte")
}

fn pascal(word: &str) -> String {
    let mut letters = word.chars();
    letters.next().map(|first| first.to_ascii_uppercase().to_string() + letters.as_str()).unwrap_or_default()
}

fn component_keys(path: &str) -> Vec<String> {
    let stem = path.rsplit('/').next().and_then(|name| name.rsplit_once('.')).map(|(stem, _)| stem).unwrap_or("");
    if stem.is_empty() || stem == "index" {
        return Vec::new();
    }
    let folders: Vec<&str> = path.rsplit_once('/').map(|(folders, _)| folders.split('/').collect()).unwrap_or_default();
    let beneath: Vec<&str> = match folders.iter().rposition(|folder| *folder == "components") {
        Some(at) => folders[at + 1..].to_vec(),
        None => Vec::new(),
    };
    let named = component_name(stem).unwrap_or_default();
    let mut keys = vec![named.clone()];
    if !beneath.is_empty() {
        let prefix: String = beneath.iter().map(|folder| component_name(folder).unwrap_or_default()).collect();
        keys.push(if named.starts_with(&prefix) { named } else { prefix + &named });
    }
    keys
}

fn auto_imported(root: &Path, paths: &[String]) -> Vec<(String, String)> {
    let mut by_key: HashMap<String, Vec<&str>> = HashMap::default();
    for path in paths.iter().filter(|path| is_a_page(path)) {
        for key in component_keys(path) {
            by_key.entry(key).or_default().push(path.as_str());
        }
    }
    let mut found = Vec::new();
    for path in paths.iter().filter(|path| is_a_page(path)) {
        let Some(source) = crate::paths::read_bytes_inside(root, path) else { continue };
        let mut seen: HashSet<String> = HashSet::default();
        for (tag, _) in tags(&source) {
            let component = tag.starts_with(char::is_uppercase) || tag.contains('-');
            let Some(named) = component_name(&tag).filter(|_| component) else { continue };
            let named = pascal(&named);
            if let Some([only]) = by_key.get(&named).map(Vec::as_slice)
                && *only != path.as_str()
                && seen.insert(named)
            {
                found.push((path.clone(), (*only).to_string()));
            }
        }
    }
    found
}

pub fn drawn(
    root: &Path,
    paths: &[String],
    nodes: &[IndexNode],
    edges: &mut Vec<IndexEdge>,
    type_references: &[TypeReferenceFact],
) {
    let table = table();
    let mut components: HashSet<&str> = HashSet::default();
    for node in nodes {
        if node.decorators.iter().any(|held| table.markers.contains(names::leaf(&held.name))) {
            components.insert(node.id.as_str());
        }
    }
    let classes: HashMap<&str, &IndexNode> = nodes.iter().filter(|node| node.kind.is_type()).map(|node| (node.id.as_str(), node)).collect();
    for reference in type_references.iter().filter(|held| matches!(held.kind, EdgeKind::Extends | EdgeKind::Implements)) {
        if table.bases.contains(names::leaf(&reference.name)) && classes.contains_key(reference.source.as_str()) {
            components.insert(reference.source.as_str());
        }
    }
    let callbacks: HashSet<&str> =
        nodes.iter().filter(|node| node.callback_of.is_some()).map(|node| node.id.as_str()).collect();
    let parents: HashMap<&str, &str> =
        nodes.iter().filter_map(|node| node.parent.as_deref().map(|parent| (node.id.as_str(), parent))).collect();

    let mut drawn: Vec<(String, String, Via)> = Vec::new();
    for edge in edges.iter() {
        let owners = (
            owner_of(edge.source.as_str(), &components, &parents),
            owner_of(edge.target.as_str(), &components, &parents),
        );
        match (edge.kind, owners) {
            (EdgeKind::Renders, (from, to)) => {
                let from = from.unwrap_or_else(|| lifted(edge.source.as_str(), &callbacks, &parents));
                let to = to.unwrap_or_else(|| lifted(edge.target.as_str(), &callbacks, &parents));
                drawn.push((from.to_string(), to.to_string(), edge.via));
            }
            (EdgeKind::Calls | EdgeKind::Instantiates, (Some(from), Some(to))) if from != to => {
                drawn.push((from.to_string(), to.to_string(), edge.via));
            }
            _ => {}
        }
    }

    let declared = angular_components(root, paths, nodes);
    let mut by_selector: HashMap<&str, &IndexNode> = HashMap::default();
    for held in &declared {
        for selector in &held.selectors {
            by_selector.entry(selector.as_str()).or_insert(held.class);
        }
    }
    for held in &declared {
        let Some(template) = held.template.as_deref() else { continue };
        for (tag, _) in tags(template) {
            if let Some(target) = by_selector.get(tag.as_str()).filter(|target| target.id != held.class.id) {
                drawn.push((held.class.id.clone(), target.id.clone(), Via::Structure));
            }
        }
    }

    drawn.extend(auto_imported(root, paths).into_iter().map(|(from, to)| (from, to, Via::Name)));

    edges.retain(|edge| edge.kind != EdgeKind::Renders);
    let mut seen: HashSet<(String, String)> = HashSet::default();
    for (source, target, via) in drawn {
        if source != target && seen.insert((source.clone(), target.clone())) {
            edges.push(IndexEdge { source, target, kind: EdgeKind::Renders, via });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_template_names_the_components_it_draws() {
        let source = b"<template>\n  <div class=\"app\">\n    <UserCard :name=\"user.name\" />\n  <user-list/></div>\n</template>\n\n<script setup>\nimport UserCard from './UserCard.vue'\n</script>\n";
        let found: Vec<(String, u32)> = tags(source);
        assert_eq!(found, vec![("template".to_string(), 1), ("div".to_string(), 2), ("UserCard".to_string(), 3), ("user-list".to_string(), 4)]);
        assert_eq!(component_name("user-list").as_deref(), Some("UserList"));
        assert_eq!(component_name("svelte:self"), None);
    }
}
