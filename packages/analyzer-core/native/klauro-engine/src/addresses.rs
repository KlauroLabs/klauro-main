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

fn without_a_leading_base(path: &str) -> &str {
    let Some(open) = path.strip_prefix('$').or(Some(path)).filter(|held| held.starts_with('{')) else { return path };
    match open.find('}').map(|close| &open[close + 1..]) {
        Some(rest) if rest.starts_with('/') => rest,
        _ => path,
    }
}

fn origin_of(written: &str) -> Option<String> {
    let start = written.find("://")? + 3;
    let host = &written[start..];
    let end = host.find(['/', '?', '#']).unwrap_or(host.len());
    let origin = &written[..start + end];
    (end > 0 && !origin.contains(['{', '$', ' '])).then(|| origin.to_string())
}

fn as_a_path(written: &str) -> Option<String> {
    let path = written.split(['?', '#']).next()?.trim();
    let path = match path.find("://") {
        Some(at) => &path[at + 3..][path[at + 3..].find('/')?..],
        None => path,
    };
    let path = without_a_leading_base(path);
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
            let written = folded(&template, &known);
            as_a_path(&written).map(|path| (path, origin_of(&written)))
        });
        exit.origin = addressed.as_ref().and_then(|(_, origin)| origin.clone());
        exit.addressed = addressed.map(|(path, _)| path);
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

static HTTP_VERBS: &[&str] = &["delete", "get", "patch", "post", "put"];

pub fn through_wrappers(
    exits: &mut Vec<ExitPoint>,
    calls: &[CallFact],
    nodes: &[IndexNode],
    files: &[String],
    constants: &Constants,
    edges: &[crate::model::IndexEdge],
    locals: &[LocalBinding],
) {
    let node_of: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut calls_at: HashMap<(u32, u32), Vec<&CallFact>> = HashMap::default();
    for call in calls {
        calls_at.entry((call.file, call.line)).or_default().push(call);
    }
    let mut local_in: HashMap<(&str, &str), &LocalBinding> = HashMap::default();
    for local in locals {
        local_in.entry((local.unit.as_str(), local.name.as_str())).or_insert(local);
    }
    let mut asking: HashMap<&str, (usize, String, String)> = HashMap::default();
    for exit in exits.iter().filter(|exit| exit.kind == "api" && exit.addressed.is_none()) {
        let Some(unit) = node_of.get(exit.source.as_str()).filter(|node| node.kind.is_unit()) else { continue };
        let Some(called) = calls_at.get(&(exit.file, exit.line)) else { continue };
        let parameter_of = |named: &str| -> Option<usize> {
            let parameters = &unit.signature.as_ref()?.parameters;
            let named = named.trim();
            let standing_for = local_in
                .get(&(unit.id.as_str(), named))
                .and_then(|local| local.from_call.as_deref().or(local.written.as_deref()))
                .map(|from| from.split(['.', '(', '{', '$', ' ']).find(|part| !part.is_empty()).unwrap_or_default());
            parameters.iter().position(|held| held.name == named || Some(held.name.as_str()) == standing_for)
        };
        let asked: Vec<&&CallFact> = called
            .iter()
            .filter(|call| crate::names::leaf(&call.callee).split('<').next() == exit.operation.split('<').next())
            .collect();
        let position = asked
            .iter()
            .flat_map(|call| call.literals.iter())
            .find_map(|literal| parameter_standing_in(literal, unit).map(|(at, offset)| (at, &literal[..offset])).or_else(|| parameter_of(literal).map(|at| (at, ""))))
            .or_else(|| {
                asked
                    .iter()
                    .flat_map(|call| call.passes.iter())
                    .filter_map(|passed| passed.split_once('='))
                    .filter(|(at, _)| *at == "0")
                    .find_map(|(_, root)| parameter_of(root).map(|at| (at, "")))
            });
        if let Some((position, before)) = position {
            let standing = Standing {
                file: exit.file,
                unit: exit.source.as_str(),
                owner: owner_of(exit.source.as_str(), &node_of),
                node: Some(unit),
            };
            let base = path_of_a_base(&constants.expand(&standing, before.trim_end_matches('$'))).unwrap_or_default();
            asking.entry(unit.id.as_str()).or_insert((position, base, exit.operation.clone()));
        }
    }
    if asking.is_empty() {
        return;
    }
    let mut dispatched_to: HashMap<&str, Vec<&str>> = HashMap::default();
    for edge in edges.iter().filter(|edge| edge.kind == crate::model::EdgeKind::Calls) {
        dispatched_to.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
    }
    let reaching = |caller: &str, named: &str| -> Option<&str> {
        let direct = dispatched_to.get(caller).into_iter().flatten().copied().filter(|target| node_of.get(target).is_some_and(|node| node.name == named));
        for target in direct {
            if asking.contains_key(target) {
                return Some(target);
            }
            if let Some(below) = dispatched_to.get(target).into_iter().flatten().copied().find(|below| asking.contains_key(below)) {
                return Some(below);
            }
        }
        None
    };
    let mut made = Vec::new();
    let mut relayed: rustc_hash::FxHashSet<&str> = rustc_hash::FxHashSet::default();
    for (position, call) in calls.iter().enumerate() {
        let Some(caller) = call.caller.as_deref().filter(|caller| node_of.get(caller).is_some_and(|node| node.kind.is_unit())) else {
            continue;
        };
        let named = crate::names::leaf(&call.callee).split('<').next().unwrap_or_default();
        let Some(wrapper) = reaching(caller, named) else { continue };
        let (at, base, operation) = &asking[wrapper];
        let standing = Standing { file: call.file, unit: caller, owner: owner_of(caller, &node_of), node: node_of.get(caller).copied() };
        let held = |literal: &str| {
            (!literal.contains('"')).then(|| as_a_path(&plainly_placed(&constants.expand(&standing, literal)))).flatten()
        };
        let embedded = |literal: &str| -> Option<String> {
            let opened = literal.find('(')?;
            let callee = literal[..opened].rsplit(['{', ' ', '.']).next()?.trim();
            calls_at
                .iter()
                .filter(|((file, line), _)| *file == call.file && *line <= call.line)
                .flat_map(|(_, held)| held.iter())
                .filter(|built| built.caller.as_deref() == Some(caller) && crate::names::leaf(&built.callee) == callee)
                .max_by_key(|built| built.line)?
                .literals
                .iter()
                .find_map(|literal| held(literal))
        };
        let template = match call.literals.len() == call.argument_count as usize {
            true => call.literals.get(*at),
            false => call.literals.first().filter(|first| *at == 0 && held(first).is_some()),
        };
        let through_a_local = |written: &str| -> Option<String> {
            let local = local_in.get(&(caller, written.trim()))?;
            calls_at
                .get(&(local.file, local.line))
                .into_iter()
                .flatten()
                .flat_map(|built| built.literals.iter())
                .find_map(|literal| held(literal))
                .or_else(|| local.written.as_deref().and_then(|text| held(text).or_else(|| embedded(text))))
        };
        let Some(path) = template
            .and_then(|written| held(written).or_else(|| through_a_local(written)).or_else(|| embedded(written)))
            .map(|path| joined_under(base, &path))
        else {
            continue;
        };
        let method = call
            .literals
            .iter()
            .find_map(|literal| literal.strip_prefix("method="))
            .map(str::to_string)
            .or_else(|| HTTP_VERBS.iter().find(|verb| operation.to_ascii_lowercase().starts_with(*verb)).map(|verb| verb.to_ascii_uppercase()))
            .unwrap_or_else(|| "GET".to_string());
        relayed.insert(wrapper);
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
            method: None,
            origin: None,
            action: None,
            does: None,
        });
    }
    exits.retain(|exit| !(exit.kind == "api" && exit.addressed.is_none() && relayed.contains(exit.source.as_str())));
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
