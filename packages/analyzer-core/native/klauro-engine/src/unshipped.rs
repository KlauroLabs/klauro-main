use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::entry_exit::{EntryPoint, Unshipped};
use crate::model::*;
use crate::paths;
use crate::scope::Scope;

const ISLAND_NODES: usize = 150;
const ISLAND_ENTRIES: usize = 4;
const SURFACE_TO_ISLAND: usize = 5;

#[derive(Debug, Default)]
pub struct Census {
    pub tagged: usize,
    pub continuations: usize,
    pub continuations_held: usize,
    pub continuations_holder_unreached: usize,
    pub continuations_orphaned: usize,
}

impl Unshipped {
    pub fn is_established(&self) -> bool {
        matches!(
            self.basis,
            "shipping-evidence" | "island" | "program-only-reach" | "reaches-mostly-program-code" | "reaches-only-program-code" | "test-only-reach"
        )
    }
}

pub fn is_set_aside(tag: Option<&Unshipped>) -> bool {
    tag.is_some_and(Unshipped::is_established)
}

struct Graph {
    position_of: HashMap<String, u32>,
    next: Vec<Vec<u32>>,
    members: Vec<Vec<u32>>,
    nodes_of_file: HashMap<u32, Vec<u32>>,
}

impl Graph {
    fn build(nodes: &[IndexNode], edges: &[IndexEdge]) -> Graph {
        let mut position_of: HashMap<String, u32> = HashMap::default();
        for (at, node) in nodes.iter().enumerate() {
            position_of.insert(node.id.clone(), at as u32);
        }
        let mut next = vec![Vec::new(); nodes.len()];
        let mut members = vec![Vec::new(); nodes.len()];
        let mut nodes_of_file: HashMap<u32, Vec<u32>> = HashMap::default();
        for (at, node) in nodes.iter().enumerate() {
            nodes_of_file.entry(node.file).or_default().push(at as u32);
        }
        for edge in edges {
            let (Some(source), Some(target)) = (
                position_of.get(edge.source.as_str()).copied(),
                position_of.get(edge.target.as_str()).copied(),
            ) else {
                continue;
            };
            match edge.kind {
                EdgeKind::Calls | EdgeKind::Instantiates => next[source as usize].push(target),
                EdgeKind::Contains | EdgeKind::HasMethod => members[source as usize].push(target),
                _ => {}
            }
        }
        Graph { position_of, next, members, nodes_of_file }
    }

    fn reach(&self, start: u32, seen: &mut Vec<u32>, stamp: u32, queue: &mut Vec<u32>) -> usize {
        queue.clear();
        queue.push(start);
        seen[start as usize] = stamp;
        let mut head = 0;
        while head < queue.len() {
            let current = queue[head] as usize;
            head += 1;
            for target in self.next[current].iter().chain(self.members[current].iter()) {
                if seen[*target as usize] != stamp {
                    seen[*target as usize] = stamp;
                    queue.push(*target);
                }
            }
        }
        queue.len()
    }
}

fn measures_time(graph: &Graph, nodes: &[IndexNode], file: u32) -> bool {
    graph.nodes_of_file.get(&file).is_some_and(|own| {
        own.iter().any(|unit| {
            graph.next[*unit as usize].iter().any(|target| {
                let held = &nodes[*target as usize];
                held.kind == NodeKind::External && held.id.starts_with("runtime:") && {
                    let leaf = held.id.rsplit(':').next().unwrap_or_default();
                    leaf.ends_with(".now") || leaf.contains(".hrtime")
                }
            })
        })
    })
}

fn owns_a_build_script(path: &str, held: &HashSet<&str>) -> bool {
    let directory = paths::directory_of(path);
    let manifest = match directory.is_empty() {
        true => "Cargo.toml".to_string(),
        false => format!("{directory}/Cargo.toml"),
    };
    held.contains(manifest.as_str())
}

fn is_standalone_program(entry: &EntryPoint, path: &str, scope: &Scope) -> bool {
    matches!(entry.kind, "lifecycle" | "cli")
        && !paths::is_cargo_binary_entry(path)
        && paths::is_shipping_evidence_mappable(path)
        && scope.part_has_shipping_evidence(path)
        && !scope.ships_file_by_convention(path)
}

pub fn classify(
    entries: &mut [EntryPoint],
    files: &[String],
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    scope: &Scope,
    continued: &[String],
) -> (Vec<EntryPoint>, Census) {
    let held_files: HashSet<&str> = files.iter().map(String::as_str).collect();
    let graph = Graph::build(nodes, edges);
    let mut census = Census::default();

    let mut dropped: Vec<EntryPoint> = Vec::new();
    let mut signals: Vec<Option<(&'static str, &'static str, String)>> = vec![None; entries.len()];
    for (at, entry) in entries.iter().enumerate() {
        if entry.kind == "test" {
            continue;
        }
        let path = files[entry.file as usize].as_str();
        if matches!(entry.kind, "lifecycle" | "cli") && paths::is_cargo_build_script(path) {
            if owns_a_build_script(path, &held_files) {
                dropped.push(entry.clone());
                continue;
            }
            signals[at] = Some((
                "tooling",
                "name",
                "a build.rs file with no Cargo.toml beside it, so no package declares it as a build script".to_string(),
            ));
            continue;
        }
        let by_name = paths::role_named_by_path(path);
        let standalone = is_standalone_program(entry, path, scope);
        if let Some(role) = by_name {
            let named = match paths::is_not_shipped(path) {
                true => scope.deployables.iter().any(|unit| unit.category == "shipped" && unit.ships.iter().any(|shipped| shipped == path)),
                false => scope.ships_file(path),
            };
            if named {
                continue;
            }
            match paths::is_shipping_evidence_mappable(path) && scope.part_has_shipping_evidence(path) && !scope.ships_file_by_convention(path) {
                true => {
                    signals[at] = Some((
                        role,
                        "shipping-evidence",
                        format!("the part that holds {path} has shipping artifacts and none of them names this file"),
                    ));
                }
                false => {
                    signals[at] = Some((role, "name", format!("the path {path} is named like {role} code and no shipping artifact names it")));
                }
            }
            continue;
        }
        if standalone {
            let role = match measures_time(&graph, nodes, entry.file) {
                true => "benchmark",
                false => "tooling",
            };
            signals[at] = Some((
                role,
                "shipping-evidence",
                format!("the part that holds {path} has shipping artifacts and none of them names this program"),
            ));
        }
    }
    let dropped_ids: HashSet<&str> = dropped.iter().map(|entry| entry.id.as_str()).collect();

    let handler_at = |entry: &EntryPoint| graph.position_of.get(entry.handler.as_str()).copied();
    let mut counts = vec![0u32; nodes.len()];
    let mut reached_by_any = vec![false; nodes.len()];
    let mut seen = vec![0u32; nodes.len()];
    let mut queue: Vec<u32> = Vec::new();
    let mut stamp = 0u32;
    let mut counted: HashSet<u32> = HashSet::default();
    let mut walked: HashSet<u32> = HashSet::default();
    for (at, entry) in entries.iter().enumerate() {
        if entry.kind == "test" || dropped_ids.contains(entry.id.as_str()) {
            continue;
        }
        let Some(start) = handler_at(entry) else { continue };
        let toward_surface = signals[at].is_none();
        if toward_surface && !counted.insert(start) {
            continue;
        }
        if !toward_surface && !walked.insert(start) {
            continue;
        }
        stamp += 1;
        graph.reach(start, &mut seen, stamp, &mut queue);
        for reached in queue.iter() {
            reached_by_any[*reached as usize] = true;
            if toward_surface {
                counts[*reached as usize] += 1;
            }
        }
    }

    let mut entries_in_file: HashMap<u32, usize> = HashMap::default();
    for entry in entries.iter().filter(|entry| entry.kind != "test") {
        *entries_in_file.entry(entry.file).or_default() += 1;
    }
    let candidate_files: HashSet<u32> = entries
        .iter()
        .enumerate()
        .filter(|(at, _)| signals[*at].is_some())
        .map(|(_, entry)| entry.file)
        .collect();
    let mut depended_on: HashSet<u32> = HashSet::default();
    for edge in edges {
        if matches!(edge.kind, EdgeKind::Contains | EdgeKind::HasMethod | EdgeKind::HasField) {
            continue;
        }
        let (Some(source), Some(target)) = (
            graph.position_of.get(edge.source.as_str()).copied(),
            graph.position_of.get(edge.target.as_str()).copied(),
        ) else {
            continue;
        };
        let from = nodes[source as usize].file;
        let into = nodes[target as usize].file;
        if from != into && !candidate_files.contains(&from) && !paths::is_test(&files[from as usize]) {
            depended_on.insert(into);
        }
    }

    let island_of = |entry: &EntryPoint, signals_here: bool| -> Option<(usize, usize, usize)> {
        let start = handler_at(entry)?;
        if depended_on.contains(&entry.file) {
            return None;
        }
        let own = graph.nodes_of_file.get(&entry.file)?;
        let mut visited: HashSet<u32> = HashSet::default();
        let mut frontier: Vec<u32> = vec![start];
        visited.insert(start);
        while let Some(current) = frontier.pop() {
            for target in graph.next[current as usize].iter().chain(graph.members[current as usize].iter()) {
                if visited.insert(*target) {
                    frontier.push(*target);
                }
            }
        }
        let own_counted = !signals_here;
        let mut exclusive: HashSet<u32> = HashSet::default();
        for held in own.iter().copied().chain(visited.iter().copied()) {
            let mine = u32::from(own_counted && visited.contains(&held));
            let foreign = counts[held as usize].saturating_sub(mine);
            if foreign > 0 && nodes[held as usize].file == entry.file {
                return None;
            }
            if foreign == 0 {
                exclusive.insert(held);
            }
        }
        let surface = counts.iter().filter(|held| **held > 0).count();
        let own_entries = entries_in_file.get(&entry.file).copied().unwrap_or(0);
        Some((exclusive.len(), own_entries, surface))
    };

    for at in 0..entries.len() {
        if entries[at].kind == "test" || dropped_ids.contains(entries[at].id.as_str()) {
            continue;
        }
        let signal = signals[at].clone();
        if signal.is_none() {
            continue;
        }
        let island = island_of(&entries[at], signal.is_some()).filter(|(size, entered, surface)| {
            *size > 0 && *size <= ISLAND_NODES && *entered <= ISLAND_ENTRIES && *surface >= SURFACE_TO_ISLAND * *size
        });
        let described = |(size, entered, surface): (usize, usize, usize)| {
            format!(
                "its own file and the code only it reaches come to {size} nodes with {entered} entry points, nothing outside it depends on it, and the rest of the repository's entry points reach {surface} nodes"
            )
        };
        let tag = match (signal, island) {
            (Some((role, "shipping-evidence", why)), island) => Unshipped {
                role,
                basis: "shipping-evidence",
                evidence: match island {
                    Some(found) => format!("{why}; {}", described(found)),
                    None => why,
                },
            },
            (Some((role, _, why)), Some(found)) => Unshipped {
                role,
                basis: "island",
                evidence: format!("{}; also {why}", described(found)),
            },
            (Some((role, basis, why)), None) => Unshipped { role, basis, evidence: why },
            (None, _) => continue,
        };
        entries[at].unshipped = Some(tag);
        census.tagged += 1;
    }

    for id in continued {
        census.continuations += 1;
        let Some(at) = graph.position_of.get(id.as_str()).copied() else { continue };
        let node = &nodes[at as usize];
        let holder = node.parent.as_deref().and_then(|parent| graph.position_of.get(parent).copied());
        match (reached_by_any[at as usize], holder.is_some_and(|held| reached_by_any[held as usize])) {
            (true, _) => census.continuations_held += 1,
            (false, true) => census.continuations_orphaned += 1,
            (false, false) => census.continuations_holder_unreached += 1,
        }
    }
    (dropped, census)
}
