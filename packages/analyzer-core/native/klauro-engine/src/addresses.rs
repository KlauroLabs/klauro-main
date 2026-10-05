use rustc_hash::FxHashMap as HashMap;

use crate::constants::{Constants, Standing};
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
            let named = rest[open + 1..close].trim();
            match known(named) {
                Some(value) => {
                    out.push_str(&rest[..open].trim_end_matches('$'));
                    out.push_str(&value);
                    changed = true;
                }
                None => out.push_str(&rest[..=close]),
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

#[cfg(test)]
fn parameter_named_in(template: &str, unit: &IndexNode) -> Option<usize> {
    parameter_standing_in(template, unit).map(|(at, _)| at)
}

fn parameter_standing_in(template: &str, unit: &IndexNode) -> Option<(usize, usize)> {
    let parameters = &unit.signature.as_ref()?.parameters;
    let mut taken = 0;
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let close = rest[open..].find('}').map(|at| open + at)?;
        let named = rest[open + 1..close].trim();
        if let Some(at) = parameters.iter().position(|held| held.name == named) {
            return Some((at, taken + open));
        }
        taken += close + 1;
        rest = &rest[close + 1..];
    }
    None
}

fn carries_the_address(template: &str, unit: &IndexNode) -> bool {
    let Some((_, at)) = parameter_standing_in(template, unit) else { return false };
    let before = &template[..at];
    let after = template[at..].find('}').map(|close| &template[at + close + 1..]).unwrap_or_default();
    let whole_segment = before.ends_with('/') && (after.is_empty() || after.starts_with(['/', '?', '#']));
    !whole_segment || before.trim_matches('/').is_empty()
}

fn path_of_a_base(written: &str) -> Option<String> {
    let written = written.split(['?', '#']).next()?.trim();
    let path = match written.find("://") {
        Some(at) => {
            let rest = &written[at + 3..];
            rest.find('/').map(|slash| &rest[slash..]).unwrap_or("")
        }
        None => written,
    };
    if path.contains(['{', '$']) || path.contains(char::is_whitespace) {
        return None;
    }
    let bare = path.trim_end_matches('/');
    Some(match (bare.is_empty(), bare.starts_with('/')) {
        (true, _) => String::new(),
        (false, true) => bare.to_string(),
        (false, false) => format!("/{bare}"),
    })
}

fn joined_under(base: &str, path: &str) -> String {
    match base.is_empty() || path == base || path.starts_with(&format!("{base}/")) {
        true => path.to_string(),
        false => format!("{base}{path}"),
    }
}

static BASE_KEYS: &[&str] = &["base=", "base_url=", "baseurl=", "prefixurl="];

fn base_named(call: &CallFact) -> Option<&str> {
    call.literals.iter().find_map(|literal| {
        let lowered = literal.to_ascii_lowercase();
        BASE_KEYS
            .iter()
            .find(|key| lowered.starts_with(**key))
            .map(|key| literal[key.len()..].trim().trim_matches(['"', '\'']))
    })
}

fn path_asked_in(held: &str) -> &str {
    match held.split_once('=') {
        Some((key, value)) if matches!(key.trim(), "endpoint" | "path" | "url") => value.trim(),
        _ => held,
    }
}

pub fn rebase(exits: &mut [ExitPoint], calls: &[CallFact], locals: &[LocalBinding], nodes: &[IndexNode], constants: &Constants) {
    let node_of: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut calls_at: HashMap<(u32, u32), Vec<&CallFact>> = HashMap::default();
    for call in calls {
        calls_at.entry((call.file, call.line)).or_default().push(call);
    }
    let mut built_at: HashMap<(u32, &str, &str), u32> = HashMap::default();
    for local in locals.iter().filter(|local| local.from_call.is_some() || local.constructed.is_some()) {
        built_at.entry((local.file, local.unit.as_str(), local.name.as_str())).or_insert(local.line);
    }
    for exit in exits.iter_mut().filter(|exit| exit.kind == "api" && !exit.id.ends_with(":request")) {
        let unit = exit.source.as_str();
        let owner = owner_of(unit, &node_of);
        let standing = Standing { file: exit.file, unit, owner, node: node_of.get(unit).copied() };
        let Some(called) = calls_at.get(&(exit.file, exit.line)) else { continue };
        let asked: Vec<&&CallFact> = called
            .iter()
            .filter(|call| crate::names::leaf(&call.callee).split('<').next() == exit.operation.split('<').next())
            .collect();
        let spelled = asked.iter().flat_map(|call| call.literals.iter()).find_map(|literal| {
            let held = path_asked_in(literal);
            if !held.contains('{') {
                return None;
            }
            let expanded = plainly_placed(&constants.expand(&standing, held));
            let wrapped = standing.node.is_some_and(|node| carries_the_address(&expanded, node));
            (expanded != plainly_placed(held) && !wrapped).then(|| as_a_path(&expanded)).flatten()
        });
        if let Some(path) = spelled {
            exit.addressed = Some(path);
            continue;
        }
        let Some(current) = exit.addressed.clone() else { continue };
        let through_an_instance = asked.iter().find_map(|call| {
            let receiver = call.receiver.as_deref()?.trim_start_matches("this.");
            let named = crate::names::root(receiver);
            let line = [unit, owner.unwrap_or_default(), ""]
                .into_iter()
                .find_map(|held| built_at.get(&(exit.file, held, named)).copied())?;
            let base = calls_at.get(&(exit.file, line))?.iter().find_map(|made| base_named(made))?;
            path_of_a_base(&constants.expand(&standing, base))
        });
        if let Some(base) = through_an_instance {
            exit.addressed = Some(joined_under(&base, &current));
        }
    }
}

pub fn through_wrappers(
    exits: &mut Vec<ExitPoint>,
    calls: &[CallFact],
    nodes: &[IndexNode],
    files: &[String],
    constants: &Constants,
) {
    let node_of: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut declared: HashMap<&str, u32> = HashMap::default();
    for node in nodes.iter().filter(|node| node.kind.is_unit()) {
        *declared.entry(node.name.as_str()).or_insert(0) += 1;
    }
    let mut calls_at: HashMap<(u32, u32), Vec<&CallFact>> = HashMap::default();
    for call in calls {
        calls_at.entry((call.file, call.line)).or_default().push(call);
    }
    let mut asking: HashMap<&str, (usize, String)> = HashMap::default();
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
            .find_map(|literal| parameter_standing_in(literal, unit).map(|(at, offset)| (at, &literal[..offset])));
        if let Some((position, before)) = position {
            let standing = Standing {
                file: exit.file,
                unit: exit.source.as_str(),
                owner: owner_of(exit.source.as_str(), &node_of),
                node: Some(unit),
            };
            let base = path_of_a_base(&constants.expand(&standing, before.trim_end_matches('$'))).unwrap_or_default();
            asking.entry(unit.name.as_str()).or_insert((position, base));
        }
    }
    if asking.is_empty() {
        return;
    }
    let mut made = Vec::new();
    for (position, call) in calls.iter().enumerate() {
        let Some((at, base)) = asking.get(crate::names::leaf(&call.callee).split('<').next().unwrap_or_default()).map(|(at, base)| (*at, base.as_str())) else {
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
        let Some(path) = template.and_then(held).map(|path| joined_under(base, &path)) else { continue };
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
