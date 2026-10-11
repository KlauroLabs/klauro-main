use rustc_hash::FxHashMap as HashMap;
use serde::{Deserialize, Serialize};

use crate::model::RegistrationFact;

static VERBS: &[&str] = &["delete", "get", "head", "options", "patch", "post", "put"];
const MOUNT: &str = "sub";
const NESTED_AT_MOST: usize = 32;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RouteTable {
    pub file: u32,
    pub line: u32,
    pub table: String,
    pub routes: Vec<(String, String, String)>,
    pub mounts: Vec<(String, String)>,
}

fn leaf(path: &str) -> &str {
    path.rsplit("::").next().unwrap_or(path).trim()
}

fn literal_at(text: &str, at: usize) -> Option<(String, usize)> {
    let rest = &text[at + 1..];
    let end = rest.find('"')?;
    Some((rest[..end].to_string(), at + 1 + end + 1))
}

fn served_at(text: &str, from: usize) -> (&str, usize) {
    let rest = &text[from..];
    let mut depth = 0i32;
    for (at, letter) in rest.char_indices() {
        match letter {
            '(' | '[' => depth += 1,
            ')' | ']' if depth == 0 => return (&rest[..at], from + at),
            ')' | ']' => depth -= 1,
            ',' if depth == 0 => return (&rest[..at], from + at),
            _ => {}
        }
    }
    (rest, text.len())
}

fn calls_in(served: &str) -> Vec<(&str, &str)> {
    let mut found = Vec::new();
    let mut rest = served;
    while let Some(open) = rest.find('(') {
        let before = &rest[..open];
        let callee = before.rsplit(|letter: char| !(letter.is_alphanumeric() || letter == '_' || letter == ':')).next().unwrap_or_default();
        let after = &rest[open + 1..];
        let Some(close) = after.find(')') else { break };
        found.push((leaf(callee), after[..close].trim()));
        rest = &after[close + 1..];
    }
    found
}

pub fn read(text: &str) -> (Vec<(String, String, String)>, Vec<(String, String)>) {
    let mut routes = Vec::new();
    let mut mounts = Vec::new();
    let mut at = 0;
    while let Some(found) = text[at..].find('"') {
        let start = at + found;
        let Some((path, after)) = literal_at(text, start) else { break };
        let arrow = text[after..].trim_start();
        if !arrow.starts_with("=>") || !(path.is_empty() || path.starts_with('/')) {
            at = after;
            continue;
        }
        let from = text.len() - arrow.len() + 2;
        let (served, end) = served_at(text, from);
        for (callee, argument) in calls_in(served) {
            match callee {
                MOUNT if !argument.is_empty() => mounts.push((path.clone(), leaf(argument).to_string())),
                verb if VERBS.contains(&verb) && !argument.is_empty() => routes.push((verb.to_ascii_uppercase(), path.clone(), leaf(argument).to_string())),
                _ => {}
            }
        }
        at = end.max(after);
    }
    (routes, mounts)
}

fn joined(base: &str, path: &str) -> String {
    let joined = format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'));
    match joined.trim_end_matches('/') {
        "" => "/".to_string(),
        held => held.to_string(),
    }
}

fn prefixes(table: &str, mounted_by: &HashMap<&str, Vec<(&str, &str)>>, depth: usize) -> Vec<String> {
    match mounted_by.get(table) {
        Some(parents) if depth < NESTED_AT_MOST => parents
            .iter()
            .flat_map(|(parent, base)| prefixes(parent, mounted_by, depth + 1).into_iter().map(move |prefix| joined(&prefix, base)))
            .collect(),
        _ => vec![String::new()],
    }
}

pub fn composed(tables: &[RouteTable]) -> Vec<RegistrationFact> {
    let mut mounted_by: HashMap<&str, Vec<(&str, &str)>> = HashMap::default();
    for table in tables {
        for (base, child) in &table.mounts {
            mounted_by.entry(child.as_str()).or_default().push((table.table.as_str(), base.as_str()));
        }
    }
    let mut registered = Vec::new();
    for table in tables {
        for prefix in prefixes(&table.table, &mounted_by, 0) {
            for (verb, path, handler) in &table.routes {
                registered.push(RegistrationFact {
                    file: table.file,
                    registrar: "route".to_string(),
                    label: format!("{verb} {}", joined(&prefix, path)),
                    handler: handler.clone(),
                    line: table.line,
                    through: Vec::new(),
                });
            }
        }
    }
    registered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_route_table_names_each_path_with_the_verbs_and_handlers_that_serve_it_and_the_tables_it_mounts() {
        let (routes, mounts) = read(r#"#[routes::routes(routes("" => [post(create_key), get(list_keys)], "/{key}" => [get(get_key), delete(delete_key)], "/stats" => get(crate::stats::get_stats), "/keys" => sub(api_key::KeyApi)), tag = "Keys")]"#);
        assert_eq!(routes, [("POST".into(), "".into(), "create_key".into()), ("GET".into(), "".into(), "list_keys".into()), ("GET".into(), "/{key}".into(), "get_key".into()), ("DELETE".into(), "/{key}".into(), "delete_key".into()), ("GET".into(), "/stats".into(), "get_stats".into())]);
        assert_eq!(mounts, [("/keys".to_string(), "KeyApi".to_string())]);
    }

    #[test]
    fn a_table_s_routes_sit_under_every_path_the_tables_above_it_mount_it_at() {
        let root = RouteTable { file: 0, line: 1, table: "Root".into(), routes: vec![("GET".into(), "/health".into(), "health".into())], mounts: vec![("/keys".into(), "KeyApi".into())] };
        let keys = RouteTable { file: 1, line: 3, table: "KeyApi".into(), routes: vec![("GET".into(), "".into(), "list_keys".into()), ("GET".into(), "/{key}".into(), "get_key".into())], mounts: Vec::new() };
        let labels: Vec<String> = composed(&[root, keys]).into_iter().map(|held| held.label).collect();
        assert_eq!(labels, ["GET /health", "GET /keys", "GET /keys/{key}"]);
    }

    #[test]
    fn text_without_a_route_table_reads_as_nothing() {
        assert_eq!(read(r#"#[derive(Debug)] #[serde(rename = "x")]"#), (Vec::new(), Vec::new()));
    }
}
