use std::collections::BTreeMap;
use std::path::Path;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::constants::{Constants, Standing};
use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::history::{self, History};
use crate::model::{CallFact, EdgeKind, IndexEdge, LocalBinding};
use crate::paths::{basename, is_test};
use crate::scope::Deployable;
use crate::subproject::{Partition, SubProject};

const EVIDENCE_KEPT: usize = 5;
const WEIGHT_FLOOR: f64 = 0.05;
const QUIET_ACTIVITY: f64 = 0.35;
const RECENT_DAYS: f64 = 30.0;
const LEGACY_DAYS: f64 = 180.0;
const STABLE_SHIPPED_FLOOR: f64 = 0.85;
const SECONDS_PER_DAY: f64 = 86400.0;
const MINIMUM_NAME: usize = 4;
const MINIMUM_COMMITS: u32 = 2;
const MINIMUM_ROOT_SEGMENTS: usize = 2;

#[derive(Debug, Serialize)]
pub struct WeightBasis {
    pub ship: f64,
    pub activity: f64,
    pub consumed_by_shipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days_since_change: Option<i64>,
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
    pub origin: &'static str,
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

#[derive(Debug, Default, Serialize)]
pub struct Followed {
    pub detected: u32,
    pub linked: u32,
}

#[derive(Debug, Serialize)]
pub struct LinkCoverage {
    pub project: String,
    pub http: Followed,
    pub process: Followed,
    pub ipc: Followed,
}

#[derive(Debug, Serialize)]
pub struct Composition {
    pub mode: &'static str,
    pub children: Vec<Child>,
    pub seams: Vec<Seam>,
    pub links: Vec<LinkCoverage>,
    pub dependencies: Vec<Dependency>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orphan: Option<Orphan>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub promoted: Vec<crate::parent::Promoted>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub not_promoted: Vec<crate::parent::NotPromoted>,
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

pub fn activity_factor(days_quiet: f64) -> f64 {
    if days_quiet <= RECENT_DAYS {
        return 1.0;
    }
    let aged = ((days_quiet - RECENT_DAYS) / (LEGACY_DAYS - RECENT_DAYS)).clamp(0.0, 1.0);
    1.0 - (1.0 - QUIET_ACTIVITY) * aged
}

pub fn carried_by_a_shipped_product(status: &str, consumed_by_shipped: bool) -> bool {
    status == "deployable" || consumed_by_shipped
}

pub fn modifier(activity: f64, shipped: bool) -> f64 {
    match shipped {
        true => STABLE_SHIPPED_FLOOR + (1.0 - STABLE_SHIPPED_FLOOR) * (activity - QUIET_ACTIVITY) / (1.0 - QUIET_ACTIVITY),
        false => activity,
    }
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

fn days_quiet(
    root: &Path,
    history: Option<&History>,
    projects: &[&SubProject],
    owner: &HashMap<&str, &str>,
) -> Option<HashMap<String, f64>> {
    let history = history?;
    if history.commits < MINIMUM_COMMITS || history.head <= 0 {
        return None;
    }
    let mut newest: HashMap<&str, i64> = HashMap::default();
    for (path, _, last) in &history.per_file {
        if let Some(id) = owner.get(path.as_str()) {
            let held = newest.entry(id).or_insert(0);
            *held = (*held).max(*last);
        }
    }
    let untouched = (history.head - history.oldest).max(0) as f64 / SECONDS_PER_DAY;
    Some(
        projects
            .iter()
            .map(|project| {
                let days = match newest.get(project.id.as_str()) {
                    Some(last) => (history.head - last).max(0) as f64 / SECONDS_PER_DAY,
                    None => match history::newest_change(root, &project.root) {
                        Some(last) => (history.head - last).max(0) as f64 / SECONDS_PER_DAY,
                        None => untouched,
                    },
                };
                (project.id.clone(), days)
            })
            .collect(),
    )
}

fn weigh(
    root: &Path,
    projects: &[&SubProject],
    history: Option<&History>,
    owner: &HashMap<&str, &str>,
) -> Vec<Child> {
    let substrate = shipped_substrate(projects);
    let quiet = days_quiet(root, history, projects, owner);
    let mut children: Vec<Child> = projects
        .iter()
        .map(|project| {
            let consumed = substrate.contains(&project.id);
            let ship = ship_factor(project.status, consumed);
            let mut notes = Vec::new();
            let mut quiet_days = None;
            let activity = match quiet.as_ref() {
                Some(days) => {
                    let own = days.get(&project.id).copied().unwrap_or(0.0);
                    quiet_days = Some(own.round() as i64);
                    activity_factor(own)
                }
                None => {
                    notes.push("no usable history, activity left neutral".to_string());
                    1.0
                }
            };
            let shipped = carried_by_a_shipped_product(project.status, consumed);
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
                weight: combined(ship, modifier(activity, shipped)),
                weight_basis: WeightBasis {
                    ship,
                    activity: rounded(activity),
                    days_since_change: quiet_days,
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
    let mut found: BTreeMap<(&str, &str, bool), (u32, Vec<String>)> = BTreeMap::new();
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
        let entry = found.entry((caller, target, is_test(file))).or_insert((0, Vec::new()));
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

fn ipc_seams(
    files: &[String],
    entry_points: &[EntryPoint],
    exit_points: &[ExitPoint],
    owner: &HashMap<&str, &str>,
) -> Vec<Seam> {
    let mut served: HashMap<&str, Vec<(&str, &EntryPoint)>> = HashMap::default();
    for entry in entry_points.iter().filter(|entry| entry.kind == "ipc") {
        let Some(file) = files.get(entry.file as usize) else { continue };
        if let Some(project) = owner.get(file.as_str()) {
            served.entry(entry.name.as_str()).or_default().push((project, entry));
        }
    }
    let mut found: BTreeMap<(&str, &str, bool), (u32, Vec<String>)> = BTreeMap::new();
    for exit in exit_points.iter().filter(|exit| exit.kind == "api") {
        let Some(channel) = exit.addressed.as_deref().and_then(|held| held.strip_prefix(crate::entry_exit::IPC_SCHEME)) else {
            continue;
        };
        let Some(file) = files.get(exit.file as usize) else { continue };
        let (Some(caller), Some(handlers)) = (owner.get(file.as_str()), served.get(channel)) else { continue };
        let targets: HashSet<&str> = handlers.iter().map(|(project, _)| *project).collect();
        if targets.len() != 1 || targets.contains(caller) {
            continue;
        }
        let (target, handler) = handlers[0];
        let handler_file = files.get(handler.file as usize).map(String::as_str).unwrap_or_default();
        let entry = found.entry((caller, target, is_test(file))).or_insert((0, Vec::new()));
        entry.0 += 1;
        entry.1.push(format!("{}:{} {} {} -> {}:{}", file, exit.line, exit.operation, channel, handler_file, handler.line));
    }
    seams_of("ipc", "sync", found)
}

fn link_coverage(
    files: &[String],
    exit_points: &[ExitPoint],
    owner: &HashMap<&str, &str>,
    seams: &[Seam],
) -> Vec<LinkCoverage> {
    let mut held: BTreeMap<&str, LinkCoverage> = BTreeMap::new();
    for exit in exit_points.iter().filter(|exit| matches!(exit.kind, "api" | "process")) {
        let Some(file) = files.get(exit.file as usize).filter(|file| !is_test(file)) else { continue };
        let Some(project) = owner.get(file.as_str()) else { continue };
        let entry = held.entry(project).or_insert_with(|| LinkCoverage {
            project: project.to_string(),
            http: Followed::default(),
            process: Followed::default(),
            ipc: Followed::default(),
        });
        match (exit.kind, exit.addressed.as_deref()) {
            ("process", _) => entry.process.detected += 1,
            ("api", Some(address)) if address.starts_with(crate::entry_exit::IPC_SCHEME) => entry.ipc.detected += 1,
            ("api", Some(_)) => entry.http.detected += 1,
            _ => {}
        }
    }
    for seam in seams.iter().filter(|seam| seam.origin == "product") {
        let Some(entry) = held.get_mut(seam.from.as_str()) else { continue };
        let followed = match seam.kind {
            "http" => &mut entry.http,
            "process" => &mut entry.process,
            _ => &mut entry.ipc,
        };
        followed.linked += seam.count;
    }
    held.into_values().collect()
}

fn seams_of(
    kind: &'static str,
    communication: &'static str,
    found: BTreeMap<(&str, &str, bool), (u32, Vec<String>)>,
) -> Vec<Seam> {
    found
        .into_iter()
        .map(|((from, to, in_test), (count, mut evidence))| {
            evidence.sort();
            evidence.dedup();
            evidence.truncate(EVIDENCE_KEPT);
            Seam {
                from: from.to_string(),
                to: to.to_string(),
                kind,
                communication,
                origin: if in_test { "test" } else { "product" },
                count,
                evidence,
            }
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

fn path_segments(written: &str) -> Vec<String> {
    written
        .trim_matches(['"', '\''])
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty() && *segment != "." && *segment != "..")
        .map(|segment| segment.to_ascii_lowercase())
        .collect()
}

fn rooted_projects(projects: &[&SubProject]) -> Vec<(Vec<String>, String)> {
    projects
        .iter()
        .map(|project| (path_segments(&project.root), project.id.clone()))
        .filter(|(segments, _)| segments.len() >= MINIMUM_ROOT_SEGMENTS)
        .collect()
}

fn reached_through_a_path<'a>(
    spelled: &str,
    rooted: &'a [(Vec<String>, String)],
    caller: &str,
) -> Option<(&'a str, String)> {
    let mut found: Vec<(usize, &str)> = Vec::new();
    for word in spelled.split_whitespace() {
        let segments = path_segments(word);
        for (root, id) in rooted.iter().filter(|(_, id)| id != caller) {
            if segments.windows(root.len()).any(|window| window == root.as_slice()) {
                found.push((root.len(), id.as_str()));
            }
        }
    }
    let longest = found.iter().map(|(length, _)| *length).max()?;
    let mut leading: Vec<&str> = found.into_iter().filter(|(length, _)| *length == longest).map(|(_, id)| id).collect();
    leading.sort_unstable();
    leading.dedup();
    match leading.as_slice() {
        [only] => Some((*only, spelled.trim().to_string())),
        _ => None,
    }
}

fn process_seams(
    files: &[String],
    exit_points: &[ExitPoint],
    calls: &[CallFact],
    owner: &HashMap<&str, &str>,
    names: &HashMap<String, Option<String>>,
    rooted: &[(Vec<String>, String)],
    constants: &Constants,
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
    let mut found: BTreeMap<(&str, &str, bool), (u32, Vec<String>)> = BTreeMap::new();
    for exit in exit_points.iter().filter(|exit| exit.kind == "process") {
        let Some(file) = files.get(exit.file as usize) else { continue };
        let Some(caller) = owner.get(file.as_str()) else { continue };
        let Some(literals) = spoken.get(&(exit.file, exit.line)) else { continue };
        let standing = Standing { file: exit.file, unit: exit.source.as_str(), owner: None, node: None };
        let reached: Option<(&str, String)> = literals.iter().find_map(|literal| {
            let spelled = constants.spell(&standing, literal);
            command_words(&spelled)
                .into_iter()
                .find_map(|word| {
                    let target = names.get(&word)?.as_deref()?;
                    (target != *caller).then(|| (target, word))
                })
                .or_else(|| reached_through_a_path(&spelled, rooted, caller))
        });
        let Some((target, word)) = reached else { continue };
        let entry = found.entry((caller, target, is_test(file))).or_insert((0, Vec::new()));
        entry.0 += 1;
        entry.1.push(format!("{}:{} starts {}", file, exit.line, word));
    }
    seams_of("process", "sync", found)
}

pub fn derive(
    root: &Path,
    partition: &Partition,
    history: Option<&History>,
    files: &[String],
    edges: &[IndexEdge],
    entry_points: &[EntryPoint],
    exit_points: &[ExitPoint],
    calls: &[CallFact],
    locals: &[LocalBinding],
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
    let constants = Constants::new(locals);
    let rooted = rooted_projects(&projects);
    seams.extend(ipc_seams(files, entry_points, exit_points, &owner));
    seams.extend(process_seams(files, exit_points, calls, &owner, &names, &rooted, &constants));
    let links = link_coverage(files, exit_points, &owner, &seams);
    Some(Composition {
        mode: "derived",
        children: weigh(root, &projects, history, &owner),
        seams,
        links,
        dependencies: dependencies(edges, &owner, residue.map(|project| project.id.as_str())),
        orphan: residue.map(|project| Orphan {
            project: project.id.clone(),
            files: project.files,
            declarations: project.declarations,
        }),
        promoted: Vec::new(),
        not_promoted: Vec::new(),
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
        assert_eq!(activity_factor(0.0), 1.0);
        assert_eq!(activity_factor(RECENT_DAYS), 1.0);
        assert_eq!(activity_factor(LEGACY_DAYS), 0.35);
        assert_eq!(activity_factor(10_000.0), 0.35);
        assert!(activity_factor(60.0) > activity_factor(100.0));
        assert!(activity_factor(100.0) > activity_factor(150.0));
    }

    #[test]
    fn a_stable_shipped_child_is_only_mildly_modified() {
        assert_eq!(modifier(0.35, true), 0.85);
        assert_eq!(modifier(1.0, true), 1.0);
        assert_eq!(modifier(0.35, false), 0.35);
        assert!(carried_by_a_shipped_product("deployable", false));
        assert!(carried_by_a_shipped_product("library", true));
        assert!(!carried_by_a_shipped_product("module", false));
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
