use rustc_hash::FxHashMap as HashMap;

use rustc_hash::FxHashSet as HashSet;

use crate::model::{CallFact, IndexNode, LocalBinding};
use crate::names;
use crate::paths::{directory_of, join};

const MOUNTERS: &[&str] = &["include_router", "mount", "nest", "register", "register_blueprint", "use"];
const PREFIX_KEYS: &[&str] = &["prefix", "url_prefix"];
const SOURCE_SUFFIXES: &[&str] =
    &["", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", "/index.js", "/index.ts", "/index.mjs"];
const ANCESTORS_AT_MOST: u8 = 8;

struct Mount {
    parent: u32,
    prefix: String,
}

fn joined(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    match (base.is_empty(), path.is_empty()) {
        (_, true) => base.to_string(),
        (true, false) => format!("/{path}"),
        (false, false) => format!("{base}/{path}"),
    }
}

fn quoted(value: &str) -> Option<&str> {
    let held = value.trim();
    let inner = held.strip_prefix(['"', '\'']).and_then(|rest| rest.strip_suffix(['"', '\'']))?;
    Some(inner)
}

fn expression_root(text: &str) -> Option<&str> {
    let held = text.trim();
    let end = held.find(['.', '(', ':', ' ', '[']).unwrap_or(held.len());
    let root = &held[..end];
    let spoken = !root.is_empty()
        && root.chars().all(|letter| letter.is_alphanumeric() || letter == '_' || letter == '$')
        && !root.chars().next().is_some_and(|first| first.is_ascii_digit());
    spoken.then_some(root)
}

fn field_defaults<'a>(locals: &'a [LocalBinding]) -> HashMap<&'a str, Vec<&'a str>> {
    let mut held: HashMap<&str, Vec<&str>> = HashMap::default();
    for local in locals {
        if let Some(written) = local.written.as_deref().filter(|written| written.starts_with('/')) {
            let values = held.entry(local.name.as_str()).or_default();
            if !values.contains(&written) {
                values.push(written);
            }
        }
    }
    held
}

fn prefix_of(call: &CallFact, defaults: &HashMap<&str, Vec<&str>>) -> String {
    let leaf = names::leaf(&call.callee);
    let keyword = call.literals.iter().find_map(|literal| {
        let (named, value) = literal.split_once('=')?;
        PREFIX_KEYS.contains(&named.trim()).then_some(value.trim())
    });
    let spoken = match keyword {
        Some(value) => Some(value),
        None if matches!(leaf, "use" | "nest" | "mount") => {
            call.literals.first().map(String::as_str).filter(|first| first.starts_with('/'))
        }
        None => None,
    };
    let Some(value) = spoken else { return String::new() };
    if let Some(literal) = quoted(value) {
        return literal.to_string();
    }
    if value.starts_with('/') {
        return value.to_string();
    }
    let name = value.rsplit(['.', ':']).next().unwrap_or(value).trim();
    match defaults.get(name).map(Vec::as_slice) {
        Some([only]) => (*only).to_string(),
        _ => String::new(),
    }
}

fn relative_file(files: &HashMap<&str, u32>, from: &str, specifier: &str) -> Option<u32> {
    if !specifier.starts_with('.') {
        return None;
    }
    let base = join(directory_of(from), specifier);
    SOURCE_SUFFIXES.iter().find_map(|suffix| files.get(format!("{base}{suffix}").as_str()).copied())
}

pub struct Prefixes {
    pub files: HashMap<u32, String>,
    pub children: HashSet<u32>,
    pub units: HashMap<String, String>,
}

impl Prefixes {
    pub fn within(&self, unit: &str, parents: &HashMap<&str, &str>) -> Option<String> {
        let mut chain: Vec<&str> = Vec::new();
        let mut current = Some(unit);
        for _ in 0..16 {
            let Some(at) = current else { break };
            if let Some(found) = self.units.get(at) {
                chain.push(found.as_str());
            }
            current = parents.get(at).copied();
        }
        if chain.is_empty() {
            return None;
        }
        Some(chain.iter().rev().fold(String::new(), |base, next| joined(&base, next)))
    }
}

pub fn plugin_prefixes(nodes: &[IndexNode], calls: &[CallFact], files: &[String]) -> HashMap<String, String> {
    let mut found: HashMap<String, String> = HashMap::default();
    for call in calls {
        if names::leaf(&call.callee) != "register" {
            continue;
        }
        let caller = call.caller.as_deref().unwrap_or(files[call.file as usize].as_str());
        let Some(prefix) = call.literals.iter().find_map(|literal| literal.strip_prefix("prefix=")) else { continue };
        let value = quoted(prefix).map(str::to_string).or_else(|| prefix.starts_with('/').then(|| prefix.to_string()));
        let Some(value) = value else { continue };
        let plugin = nodes.iter().find(|node| {
            node.file == call.file
                && node.parent.as_deref() == Some(caller)
                && node.callback_of.as_deref().is_some_and(|registrar| names::leaf(registrar) == "register")
                && node.span.line >= call.line
                && node.span.line <= call.line + 3
        });
        if let Some(plugin) = plugin {
            found.insert(plugin.id.clone(), value);
        }
    }
    found
}

pub fn composed(
    own: HashMap<u32, String>,
    calls: &[CallFact],
    locals: &[LocalBinding],
    files: &[String],
    nodes: &[IndexNode],
    through: &HashMap<(u32, String), String>,
    imported: &HashMap<(u32, String), String>,
) -> Prefixes {
    let by_path: HashMap<&str, u32> = files.iter().enumerate().map(|(at, path)| (path.as_str(), at as u32)).collect();
    let mut required_on_line: HashMap<(u32, u32), &str> = HashMap::default();
    for call in calls {
        if call.receiver.is_none()
            && call.callee == "require"
            && let Some(specifier) = call.literals.first()
        {
            required_on_line.entry((call.file, call.line)).or_insert(specifier.as_str());
        }
    }
    let mut required: HashMap<(u32, &str), u32> = HashMap::default();
    for local in locals {
        if local.from_call.as_deref() != Some("require") {
            continue;
        }
        let Some(specifier) = required_on_line.get(&(local.file, local.line)) else { continue };
        if let Some(target) = relative_file(&by_path, &files[local.file as usize], specifier) {
            required.entry((local.file, local.name.as_str())).or_insert(target);
        }
    }
    let defaults = field_defaults(locals);
    let units = plugin_prefixes(nodes, calls, files);
    let reach = |file: u32, root: &str| -> Option<u32> {
        if let Some(path) = through.get(&(file, root.to_string())) {
            return by_path.get(path.as_str()).copied();
        }
        if let Some(id) = imported.get(&(file, root.to_string())) {
            return by_path.get(id.split(':').next().unwrap_or(id)).copied();
        }
        required.get(&(file, root)).copied()
    };
    let mut mounted_by: HashMap<u32, Vec<Mount>> = HashMap::default();
    for call in calls {
        if !MOUNTERS.contains(&names::leaf(&call.callee)) {
            continue;
        }
        let prefix = prefix_of(call, &defaults);
        let mut roots: Vec<&str> = call
            .literals
            .iter()
            .filter(|literal| !literal.contains('=') || literal.contains("::"))
            .filter_map(|literal| expression_root(literal))
            .collect();
        roots.extend(call.passes.iter().filter_map(|passed| passed.split_once('=').map(|(_, root)| root)));
        roots.sort_unstable();
        roots.dedup();
        for root in roots {
            let Some(child) = reach(call.file, root).filter(|child| *child != call.file) else { continue };
            mounted_by.entry(child).or_default().push(Mount { parent: call.file, prefix: prefix.clone() });
        }
        if let Some(specifier) = required_on_line.get(&(call.file, call.line))
            && let Some(child) = relative_file(&by_path, &files[call.file as usize], specifier).filter(|child| *child != call.file)
        {
            mounted_by.entry(child).or_default().push(Mount { parent: call.file, prefix: prefix.clone() });
        }
    }
    if mounted_by.is_empty() {
        return Prefixes { files: own, children: HashSet::default(), units };
    }
    let mut known: HashMap<u32, String> = HashMap::default();
    let mut every: Vec<u32> = own.keys().chain(mounted_by.keys()).copied().collect();
    every.sort_unstable();
    every.dedup();
    for file in every {
        let found = effective(file, &own, &mounted_by, 0);
        if !found.is_empty() {
            known.insert(file, found);
        }
    }
    Prefixes { files: known, children: mounted_by.keys().copied().collect(), units }
}

fn effective(file: u32, own: &HashMap<u32, String>, mounted_by: &HashMap<u32, Vec<Mount>>, depth: u8) -> String {
    let above = match mounted_by.get(&file) {
        Some(mounts) if depth < ANCESTORS_AT_MOST => {
            let mut options: Vec<String> = mounts
                .iter()
                .map(|mount| joined(&effective(mount.parent, own, mounted_by, depth + 1), &mount.prefix))
                .collect();
            options.sort();
            options.dedup();
            match options.as_slice() {
                [only] => only.clone(),
                _ => String::new(),
            }
        }
        _ => String::new(),
    };
    match own.get(&file) {
        Some(held) => joined(&above, held),
        None => above,
    }
}

#[cfg(test)]
mod tests {
    use super::{expression_root, joined, quoted};

    #[test]
    fn prefixes_join_with_one_slash() {
        assert_eq!(joined("", "/items"), "/items");
        assert_eq!(joined("/api/v1", "/items"), "/api/v1/items");
        assert_eq!(joined("/api/", "items"), "/api/items");
        assert_eq!(joined("/api", ""), "/api");
    }

    #[test]
    fn a_child_is_named_by_the_root_of_its_expression() {
        assert_eq!(expression_root("login.router"), Some("login"));
        assert_eq!(expression_root("users::routes()"), Some("users"));
        assert_eq!(expression_root("api_router"), Some("api_router"));
        assert_eq!(expression_root("/api"), None);
    }

    #[test]
    fn a_quoted_prefix_loses_its_quotes() {
        assert_eq!(quoted("\"/items\""), Some("/items"));
        assert_eq!(quoted("settings.API"), None);
    }
}
