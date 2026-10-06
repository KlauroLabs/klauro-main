use std::collections::BTreeMap;
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

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
    #[serde(skip)]
    pub reaching: Vec<Reaching>,
}

#[derive(Debug)]
pub struct Reaching {
    pub unit: String,
    pub layer: &'static str,
    pub reaches: Vec<String>,
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

pub fn rank_of(label: &str) -> u32 {
    if label.contains(':') {
        return 3;
    }
    if label.ends_with(" entry") {
        return 0;
    }
    LAYERED_ROLES.iter().find(|(role, _)| *role == label).map(|(_, rank)| *rank).unwrap_or(1)
}

pub fn derive<'a>(
    graph: &crate::shared::Graph<'a>,
    edges: &[IndexEdge],
    dispatched: &[IndexEdge],
    roles: &Roles,
    entry_points: &[EntryPoint],
    exit_points: &[ExitPoint],
) -> Vec<Layering> {
    let nodes: &'a [IndexNode] = graph.nodes;
    let position = &graph.position;
    let tested = |node: &IndexNode| graph.file_tested(node.file);

    let mut role_of: Vec<Option<&'static str>> = vec![None; nodes.len()];
    let preferred = |candidate: &str| BY_CLASS_FIRST.iter().position(|role| *role == candidate).unwrap_or(99);
    for role in &roles.roles {
        if role.role == "test" {
            continue;
        }
        let Some(at) = graph.at(role.node.as_str()) else { continue };
        let held = role_of[at].get_or_insert(role.role);
        if preferred(role.role) < preferred(held) {
            *held = role.role;
        }
    }
    let label_of = |at: usize| -> Option<&'static str> {
        if graph.tested[at] {
            return None;
        }
        let holder = graph.owner[at].and_then(|owner| role_of[owner]);
        let own = role_of[at];
        match (holder, own) {
            (Some(held), _) if BY_CLASS_FIRST.contains(&held) => Some(held),
            (_, Some(own)) => Some(own),
            (Some(held), None) => Some(held),
            (None, None) => None,
        }
    };
    let labels: Vec<Option<&'static str>> = (0..nodes.len()).map(label_of).collect();

    let overriding = graph.overriding();
    let mut callees: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    for edge in edges.iter().chain(dispatched).filter(|edge| matches!(edge.kind, EdgeKind::Calls | EdgeKind::Instantiates)) {
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
    let mut spoken: Vec<String> = Vec::new();
    let mut spoken_at: rustc_hash::FxHashMap<String, usize> = rustc_hash::FxHashMap::default();
    let mut speak = |label: String, spoken: &mut Vec<String>| -> usize {
        *spoken_at.entry(label.clone()).or_insert_with(|| {
            spoken.push(label);
            spoken.len() - 1
        })
    };
    let unit_label: Vec<Option<usize>> = labels
        .iter()
        .map(|label| label.map(|label| speak(label.to_string(), &mut spoken)))
        .collect();
    let mut sinks: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    for exit in exit_points {
        let Some(at) = position.get(exit.source.as_str()) else { continue };
        let label = match exit.service.as_deref() {
            Some(named) => format!("{}: {named}", exit.kind),
            None => format!("{}:", exit.kind),
        };
        let label = speak(label, &mut spoken);
        if !sinks[*at].contains(&label) {
            sinks[*at].push(label);
        }
    }
    let mut stamp: Vec<u32> = vec![0; nodes.len()];
    let mut generation = 0u32;

    let mut reaching: HashMap<Option<&str>, Vec<Reaching>> = HashMap::default();
    let mut counted: BTreeMap<(Option<&str>, String, String), (u32, usize, usize)> = BTreeMap::new();
    let mut note = |project: Option<&'a str>, from: String, to: String, caller: usize, callee: usize| {
        counted.entry((project, from, to)).or_insert((0, caller, callee)).0 += 1;
    };
    let project_of = |at: usize| -> Option<&'a str> { nodes[at].project.as_deref() };

    for (start, label) in labels.iter().enumerate() {
        let Some(label) = label else { continue };
        generation += 1;
        stamp[start] = generation;
        let mut frontier: Vec<(usize, u32)> = vec![(start, 0)];
        let mut reached: Vec<(usize, usize)> = Vec::new();
        let mut walked = 0usize;
        while let Some((current, hops)) = frontier.pop() {
            walked += 1;
            if walked > WALKED_AT_MOST {
                break;
            }
            for sink in &sinks[current] {
                if !reached.iter().any(|(held, _)| held == sink) {
                    reached.push((*sink, current));
                }
            }
            for callee in &callees[current] {
                if stamp[*callee] == generation {
                    continue;
                }
                stamp[*callee] = generation;
                match unit_label[*callee] {
                    Some(found) => {
                        if !reached.iter().any(|(held, _)| *held == found) {
                            reached.push((found, *callee));
                        }
                    }
                    None if hops < HOPS_THROUGH_HELPERS => frontier.push((*callee, hops + 1)),
                    None => {}
                }
            }
        }
        if rank_of(label) == 0 {
            reaching.entry(project_of(start)).or_default().push(Reaching {
                unit: nodes[start].id.clone(),
                layer: label,
                reaches: reached.iter().map(|(found, _)| spoken[*found].clone()).collect(),
            });
        }
        for (found, callee) in reached {
            note(project_of(start), label.to_string(), spoken[found].clone(), start, callee);
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
    let mut travelled: HashMap<Option<&str>, BTreeMap<Vec<String>, u32>> = HashMap::default();
    for entry in entry_points.iter().filter(|entry| !NOT_AN_ARRIVAL.contains(&entry.kind)) {
        let Some(start) = position.get(entry.handler.as_str()).copied() else { continue };
        if tested(&nodes[start]) {
            continue;
        }
        let mut layers: Vec<(u32, usize, usize)> = Vec::new();
        generation += 1;
        stamp[start] = generation;
        let mut walked = 1usize;
        let mut frontier: std::collections::VecDeque<(usize, u32)> = std::collections::VecDeque::from([(start, 0)]);
        let mut order = 0usize;
        while let Some((current, depth)) = frontier.pop_front() {
            if walked > WALKED_PER_ARRIVAL {
                break;
            }
            for found in unit_label[current].iter().chain(sinks[current].iter()) {
                if !layers.iter().any(|(_, _, held)| held == found) {
                    layers.push((rank_of(&spoken[*found]), order, *found));
                    order += 1;
                }
            }
            if depth >= DEPTH_PER_ARRIVAL {
                continue;
            }
            for callee in &callees[current] {
                if stamp[*callee] != generation {
                    stamp[*callee] = generation;
                    walked += 1;
                    frontier.push_back((*callee, depth + 1));
                }
            }
        }
        layers.sort();
        let mut path = vec![format!("{} entry", entry.kind)];
        path.extend(layers.into_iter().map(|(_, _, label)| spoken[label].clone()));
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
                reaching: reaching.remove(&project).unwrap_or_default(),
            }
        })
        .collect()
}

