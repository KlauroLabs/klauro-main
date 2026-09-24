use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;

use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::*;
use crate::roles::Roles;

#[derive(Debug, Serialize)]
pub struct Transition {
    pub from: String,
    pub to: String,
    pub calls: u32,
}

#[derive(Debug, Serialize)]
pub struct Departure {
    pub from: String,
    pub to: String,
    pub reads_as: &'static str,
    pub calls: u32,
    pub caller: String,
    pub callee: String,
}

#[derive(Debug, Serialize)]
pub struct Travelled {
    pub layers: Vec<String>,
    pub arrivals: u32,
}

#[derive(Debug, Serialize)]
pub struct Layering {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub paths: Vec<Travelled>,
    pub transitions: Vec<Transition>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub departures: Vec<Departure>,
}

const HOPS_THROUGH_HELPERS: u32 = 4;
static NOT_AN_ARRIVAL: &[&str] = &["export", "test"];
const WALKED_AT_MOST: usize = 256;
const TRANSITIONS_KEPT: usize = 40;
const PATHS_KEPT: usize = 6;
const WALKED_PER_ARRIVAL: usize = 512;
const DEPTH_PER_ARRIVAL: u32 = 8;

static LAYERED_ROLES: &[(&str, u32)] = &[
    ("command", 0),
    ("controller", 0),
    ("handler", 0),
    ("listener", 0),
    ("scheduled", 0),
    ("middleware", 0),
    ("component", 0),
    ("service", 1),
    ("provider", 1),
    ("repository", 2),
    ("model", 2),
];

static BY_CLASS_FIRST: &[&str] =
    &["controller", "repository", "service", "model", "middleware", "listener", "provider", "component"];

fn rank_of(label: &str) -> u32 {
    if label.contains(':') {
        return 3;
    }
    if label.ends_with(" entry") {
        return 0;
    }
    LAYERED_ROLES.iter().find(|(role, _)| *role == label).map(|(_, rank)| *rank).unwrap_or(1)
}

pub fn derive<'a>(
    nodes: &'a [IndexNode],
    edges: &[IndexEdge],
    roles: &Roles,
    entry_points: &[EntryPoint],
    exit_points: &[ExitPoint],
    paths: &[&str],
) -> Vec<Layering> {
    let position: HashMap<&str, usize> =
        nodes.iter().enumerate().map(|(at, node)| (node.id.as_str(), at)).collect();
    let tested = |node: &IndexNode| paths.get(node.file as usize).is_some_and(|path| crate::paths::is_test(path));

    let mut role_of: HashMap<&str, &'static str> = HashMap::new();
    for role in &roles.roles {
        if role.role == "test" {
            continue;
        }
        let held = role_of.entry(role.node.as_str()).or_insert(role.role);
        let preferred = |candidate: &str| BY_CLASS_FIRST.iter().position(|role| *role == candidate).unwrap_or(99);
        if preferred(role.role) < preferred(held) {
            *held = role.role;
        }
    }
    let label_of = |at: usize| -> Option<&'static str> {
        let node = &nodes[at];
        if tested(node) {
            return None;
        }
        let holder = node.parent.as_deref().and_then(|parent| role_of.get(parent).copied());
        let own = role_of.get(node.id.as_str()).copied();
        match (holder, own) {
            (Some(held), _) if BY_CLASS_FIRST.contains(&held) => Some(held),
            (_, Some(own)) => Some(own),
            (Some(held), None) => Some(held),
            (None, None) => None,
        }
    };
    let labels: Vec<Option<&'static str>> = (0..nodes.len()).map(label_of).collect();

    let overriding = overridden_by(nodes, edges, &position);
    let mut callees: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    for edge in edges.iter().filter(|edge| matches!(edge.kind, EdgeKind::Calls | EdgeKind::Instantiates)) {
        let (Some(from), Some(to)) = (position.get(edge.source.as_str()), position.get(edge.target.as_str())) else {
            continue;
        };
        if from == to {
            continue;
        }
        callees[*from].push(*to);
        for implementation in overriding.get(to).into_iter().flatten() {
            if implementation != from {
                callees[*from].push(*implementation);
            }
        }
    }
    let mut sinks: Vec<Vec<String>> = vec![Vec::new(); nodes.len()];
    for exit in exit_points {
        let Some(at) = position.get(exit.source.as_str()) else { continue };
        let label = match exit.service.as_deref() {
            Some(named) => format!("{}: {named}", exit.kind),
            None => format!("{}:", exit.kind),
        };
        if !sinks[*at].contains(&label) {
            sinks[*at].push(label);
        }
    }

    let mut counted: BTreeMap<(Option<&str>, String, String), (u32, usize, usize)> = BTreeMap::new();
    let mut note = |project: Option<&'a str>, from: String, to: String, caller: usize, callee: usize| {
        counted.entry((project, from, to)).or_insert((0, caller, callee)).0 += 1;
    };
    let project_of = |at: usize| -> Option<&'a str> { nodes[at].project.as_deref() };

    for (start, label) in labels.iter().enumerate() {
        let Some(label) = label else { continue };
        let mut seen: HashSet<usize> = HashSet::from([start]);
        let mut frontier: Vec<(usize, u32)> = vec![(start, 0)];
        let mut reached_labels: HashSet<(String, usize)> = HashSet::new();
        let mut walked = 0usize;
        while let Some((current, hops)) = frontier.pop() {
            walked += 1;
            if walked > WALKED_AT_MOST {
                break;
            }
            for sink in &sinks[current] {
                reached_labels.insert((sink.clone(), current));
            }
            for callee in &callees[current] {
                if !seen.insert(*callee) {
                    continue;
                }
                match labels[*callee] {
                    Some(reached) => {
                        reached_labels.insert((reached.to_string(), *callee));
                    }
                    None if hops < HOPS_THROUGH_HELPERS => frontier.push((*callee, hops + 1)),
                    None => {}
                }
            }
        }
        let mut once: HashSet<String> = HashSet::new();
        for (reached, callee) in reached_labels {
            if once.insert(reached.clone()) {
                note(project_of(start), label.to_string(), reached, start, callee);
            }
        }
    }
    for entry in entry_points {
        let Some(at) = position.get(entry.handler.as_str()) else { continue };
        let Some(label) = labels[*at] else { continue };
        if NOT_AN_ARRIVAL.contains(&entry.kind) {
            continue;
        }
        note(project_of(*at), format!("{} entry", entry.kind), label.to_string(), *at, *at);
    }

    let mut by_project: BTreeMap<Option<&str>, Vec<((String, String), (u32, usize, usize))>> = BTreeMap::new();
    for ((project, from, to), held) in counted {
        by_project.entry(project).or_default().push(((from, to), held));
    }
    let mut travelled: HashMap<Option<&str>, BTreeMap<Vec<String>, u32>> = HashMap::new();
    for entry in entry_points.iter().filter(|entry| !NOT_AN_ARRIVAL.contains(&entry.kind)) {
        let Some(start) = position.get(entry.handler.as_str()).copied() else { continue };
        if tested(&nodes[start]) {
            continue;
        }
        let mut layers: Vec<(u32, usize, String)> = Vec::new();
        let mut seen: HashSet<usize> = HashSet::from([start]);
        let mut frontier: std::collections::VecDeque<(usize, u32)> = std::collections::VecDeque::from([(start, 0)]);
        let mut order = 0usize;
        while let Some((current, depth)) = frontier.pop_front() {
            if seen.len() > WALKED_PER_ARRIVAL {
                break;
            }
            let found = labels[current].map(str::to_string).into_iter().chain(sinks[current].iter().cloned());
            for label in found {
                if !layers.iter().any(|(_, _, held)| *held == label) {
                    layers.push((rank_of(&label), order, label));
                    order += 1;
                }
            }
            if depth >= DEPTH_PER_ARRIVAL {
                continue;
            }
            for callee in &callees[current] {
                if seen.insert(*callee) {
                    frontier.push_back((*callee, depth + 1));
                }
            }
        }
        layers.sort();
        let mut path = vec![format!("{} entry", entry.kind)];
        path.extend(layers.into_iter().map(|(_, _, label)| label));
        *travelled.entry(project_of(start)).or_default().entry(path).or_insert(0) += 1;
    }
    by_project
        .into_iter()
        .map(|(project, mut held)| {
            held.sort_by(|left, right| right.1.0.cmp(&left.1.0).then(left.0.cmp(&right.0)));
            let serves_through: HashSet<&str> = held
                .iter()
                .filter(|((from, to), _)| rank_of(from) == 1 && rank_of(to) >= 2)
                .map(|((from, _), _)| from.as_str())
                .collect();
            let departures: Vec<Departure> = held
                .iter()
                .filter(|((from, _), _)| !from.ends_with(" entry"))
                .filter_map(|((from, to), (calls, caller, callee))| {
                    let (above, below) = (rank_of(from), rank_of(to));
                    let reads_as = if below < above {
                        "calls up into a layer above it"
                    } else if above == 0 && below >= 2 && !serves_through.is_empty() {
                        "reaches past the service layer"
                    } else {
                        return None;
                    };
                    Some(Departure {
                        from: from.clone(),
                        to: to.clone(),
                        reads_as,
                        calls: *calls,
                        caller: nodes[*caller].id.clone(),
                        callee: nodes[*callee].id.clone(),
                    })
                })
                .collect();
            let mut paths: Vec<Travelled> = travelled
                .remove(&project)
                .unwrap_or_default()
                .into_iter()
                .map(|(layers, arrivals)| Travelled { layers, arrivals })
                .collect();
            paths.sort_by(|left, right| right.arrivals.cmp(&left.arrivals).then(left.layers.cmp(&right.layers)));
            paths.truncate(PATHS_KEPT);
            Layering {
                project: project.map(str::to_string),
                paths,
                transitions: held
                    .into_iter()
                    .take(TRANSITIONS_KEPT)
                    .map(|((from, to), (calls, _, _))| Transition { from, to, calls })
                    .collect(),
                departures,
            }
        })
        .collect()
}

fn overridden_by(
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    position: &HashMap<&str, usize>,
) -> HashMap<usize, Vec<usize>> {
    let mut implementors: HashMap<usize, Vec<usize>> = HashMap::new();
    for edge in edges.iter().filter(|edge| matches!(edge.kind, EdgeKind::Implements | EdgeKind::Extends)) {
        if let (Some(child), Some(parent)) = (position.get(edge.source.as_str()), position.get(edge.target.as_str())) {
            implementors.entry(*parent).or_default().push(*child);
        }
    }
    let mut member: HashMap<(usize, &str), usize> = HashMap::new();
    for (at, node) in nodes.iter().enumerate() {
        if !node.kind.is_unit() {
            continue;
        }
        if let Some(parent) = node.parent.as_deref().and_then(|parent| position.get(parent)) {
            member.entry((*parent, node.name.as_str())).or_insert(at);
        }
    }
    let mut overriding: HashMap<usize, Vec<usize>> = HashMap::new();
    for (at, node) in nodes.iter().enumerate() {
        let Some(owner) = node.parent.as_deref().and_then(|parent| position.get(parent)) else { continue };
        let mut below: Vec<usize> = implementors.get(owner).cloned().unwrap_or_default();
        let mut visited: HashSet<usize> = HashSet::new();
        while let Some(implementor) = below.pop() {
            if !visited.insert(implementor) {
                continue;
            }
            if let Some(implementation) = member.get(&(implementor, node.name.as_str())) {
                overriding.entry(at).or_default().push(*implementation);
            }
            below.extend(implementors.get(&implementor).into_iter().flatten().copied());
        }
    }
    overriding
}
