use std::collections::BTreeMap;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::history::History;
use crate::model::{CallFact, EdgeKind, IndexEdge};
use crate::paths::basename;
use crate::scope::Deployable;
use crate::subproject::{Partition, SubProject};

const EVIDENCE_KEPT: usize = 5;
const WEIGHT_FLOOR: f64 = 0.05;
const QUIET_ACTIVITY: f64 = 0.35;
const MINIMUM_NAME: usize = 4;
const MINIMUM_COMMITS: u32 = 2;

#[derive(Debug, Serialize)]
pub struct WeightBasis {
    pub ship: f64,
    pub activity: f64,
    pub consumed_by_shipped: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Child {
    pub id: String,
    pub name: String,
    pub status: &'static str,
    pub weight: f64,
    pub weight_basis: WeightBasis,
}

#[derive(Debug, Serialize)]
pub struct Seam {
    pub from: String,
    pub to: String,
    pub kind: &'static str,
    pub communication: &'static str,
    pub count: u32,
    pub evidence: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Dependency {
    pub from: String,
    pub to: String,
    pub count: u32,
    pub evidence: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Orphan {
    pub project: String,
    pub files: u32,
    pub declarations: u32,
}

#[derive(Debug, Serialize)]
pub struct Composition {
    pub mode: &'static str,
    pub children: Vec<Child>,
    pub seams: Vec<Seam>,
    pub dependencies: Vec<Dependency>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orphan: Option<Orphan>,
}

fn rounded(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

pub fn ship_factor(status: &str, consumed_by_shipped: bool) -> f64 {
    match (status, consumed_by_shipped) {
        ("deployable", _) => 1.0,
        ("executable", _) => 0.8,
        ("library", true) => 0.6,
        ("library", false) => 0.4,
        _ => 0.35,
    }
}

pub fn activity_factor(changes: u64, busiest: u64) -> f64 {
    if busiest == 0 {
        return 1.0;
    }
    let share = changes as f64 / busiest as f64;
    QUIET_ACTIVITY + (1.0 - QUIET_ACTIVITY) * share.clamp(0.0, 1.0).sqrt()
}

pub fn combined(ship: f64, activity: f64) -> f64 {
    rounded((ship * activity).clamp(WEIGHT_FLOOR, 1.0))
}

fn shipped_substrate(projects: &[&SubProject]) -> HashSet<String> {
    let mut needs: HashMap<&str, Vec<&str>> = HashMap::default();
    for project in projects {
        for consumer in &project.consumed_by {
            needs.entry(consumer.as_str()).or_default().push(project.id.as_str());
        }
    }
    let mut reached: HashSet<String> = HashSet::default();
    let mut frontier: Vec<&str> = projects
        .iter()
        .filter(|project| project.status == "deployable")
        .map(|project| project.id.as_str())
        .collect();
    while let Some(current) = frontier.pop() {
        for target in needs.get(current).into_iter().flatten() {
            if reached.insert((*target).to_string()) {
                frontier.push(target);
            }
        }
    }
    reached
}

fn recent_changes(
    history: Option<&History>,
    projects: &[&SubProject],
    owner: &HashMap<&str, &str>,
) -> Option<HashMap<String, u64>> {
    let history = history?;
    if history.commits < MINIMUM_COMMITS {
        return None;
    }
    let mut counted: HashMap<String, u64> = projects.iter().map(|project| (project.id.clone(), 0)).collect();
    for (path, commits) in &history.per_file {
        if let Some(id) = owner.get(path.as_str())
            && let Some(total) = counted.get_mut(*id)
        {
            *total += u64::from(*commits);
        }
    }
    (counted.values().sum::<u64>() > 0).then_some(counted)
}

fn weigh(
    projects: &[&SubProject],
    history: Option<&History>,
    owner: &HashMap<&str, &str>,
) -> Vec<Child> {
    let substrate = shipped_substrate(projects);
    let changes = recent_changes(history, projects, owner);
    let busiest = changes
        .as_ref()
        .and_then(|counted| counted.values().copied().max())
        .unwrap_or(0);
    let mut children: Vec<Child> = projects
        .iter()
        .map(|project| {
            let consumed = substrate.contains(&project.id);
            let ship = ship_factor(project.status, consumed);
            let mut notes = Vec::new();
            let activity = match changes.as_ref() {
                Some(counted) => {
                    let own = counted.get(&project.id).copied().unwrap_or(0);
                    if own == 0 {
                        notes.push("no change in the recent history".to_string());
                    }
                    activity_factor(own, busiest)
                }
                None => {
                    notes.push("no usable history, activity left neutral".to_string());
                    1.0
                }
            };
            if consumed {
                notes.push("imported by a shipped sub-project, so it is substrate of that behaviour".to_string());
            }
            if project.status == "module" {
                notes.push("nothing ships it, runs it or imports it".to_string());
            }
            Child {
                id: project.id.clone(),
                name: project.name.clone(),
                status: project.status,
                weight: combined(ship, activity),
                weight_basis: WeightBasis {
                    ship,
                    activity: rounded(activity),
                    consumed_by_shipped: consumed,
                    notes,
                },
            }
        })
        .collect();
    children.sort_by(|left, right| {
        right
            .weight
            .partial_cmp(&left.weight)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left.id.cmp(&right.id))
    });
    children
}

fn dependencies(edges: &[IndexEdge], owner: &HashMap<&str, &str>, residue: Option<&str>) -> Vec<Dependency> {
    let mut found: BTreeMap<(&str, &str), (u32, Vec<String>)> = BTreeMap::new();
    for edge in edges.iter().filter(|edge| edge.kind == EdgeKind::Imports) {
        let (Some(from), Some(to)) = (owner.get(edge.source.as_str()), owner.get(edge.target.as_str())) else {
            continue;
        };
        if from == to || residue == Some(*from) || residue == Some(*to) {
            continue;
        }
        let entry = found.entry((from, to)).or_insert((0, Vec::new()));
        entry.0 += 1;
        entry.1.push(format!("{} -> {}", edge.source, edge.target));
    }
    found
        .into_iter()
        .map(|((from, to), (count, mut evidence))| {
            evidence.sort();
            evidence.truncate(EVIDENCE_KEPT);
            Dependency { from: from.to_string(), to: to.to_string(), count, evidence }
        })
        .collect()
}

pub fn route_shape(path: &str) -> String {
    let bare = path.split(['?', '#']).next().unwrap_or(path).trim().trim_end_matches('/');
    let shaped: Vec<String> = bare
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let placeholder = segment.starts_with([':', '{', '<', '[', '$']) || segment.contains("${");
            match placeholder {
                true => "{}".to_string(),
                false => segment.to_ascii_lowercase(),
            }
        })
        .collect();
    format!("/{}", shaped.join("/"))
}

static HTTP_VERBS: &[&str] = &["delete", "get", "head", "options", "patch", "post", "put"];

static VERB_SUFFIXES: &[&str] = &["fromjson", "asjson", "string", "bytearray", "stream"];

fn verb_of(operation: &str) -> Option<&'static str> {
    let lowered = operation.split('<').next().unwrap_or(operation).to_ascii_lowercase();
    let spoken = lowered.strip_suffix("async").unwrap_or(&lowered);
    let spoken = VERB_SUFFIXES
        .iter()
        .find_map(|suffix| spoken.strip_suffix(suffix))
        .unwrap_or(spoken);
    HTTP_VERBS.iter().copied().find(|verb| *verb == spoken)
}

fn answers(route_method: Option<&str>, asked: Option<&str>) -> bool {
    let Some(asked) = asked else { return true };
    match route_method.map(str::to_ascii_lowercase).as_deref() {
        None | Some("all") | Some("any") | Some("*") => true,
        Some(held) => held == asked,
    }
}

fn http_seams(
    files: &[String],
    entry_points: &[EntryPoint],
    exit_points: &[ExitPoint],
    owner: &HashMap<&str, &str>,
) -> Vec<Seam> {
    let mut served: HashMap<String, Vec<(&str, &EntryPoint)>> = HashMap::default();
    for entry in entry_points.iter().filter(|entry| entry.kind == "http") {
        let (Some(path), Some(file)) = (entry.path.as_deref(), files.get(entry.file as usize)) else {
            continue;
        };
        if let Some(project) = owner.get(file.as_str()) {
            served.entry(route_shape(path)).or_default().push((project, entry));
        }
    }
    let mut found: BTreeMap<(&str, &str), (u32, Vec<String>)> = BTreeMap::new();
    for exit in exit_points.iter().filter(|exit| exit.kind == "api") {
        let (Some(addressed), Some(file)) = (exit.addressed.as_deref(), files.get(exit.file as usize)) else {
            continue;
        };
        let Some(caller) = owner.get(file.as_str()) else { continue };
        let asked = verb_of(&exit.operation);
        let shape = route_shape(addressed);
        let Some(routes) = served.get(&shape) else { continue };
        let matching: Vec<&(&str, &EntryPoint)> = routes
            .iter()
            .filter(|(_, entry)| answers(entry.method.as_deref(), asked))
            .collect();
        let targets: HashSet<&str> = matching.iter().map(|(project, _)| *project).collect();
        let unambiguous = asked.is_some() || matching.len() == 1;
        if targets.len() != 1 || targets.contains(caller) || !unambiguous {
            continue;
        }
        let (target, route) = matching[0];
        let route_file = files.get(route.file as usize).map(String::as_str).unwrap_or_default();
        let entry = found.entry((caller, target)).or_insert((0, Vec::new()));
        entry.0 += 1;
        entry.1.push(format!(
            "{}:{} {} {} -> {}:{} {} {}",
            file,
            exit.line,
            asked.unwrap_or("request").to_ascii_uppercase(),
            addressed,
            route_file,
            route.line,
            route.method.as_deref().unwrap_or("any").to_ascii_uppercase(),
            route.path.as_deref().unwrap_or_default()
        ));
    }
    seams_of("http", "sync", found)
}

fn seams_of(
    kind: &'static str,
    communication: &'static str,
    found: BTreeMap<(&str, &str), (u32, Vec<String>)>,
) -> Vec<Seam> {
    found
        .into_iter()
        .map(|((from, to), (count, mut evidence))| {
            evidence.sort();
            evidence.dedup();
            evidence.truncate(EVIDENCE_KEPT);
            Seam { from: from.to_string(), to: to.to_string(), kind, communication, count, evidence }
        })
        .collect()
}

fn plain_name(name: &str) -> String {
    let unscoped = name.rsplit('/').next().unwrap_or(name);
    unscoped.to_ascii_lowercase()
}

fn spawnable_names(projects: &[&SubProject], deployables: &[Deployable]) -> HashMap<String, Option<String>> {
    let mut named: HashMap<String, Option<String>> = HashMap::default();
    let mut claim = |name: String, id: &str| {
        if name.len() < MINIMUM_NAME {
            return;
        }
        named
            .entry(name)
            .and_modify(|held| {
                if held.as_deref() != Some(id) {
                    *held = None;
                }
            })
            .or_insert_with(|| Some(id.to_string()));
    };
    for project in projects {
        claim(plain_name(&project.name), &project.id);
        if !project.root.is_empty() {
            claim(plain_name(basename(&project.root)), &project.id);
        }
        for unit in deployables.iter().filter(|unit| !unit.root.is_empty() && unit.root == project.root) {
            claim(plain_name(&unit.name), &project.id);
        }
    }
    named
}

fn command_words(literal: &str) -> Vec<String> {
    literal
        .split_whitespace()
        .map(|word| {
            let leaf = word.trim_matches(['"', '\'']).rsplit(['/', '\\']).next().unwrap_or(word);
            let bare = leaf
                .strip_suffix(".exe")
                .or_else(|| leaf.strip_suffix(".js"))
                .or_else(|| leaf.strip_suffix(".mjs"))
                .or_else(|| leaf.strip_suffix(".py"))
                .or_else(|| leaf.strip_suffix(".sh"))
                .unwrap_or(leaf);
            bare.to_ascii_lowercase()
        })
        .collect()
}

fn process_seams(
    files: &[String],
    exit_points: &[ExitPoint],
    calls: &[CallFact],
    owner: &HashMap<&str, &str>,
    names: &HashMap<String, Option<String>>,
) -> Vec<Seam> {
    let spawning: HashSet<(u32, u32)> = exit_points
        .iter()
        .filter(|exit| exit.kind == "process")
        .map(|exit| (exit.file, exit.line))
        .collect();
    if spawning.is_empty() {
        return Vec::new();
    }
    let mut spoken: HashMap<(u32, u32), Vec<&str>> = HashMap::default();
    for call in calls.iter().filter(|call| spawning.contains(&(call.file, call.line))) {
        spoken
            .entry((call.file, call.line))
            .or_default()
            .extend(call.literals.iter().map(String::as_str));
    }
    let mut found: BTreeMap<(&str, &str), (u32, Vec<String>)> = BTreeMap::new();
    for exit in exit_points.iter().filter(|exit| exit.kind == "process") {
        let Some(file) = files.get(exit.file as usize) else { continue };
        let Some(caller) = owner.get(file.as_str()) else { continue };
        let Some(literals) = spoken.get(&(exit.file, exit.line)) else { continue };
        let reached: Option<(&str, String)> = literals.iter().find_map(|literal| {
            command_words(literal).into_iter().find_map(|word| {
                let target = names.get(&word)?.as_deref()?;
                (target != *caller).then(|| (target, word))
            })
        });
        let Some((target, word)) = reached else { continue };
        let entry = found.entry((caller, target)).or_insert((0, Vec::new()));
        entry.0 += 1;
        entry.1.push(format!("{}:{} starts {}", file, exit.line, word));
    }
    seams_of("process", "sync", found)
}

pub fn derive(
    partition: &Partition,
    history: Option<&History>,
    files: &[String],
    edges: &[IndexEdge],
    entry_points: &[EntryPoint],
    exit_points: &[ExitPoint],
    calls: &[CallFact],
    deployables: &[Deployable],
) -> Option<Composition> {
    if !partition.sub_cas_nodes.promoted {
        return None;
    }
    let residue = partition
        .sub_projects
        .iter()
        .find(|project| project.declared_by == "repository-residue");
    let projects: Vec<&SubProject> = partition
        .sub_projects
        .iter()
        .filter(|project| project.declared_by != "repository-residue")
        .collect();
    let owner: HashMap<&str, &str> = partition
        .assignment
        .iter()
        .map(|(path, id)| (path.as_str(), id.as_str()))
        .collect();
    let names = spawnable_names(&projects, deployables);
    let mut seams = http_seams(files, entry_points, exit_points, &owner);
    seams.extend(process_seams(files, exit_points, calls, &owner, &names));
    Some(Composition {
        mode: "derived",
        children: weigh(&projects, history, &owner),
        seams,
        dependencies: dependencies(edges, &owner, residue.map(|project| project.id.as_str())),
        orphan: residue.map(|project| Orphan {
            project: project.id.clone(),
            files: project.files,
            declarations: project.declarations,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weight_is_ship_times_activity_floored_and_capped() {
        assert_eq!(combined(1.0, 1.0), 1.0);
        assert_eq!(combined(0.35, 0.35), 0.122);
        assert_eq!(combined(0.1, 0.1), WEIGHT_FLOOR);
    }

    #[test]
    fn ship_axis_runs_deployable_executable_library_module() {
        assert_eq!(ship_factor("deployable", false), 1.0);
        assert_eq!(ship_factor("executable", false), 0.8);
        assert_eq!(ship_factor("library", true), 0.6);
        assert_eq!(ship_factor("library", false), 0.4);
        assert_eq!(ship_factor("module", false), 0.35);
    }

    #[test]
    fn activity_axis_is_bounded_monotonic_and_neutral_without_history() {
        assert_eq!(activity_factor(5, 0), 1.0);
        assert_eq!(activity_factor(0, 10), 0.35);
        assert_eq!(activity_factor(10, 10), 1.0);
        assert!(activity_factor(2, 10) < activity_factor(5, 10));
        assert!(activity_factor(5, 10) < activity_factor(10, 10));
    }

    #[test]
    fn a_client_operation_names_its_verb_however_it_is_decorated() {
        assert_eq!(verb_of("GetFromJsonAsync<Item>"), Some("get"));
        assert_eq!(verb_of("PostAsJsonAsync"), Some("post"));
        assert_eq!(verb_of("DeleteAsync"), Some("delete"));
        assert_eq!(verb_of("put"), Some("put"));
        assert_eq!(verb_of("fetch"), None);
        assert_eq!(verb_of("SendAsync"), None);
    }

    #[test]
    fn placeholders_in_every_framework_syntax_match_each_other() {
        let shapes = ["/items/:id", "/items/{id}", "/items/<id>/", "/Items/${id}?x=1", "/items/[id]"];
        assert!(shapes.iter().all(|shape| route_shape(shape) == "/items/{}"));
        assert_ne!(route_shape("/items"), route_shape("/items/{id}"));
    }

    #[test]
    fn a_command_line_reduces_to_the_program_names_it_mentions() {
        assert_eq!(command_words("./target/release/Klauro-Engine --flag"), vec!["klauro-engine", "--flag"]);
        assert_eq!(command_words("dist/worker.js"), vec!["worker"]);
    }
}
