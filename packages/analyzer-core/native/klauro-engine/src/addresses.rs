use rustc_hash::FxHashMap as HashMap;

use crate::entry_exit::ExitPoint;
use crate::model::{CallFact, IndexNode, LocalBinding};

const FOLDED_AT_MOST: usize = 4;

fn owner_of<'a>(unit: &'a str, node_of: &HashMap<&str, &'a IndexNode>) -> Option<&'a str> {
    let mut current = node_of.get(unit).copied();
    for _ in 0..8 {
        let held = current?;
        if held.kind.is_type() {
            return Some(held.id.as_str());
        }
        current = held.parent.as_deref().and_then(|parent| node_of.get(parent).copied());
    }
    None
}

fn folded(template: &str, known: &impl Fn(&str) -> Option<String>) -> String {
    let mut written = template.to_string();
    for _ in 0..FOLDED_AT_MOST {
        let mut changed = false;
        let mut out = String::with_capacity(written.len());
        let mut rest = written.as_str();
        while let Some(open) = rest.find('{') {
            let Some(close) = rest[open..].find('}').map(|at| open + at) else { break };
            out.push_str(&rest[..open]);
            let named = rest[open + 1..close].trim();
            match known(named) {
                Some(value) => {
                    out.push_str(&value);
                    changed = true;
                }
                None => out.push_str(&rest[open..=close]),
            }
            rest = &rest[close + 1..];
        }
        out.push_str(rest);
        written = out;
        if !changed {
            break;
        }
    }
    written
}

fn as_a_path(written: &str) -> Option<String> {
    let path = written.split(['?', '#']).next()?.trim();
    let path = match path.find("://") {
        Some(at) => &path[at + 3..][path[at + 3..].find('/')?..],
        None => path,
    };
    if !path.contains('/') || path.starts_with('{') || path.contains(char::is_whitespace) {
        return None;
    }
    Some(match path.starts_with('/') {
        true => path.to_string(),
        false => format!("/{path}"),
    })
}

pub fn fold(exits: &mut [ExitPoint], calls: &[CallFact], locals: &[LocalBinding], nodes: &[IndexNode]) {
    let node_of: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut written_in: HashMap<(&str, &str), &str> = HashMap::default();
    for local in locals {
        if let Some(written) = local.written.as_deref() {
            written_in.entry((local.unit.as_str(), local.name.as_str())).or_insert(written);
        }
    }
    let mut calls_at: HashMap<(u32, u32), Vec<&CallFact>> = HashMap::default();
    for call in calls {
        calls_at.entry((call.file, call.line)).or_default().push(call);
    }
    let mut built_at: HashMap<(&str, &str), (u32, u32)> = HashMap::default();
    for local in locals.iter().filter(|local| local.constructed.is_some()) {
        built_at.entry((local.unit.as_str(), local.name.as_str())).or_insert((local.file, local.line));
    }
    for exit in exits.iter_mut().filter(|exit| exit.kind == "api" && exit.addressed.is_none()) {
        let unit = exit.source.as_str();
        let owner = owner_of(unit, &node_of);
        let known = |named: &str| -> Option<String> {
            let bare = named.trim_start_matches("this.").trim_start_matches('_');
            [named, bare].into_iter().find_map(|held| {
                written_in
                    .get(&(unit, held))
                    .or_else(|| owner.and_then(|owner| written_in.get(&(owner, held))))
                    .map(|value| value.to_string())
            })
        };
        let Some(called) = calls_at.get(&(exit.file, exit.line)) else { continue };
        let named: Vec<&String> = called
            .iter()
            .filter(|call| crate::names::leaf(&call.callee).split('<').next() == exit.operation.split('<').next())
            .flat_map(|call| call.literals.iter())
            .collect();
        let built: Vec<&String> = named
            .iter()
            .filter_map(|literal| built_at.get(&(unit, literal.trim())))
            .filter_map(|at| calls_at.get(at))
            .flat_map(|held| held.iter().filter(|call| call.constructs).flat_map(|call| call.literals.iter()))
            .collect();
        let addressed = named.into_iter().chain(built).find_map(|literal| {
            let template = known(literal.trim()).unwrap_or_else(|| literal.clone());
            as_a_path(&folded(&template, &known))
        });
        exit.addressed = addressed;
    }
}

fn plainly_placed(template: &str) -> String {
    let mut written = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find("{") {
        let Some(close) = rest[open..].find('}').map(|at| open + at) else { break };
        written.push_str(rest[..open].trim_end_matches('$'));
        let inner = rest[open + 1..close].trim();
        let inner = inner
            .strip_prefix("encodeURIComponent(")
            .and_then(|held| held.strip_suffix(')'))
            .unwrap_or(inner)
            .trim_end_matches('!');
        written.push('{');
        written.push_str(inner);
        written.push('}');
        rest = &rest[close + 1..];
    }
    written.push_str(rest);
    written
}

fn parameter_named_in(template: &str, unit: &IndexNode) -> Option<usize> {
    let parameters = &unit.signature.as_ref()?.parameters;
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let close = rest[open..].find('}').map(|at| open + at)?;
        let named = rest[open + 1..close].trim();
        if let Some(at) = parameters.iter().position(|held| held.name == named) {
            return Some(at);
        }
        rest = &rest[close + 1..];
    }
    None
}

pub fn through_wrappers(exits: &mut Vec<ExitPoint>, calls: &[CallFact], nodes: &[IndexNode], files: &[String]) {
    let node_of: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut declared: HashMap<&str, u32> = HashMap::default();
    for node in nodes.iter().filter(|node| node.kind.is_unit()) {
        *declared.entry(node.name.as_str()).or_insert(0) += 1;
    }
    let mut calls_at: HashMap<(u32, u32), Vec<&CallFact>> = HashMap::default();
    for call in calls {
        calls_at.entry((call.file, call.line)).or_default().push(call);
    }
    let mut asking: HashMap<&str, usize> = HashMap::default();
    for exit in exits.iter().filter(|exit| exit.kind == "api" && exit.addressed.is_none()) {
        let Some(unit) = node_of.get(exit.source.as_str()).filter(|node| node.kind.is_unit()) else { continue };
        if declared.get(unit.name.as_str()) != Some(&1) {
            continue;
        }
        let Some(called) = calls_at.get(&(exit.file, exit.line)) else { continue };
        let position = called
            .iter()
            .filter(|call| crate::names::leaf(&call.callee).split('<').next() == exit.operation.split('<').next())
            .flat_map(|call| call.literals.iter())
            .find_map(|literal| parameter_named_in(literal, unit));
        if let Some(position) = position {
            asking.entry(unit.name.as_str()).or_insert(position);
        }
    }
    if asking.is_empty() {
        return;
    }
    let mut made = Vec::new();
    for (position, call) in calls.iter().enumerate() {
        let Some(at) = asking.get(crate::names::leaf(&call.callee).split('<').next().unwrap_or_default()).copied() else {
            continue;
        };
        let Some(caller) = call.caller.as_deref().filter(|caller| node_of.get(caller).is_some_and(|node| node.kind.is_unit())) else {
            continue;
        };
        let held = |literal: &String| as_a_path(&plainly_placed(literal));
        let template = match call.literals.len() == call.argument_count as usize {
            true => call.literals.get(at),
            false => call.literals.first().filter(|first| at == 0 && held(first).is_some()),
        };
        let Some(path) = template.and_then(held) else { continue };
        let method = call
            .literals
            .iter()
            .find_map(|literal| literal.strip_prefix("method="))
            .unwrap_or("GET")
            .to_string();
        made.push(ExitPoint {
            id: format!("exit:{}:{}:request", files[call.file as usize], position),
            kind: "api",
            name: format!("{method} {path}"),
            source: caller.to_string(),
            target: path.clone(),
            operation: method,
            file: call.file,
            line: call.line,
            awaited: call.context.awaited,
            addressed: Some(path),
            service: None,
        });
    }
    exits.extend(made);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_asked_through_a_wrapper_names_its_placeholders_plainly() {
        assert_eq!(
            as_a_path(&plainly_placed("/api/projects/${encodeURIComponent(projectId)}/flows?limit=${limit}")).as_deref(),
            Some("/api/projects/{projectId}/flows")
        );
        assert_eq!(plainly_placed("${base}${path}"), "{base}{path}");
        assert_eq!(plainly_placed("/api/projects/${projectId!}/das"), "/api/projects/{projectId}/das");
    }

    #[test]
    fn a_wrapper_is_known_by_the_parameter_its_address_is_built_from() {
        let unit = IndexNode {
            id: "x:function:ask".to_string(),
            name: "ask".to_string(),
            kind: crate::model::NodeKind::Function,
            file: 0,
            span: crate::model::Span { line: 1, column: 0, end_line: 1, end_column: 0 },
            parent: None,
            signature: Some(crate::model::Signature {
                parameters: vec![
                    crate::model::Parameter { name: "path".to_string(), ..Default::default() },
                    crate::model::Parameter { name: "token".to_string(), ..Default::default() },
                ],
                ..Default::default()
            }),
            modifiers: Default::default(),
            decorators: Vec::new(),
            type_annotation: None,
            documentation: None,
            project: None,
            callback_of: None,
            registration_label: None,
        };
        assert_eq!(parameter_named_in("${apiBaseUrl}${path}", &unit), Some(0));
        assert_eq!(parameter_named_in("/fixed/{other}", &unit), None);
    }

    #[test]
    fn a_path_built_from_a_base_field_folds_into_the_route_it_asks_for() {
        let known = |named: &str| match named {
            "remoteServiceBaseUrl" => Some("api/library/".to_string()),
            _ => None,
        };
        assert_eq!(as_a_path(&folded("{remoteServiceBaseUrl}items/{id}", &known)).as_deref(), Some("/api/library/items/{id}"));
        assert_eq!(as_a_path(&folded("{remoteServiceBaseUrl}items/by?ids={ids}", &known)).as_deref(), Some("/api/library/items/by"));
        assert_eq!(as_a_path(&folded("{unknown}", &known)), None);
    }
}
