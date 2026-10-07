use rustc_hash::FxHashMap as HashMap;

use serde::Serialize;

use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::*;

#[derive(Debug, Serialize)]
pub struct Role {
    pub node: String,
    pub role: &'static str,
    pub from: String,
    #[serde(skip)]
    pub generic: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Roles {
    pub roles: Vec<Role>,
    pub by_role: Vec<(String, u32)>,
}

static ROLE_ROWS: &str = include_str!("../data/component_roles.tsv");

struct Rule {
    languages: Vec<&'static str>,
    how: &'static str,
    name: &'static str,
    role: &'static str,
    generic: bool,
}

fn rules() -> &'static [Rule] {
    static HELD: std::sync::OnceLock<Vec<Rule>> = std::sync::OnceLock::new();
    HELD.get_or_init(|| {
        ROLE_ROWS
            .lines()
            .filter_map(|line| {
                let [_, languages, how, name, role, generic]: [&'static str; 6] = line.split('\t').collect::<Vec<_>>().try_into().ok()?;
                Some(Rule { languages: languages.split(',').collect(), how, name, role, generic: generic == "yes" })
            })
            .collect()
    })
}

fn language_of(path: &str) -> &str {
    crate::paths::basename(path).rsplit_once('.').map(|(_, extension)| extension).unwrap_or_default()
}

fn written_plainly(name: &str) -> &str {
    let name = name.trim();
    name.split(['<', '(', '[']).next().unwrap_or(name).trim()
}

fn names_the_rule(written: &str, rule: &Rule) -> bool {
    let written = written_plainly(written);
    match rule.name.contains("::") || rule.name.contains('.') {
        true => written == rule.name || written.ends_with(&format!("::{}", rule.name)) || written.ends_with(&format!(".{}", rule.name)),
        false => crate::names::leaf(written) == rule.name && (written == rule.name || !written.contains("::")),
    }
}

fn matching(how: &str, written: &str, language: &str) -> Option<&'static Rule> {
    rules().iter().find(|rule| rule.how == how && rule.languages.contains(&language) && names_the_rule(written, rule))
}

fn is_a_hook(name: &str) -> bool {
    name.strip_prefix("use").and_then(|rest| rest.chars().next()).is_some_and(|held| held.is_ascii_uppercase())
}

static FILE_OPERATIONS: &str = include_str!("../data/file_operations.tsv");

fn file_direction(operation: &str) -> Option<&'static str> {
    FILE_OPERATIONS.lines().find_map(|line| {
        let mut fields = line.split('\t');
        let (_, direction, operations) = (fields.next()?, fields.next()?, fields.next()?);
        operations.split(',').any(|named| named == operation || crate::names::leaf(operation) == named).then_some(direction)
    })
}

#[derive(Default)]
struct Reach {
    keeping: rustc_hash::FxHashSet<String>,
    calling_out: u32,
    databased: bool,
    read: bool,
    written: bool,
}

fn spoken_route(path: &str) -> String {
    path.split('?').next().unwrap_or(path).trim_end_matches('/').split('/').map(|segment| match segment.starts_with(':') || segment.starts_with('{') || segment.starts_with('$') {
        true => "*",
        false => segment,
    }).collect::<Vec<_>>().join("/")
}

fn leaves_the_system(exit: &ExitPoint, own: &rustc_hash::FxHashSet<String>, held_by_a_type: bool) -> bool {
    if !matches!(exit.kind, "api" | "network") {
        return false;
    }
    if exit.service.is_some() {
        return true;
    }
    let address = exit.addressed.as_deref().unwrap_or(exit.target.as_str());
    let absolute = address.starts_with("http://") || address.starts_with("https://");
    let ours = own.contains(address) || own.contains(&spoken_route(address));
    !ours && (absolute || held_by_a_type)
}

fn reached_from_its_code(exits: &[ExitPoint], unit_of: &HashMap<&str, String>, members: &HashMap<String, usize>, own: &rustc_hash::FxHashSet<String>, types: &rustc_hash::FxHashSet<&str>) -> HashMap<String, &'static str> {
    let mut found: HashMap<String, Reach> = HashMap::default();
    for exit in exits {
        let Some(unit) = unit_of.get(exit.source.as_str()) else { continue };
        let held = found.entry(unit.clone()).or_default();
        match exit.kind {
            "database" | "cache" if exit.action != Some("model-call") => {
                held.databased = true;
                held.keeping.insert(exit.source.clone());
            }
            "file" => match file_direction(&exit.operation) {
                Some("read") => held.read = true,
                Some("write") => {
                    held.written = true;
                    held.keeping.insert(exit.source.clone());
                }
                _ => {}
            },
            _ if leaves_the_system(exit, own, types.contains(unit.as_str())) => held.calling_out += 1,
            _ => {}
        }
    }
    found
        .into_iter()
        .filter_map(|(unit, reach)| {
            let total = members.get(&unit).copied().unwrap_or(1).max(1);
            let storage_is_its_work = !reach.keeping.is_empty() && reach.keeping.len() * 2 >= total;
            let keeps = storage_is_its_work && (reach.databased || (reach.read && reach.written));
            match (keeps, reach.calling_out) {
                (true, called) if called as usize <= reach.keeping.len() => Some((unit, "repository")),
                (_, called) if called > 0 => Some((unit, "integration")),
                _ => None,
            }
        })
        .collect()
}

static ENTERING: &[&str] = &["command", "controller", "handler", "listener", "request-handler", "scheduled", "worker"];
static KEEPING: &[&str] = &["data-context", "integration", "repository"];

fn spoken(held: &str) -> String {
    held.to_ascii_lowercase().replace(['_', '-'], "")
}

fn inheritance<'a>(nodes: &'a [IndexNode], edges: &'a [IndexEdge], type_references: &'a [TypeReferenceFact]) -> Vec<(&'a str, Vec<&'a str>)> {
    let mut named_types: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
    for node in nodes.iter().filter(|node| node.kind.is_type()) {
        named_types.entry(node.name.as_str()).or_default().push(node);
    }
    let by_id: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let context_of = |node: &IndexNode| -> Vec<String> {
        let mut within: Vec<String> = node.id.split(':').next().unwrap_or_default().split('/').map(spoken).collect();
        let mut above = node.parent.as_deref().and_then(|parent| by_id.get(parent).copied());
        while let Some(held) = above.filter(|held| held.kind.is_type()) {
            within.push(spoken(&held.name));
            above = held.parent.as_deref().and_then(|parent| by_id.get(parent).copied());
        }
        within
    };
    let resolve = |written: &str, from: &str| -> Option<&'a str> {
        let written = written_plainly(written);
        let candidates: Vec<&IndexNode> = named_types.get(crate::names::leaf(written))?.iter().copied().filter(|candidate| candidate.id != from).collect();
        let qualifier = written.rsplit_once("::").or_else(|| written.rsplit_once('.')).map(|(qualifier, _)| spoken(crate::names::leaf(qualifier)));
        let fitting: Vec<&IndexNode> = candidates.into_iter().filter(|candidate| qualifier.as_ref().is_none_or(|qualifier| context_of(candidate).contains(qualifier))).collect();
        if fitting.len() <= 1 {
            return fitting.first().map(|held| held.id.as_str());
        }
        let near: Vec<&str> = from.split(':').next().unwrap_or_default().split('/').collect();
        let shared = |candidate: &IndexNode| candidate.id.split(':').next().unwrap_or_default().split('/').zip(near.iter()).take_while(|(left, right)| left == *right).count();
        let best = fitting.iter().map(|candidate| shared(candidate)).max().unwrap_or(0);
        let closest: Vec<&IndexNode> = fitting.into_iter().filter(|candidate| shared(candidate) == best).collect();
        match closest.as_slice() {
            [only] => Some(only.id.as_str()),
            _ => None,
        }
    };
    let mut above: HashMap<&str, Vec<&str>> = HashMap::default();
    for edge in edges.iter().filter(|edge| matches!(edge.kind, EdgeKind::Extends | EdgeKind::Implements)) {
        above.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
    }
    for fact in type_references.iter().filter(|fact| matches!(fact.kind, EdgeKind::Extends | EdgeKind::Implements)) {
        if let Some(target) = resolve(&fact.name, fact.source.as_str()) {
            above.entry(fact.source.as_str()).or_default().push(target);
        }
    }
    let mut found: Vec<(&str, Vec<&str>)> = above
        .into_iter()
        .map(|(source, mut targets)| {
            targets.sort();
            targets.dedup();
            (source, targets)
        })
        .collect();
    found.sort();
    found
}

pub fn derive(
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    type_references: &[TypeReferenceFact],
    entry_points: &[EntryPoint],
    calls: &[CallFact],
    files: &[String],
) -> Roles {
    let named: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let language = |node: &IndexNode| files.get(node.file as usize).map(|path| language_of(path)).unwrap_or_default();
    let mut roles: Vec<Role> = Vec::new();
    let mut seen: rustc_hash::FxHashSet<(String, &'static str)> = rustc_hash::FxHashSet::default();
    let mut framed: HashMap<String, (&'static str, bool)> = HashMap::default();

    for node in nodes.iter().filter(|node| node.kind.is_type()) {
        let spoken = language(node);
        let by_decorator = node.decorators.iter().find_map(|decorator| matching("decorator", &decorator.name, spoken).map(|rule| (rule, format!("annotation:{}", decorator.name))));
        if let Some((rule, from)) = by_decorator {
            framed.entry(node.id.clone()).or_insert((rule.role, rule.generic));
            seen.insert((node.id.clone(), rule.role));
            roles.push(Role { node: node.id.clone(), role: rule.role, from, generic: rule.generic, project: node.project.clone() });
        }
    }
    for fact in type_references.iter().filter(|fact| matches!(fact.kind, EdgeKind::Extends | EdgeKind::Implements)) {
        let Some(node) = named.get(fact.source.as_str()) else { continue };
        let Some(rule) = matching("base", &fact.name, language(node)) else { continue };
        if framed.get(node.id.as_str()).is_some_and(|(_, generic)| !generic) {
            continue;
        }
        framed.insert(node.id.clone(), (rule.role, rule.generic));
        if seen.insert((node.id.clone(), rule.role)) {
            roles.push(Role { node: node.id.clone(), role: rule.role, from: format!("inherits:{}", fact.name), generic: rule.generic, project: node.project.clone() });
        }
    }
    for node in nodes.iter().filter(|node| matches!(node.kind, NodeKind::Method | NodeKind::Function)) {
        let Some(owner) = node.parent.as_deref().and_then(|parent| named.get(parent)).filter(|owner| owner.kind.is_type()) else { continue };
        let Some((rule, decorator)) = node.decorators.iter().find_map(|decorator| matching("method", &decorator.name, language(node)).map(|rule| (rule, decorator))) else { continue };
        if framed.get(owner.id.as_str()).is_some_and(|(_, generic)| !generic) {
            continue;
        }
        framed.insert(owner.id.clone(), (rule.role, rule.generic));
        if seen.insert((owner.id.clone(), rule.role)) {
            roles.push(Role { node: owner.id.clone(), role: rule.role, from: format!("annotation:{}", decorator.name), generic: rule.generic, project: owner.project.clone() });
        }
    }

    let inherits = inheritance(nodes, edges, type_references);
    loop {
        let carried: Vec<(&str, &'static str, bool, &str)> = inherits
            .iter()
            .filter(|(source, _)| !framed.contains_key(*source))
            .filter_map(|(source, targets)| {
                targets.iter().find_map(|target| framed.get(*target).map(|(role, generic)| (*source, *role, *generic, *target)))
            })
            .collect();
        if carried.is_empty() {
            break;
        }
        for (source, role, generic, target) in carried {
            framed.insert(source.to_string(), (role, generic));
            let Some(node) = named.get(source) else { continue };
            if seen.insert((source.to_string(), role)) {
                let base = named.get(target).map(|held| held.name.as_str()).unwrap_or(target);
                roles.push(Role { node: source.to_string(), role, from: format!("inherits:{base}"), generic, project: node.project.clone() });
            }
        }
    }

    for entry in entry_points {
        let Some(node) = named.get(entry.handler.as_str()) else { continue };
        let role = match entry.kind {
            "http" | "rpc" | "graphql" | "ipc" => "handler",
            "ui" => "component",
            "event" | "message" => "listener",
            "schedule" => "scheduled",
            "cli" => "command",
            "test" => "test",
            _ => continue,
        };
        if seen.insert((node.id.clone(), role)) {
            roles.push(Role { node: node.id.clone(), role, from: format!("{}:{}", entry.kind, entry.registrar), generic: false, project: node.project.clone() });
        }
    }

    let drawn: rustc_hash::FxHashSet<&str> = calls
        .iter()
        .filter(|call| call.renders)
        .flat_map(|call| [Some(call.callee.as_str()), call.caller.as_deref().and_then(|caller| caller.rsplit(':').next())])
        .flatten()
        .collect();
    for node in nodes.iter().filter(|node| matches!(node.kind, NodeKind::Function | NodeKind::Method)) {
        let Some(path) = files.get(node.file as usize) else { continue };
        let markup = path.ends_with(".tsx") || path.ends_with(".jsx");
        let leaf = node.name.as_str();
        let role = match () {
            _ if markup && leaf.starts_with(|held: char| held.is_ascii_uppercase()) && drawn.contains(leaf) => Some(("component", format!("renders:{leaf}"))),
            _ if is_a_hook(leaf) && (markup || path.ends_with(".ts")) && !node.id.contains(":callback:") => Some(("service", format!("hook:{leaf}"))),
            _ => None,
        };
        if let Some((role, from)) = role
            && seen.insert((node.id.clone(), role))
        {
            roles.push(Role { node: node.id.clone(), role, from, generic: false, project: node.project.clone() });
        }
    }

    roles.sort_by(|left, right| left.node.cmp(&right.node).then(left.role.cmp(right.role)));
    let mut counts: HashMap<&str, u32> = HashMap::default();
    for role in &roles {
        *counts.entry(role.role).or_insert(0) += 1;
    }
    let mut by_role: Vec<(String, u32)> = counts.into_iter().map(|(role, count)| (role.to_string(), count)).collect();
    by_role.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    Roles { roles, by_role }
}

fn tallied(roles: &[Role]) -> Vec<(String, u32)> {
    let mut counts: HashMap<&str, u32> = HashMap::default();
    for role in roles {
        *counts.entry(role.role).or_insert(0) += 1;
    }
    let mut by_role: Vec<(String, u32)> = counts.into_iter().map(|(role, count)| (role.to_string(), count)).collect();
    by_role.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    by_role
}

pub fn refine(held: &mut Roles, nodes: &[IndexNode], edges: &[IndexEdge], exits: &[ExitPoint], entry_points: &[EntryPoint]) {
    let own: rustc_hash::FxHashSet<String> = entry_points
        .iter()
        .filter(|entry| entry.kind != "test")
        .flat_map(|entry| [Some(entry.name.clone()), entry.path.as_deref().map(spoken_route)])
        .flatten()
        .collect();
    let named: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut roles = std::mem::take(&mut held.roles);
    let mut seen: rustc_hash::FxHashSet<(String, &'static str)> = roles.iter().map(|role| (role.node.clone(), role.role)).collect();
    let mut framed: HashMap<String, (&'static str, bool)> = HashMap::default();
    for role in roles.iter().filter(|role| !matches!(role.role, "handler" | "component" | "listener" | "scheduled" | "command" | "test") || role.from.starts_with("annotation:") || role.from.starts_with("inherits:")) {
        let entry = framed.entry(role.node.clone()).or_insert((role.role, role.generic));
        entry.1 &= role.generic;
    }
    let unit_of: HashMap<&str, String> = nodes
        .iter()
        .filter(|node| matches!(node.kind, NodeKind::Method | NodeKind::Function | NodeKind::Constructor))
        .filter_map(|node| {
            let parent = named.get(node.parent.as_deref()?)?;
            match parent.kind {
                kind if kind.is_type() => Some((node.id.as_str(), parent.id.clone())),
                NodeKind::Module => Some((node.id.as_str(), parent.id.clone())),
                _ => None,
            }
        })
        .collect();
    let mut members_of: HashMap<String, Vec<&IndexNode>> = HashMap::default();
    for node in nodes.iter().filter(|node| matches!(node.kind, NodeKind::Function) && !node.id.contains(":callback:") && !node.name.contains('#')) {
        if let Some(unit) = unit_of.get(node.id.as_str()).filter(|unit| named.get(unit.as_str()).is_some_and(|held| held.kind == NodeKind::Module)) {
            members_of.entry(unit.clone()).or_default().push(node);
        }
    }
    let record = |roles: &mut Vec<Role>, seen: &mut rustc_hash::FxHashSet<(String, &'static str)>, unit: &str, role: &'static str, from: String| {
        let Some(node) = named.get(unit) else { return };
        let held: Vec<&IndexNode> = match node.kind {
            NodeKind::Module => members_of.get(unit).cloned().unwrap_or_default(),
            _ => vec![*node],
        };
        for member in held {
            if seen.insert((member.id.clone(), role)) {
                roles.push(Role { node: member.id.clone(), role, from: from.clone(), generic: false, project: member.project.clone() });
            }
        }
    };
    let mut members: HashMap<String, usize> = HashMap::default();
    for unit in unit_of.values() {
        *members.entry(unit.clone()).or_default() += 1;
    }
    let types: rustc_hash::FxHashSet<&str> = nodes.iter().filter(|node| node.kind.is_type()).map(|node| node.id.as_str()).collect();
    let reaching = reached_from_its_code(exits, &unit_of, &members, &own, &types);
    let mut reaching = reaching;
    let inherits = inheritance(nodes, edges, &[]);
    loop {
        let carried: Vec<(String, &'static str)> = inherits
            .iter()
            .filter(|(source, _)| !reaching.contains_key(*source) && framed.get(*source).is_none_or(|(_, generic)| *generic))
            .filter_map(|(source, targets)| targets.iter().find_map(|target| reaching.get(*target).copied()).map(|role| (source.to_string(), role)))
            .collect();
        if carried.is_empty() {
            break;
        }
        reaching.extend(carried);
    }
    let entering: rustc_hash::FxHashSet<String> = roles
        .iter()
        .filter(|role| matches!(role.role, "handler" | "component" | "listener" | "scheduled" | "command" | "test"))
        .map(|role| unit_of.get(role.node.as_str()).cloned().unwrap_or_else(|| role.node.clone()))
        .collect();
    let considered = |unit: &str| {
        named.get(unit).is_some_and(|node| {
            !node.id.contains(":callback:") && !node.name.contains('#') && !crate::paths::is_test(node.id.split(':').next().unwrap_or_default())
        }) && !entering.contains(unit)
    };
    for (unit, role) in reaching.iter().filter(|(unit, _)| considered(unit)) {
        let refined = match framed.get(unit.as_str()) {
            None => true,
            Some((_, generic)) => *generic,
        };
        if refined {
            roles.retain(|held| !(held.node == *unit && framed.get(unit.as_str()).is_some_and(|(framed_as, _)| *framed_as == held.role)));
            framed.insert(unit.clone(), (role, false));
            record(&mut roles, &mut seen, unit, role, format!("reaches:{role}"));
        }
    }

    let role_of_unit: HashMap<String, Vec<&'static str>> = {
        let mut held: HashMap<String, Vec<&'static str>> = HashMap::default();
        for role in &roles {
            let unit = unit_of.get(role.node.as_str()).cloned().unwrap_or_else(|| role.node.clone());
            held.entry(unit).or_default().push(role.role);
        }
        held
    };
    let playing = |unit: &str, wanted: &[&str]| role_of_unit.get(unit).is_some_and(|held| held.iter().any(|role| wanted.contains(role)));
    let mut called_by_entries: rustc_hash::FxHashSet<String> = rustc_hash::FxHashSet::default();
    let mut calling_keepers: rustc_hash::FxHashSet<String> = rustc_hash::FxHashSet::default();
    for edge in edges.iter().filter(|edge| matches!(edge.kind, EdgeKind::Calls | EdgeKind::Instantiates)) {
        let from = unit_of.get(edge.source.as_str()).cloned().unwrap_or_else(|| edge.source.clone());
        let to = unit_of.get(edge.target.as_str()).cloned().unwrap_or_else(|| edge.target.clone());
        if from == to {
            continue;
        }
        if playing(&from, ENTERING) || role_of_unit.get(edge.source.as_str()).is_some_and(|held| held.iter().any(|role| ENTERING.contains(role))) {
            called_by_entries.insert(to.clone());
        }
        if playing(&to, KEEPING) {
            calling_keepers.insert(from);
        }
    }
    for unit in called_by_entries.intersection(&calling_keepers) {
        if role_of_unit.contains_key(unit.as_str()) || !named.get(unit.as_str()).is_some_and(|node| node.kind.is_type()) {
            continue;
        }
        record(&mut roles, &mut seen, unit, "service", "position:between entries and the data they keep".to_string());
    }

    roles.sort_by(|left, right| left.node.cmp(&right.node).then(left.role.cmp(right.role)));
    held.by_role = tallied(&roles);
    held.roles = roles;
}
