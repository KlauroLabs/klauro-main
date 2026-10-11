use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::entry_exit::EntryPoint;
use crate::model::{CallFact, EdgeKind, IndexEdge, IndexNode, NodeKind};
use crate::subproject::Partition;

const USED_BY_OTHER_PARTS: &str = "used-by-other-parts";
const PUBLIC_TO_ANY_CALLER: &str = "public-to-any-caller";
static STARTS_OR_SERVES: &[&str] = &["background", "cli", "graphql", "http", "ipc", "lifecycle", "message", "rpc", "tool", "ui"];

fn reaches_across(kind: EdgeKind) -> bool {
    matches!(kind, EdgeKind::Calls | EdgeKind::Instantiates | EdgeKind::Extends | EdgeKind::Implements | EdgeKind::Renders)
}

fn offering(node: &IndexNode, how: &str, kind: &'static str, registrar: &str) -> EntryPoint {
    EntryPoint {
        id: format!("entry:{}:{how}", node.id),
        kind,
        name: node.name.clone(),
        method: None,
        path: None,
        handler: node.id.clone(),
        file: node.file,
        line: node.span.line,
        guards: Vec::new(),
        registrar: registrar.to_string(),
        unshipped: None,
    }
}

pub fn offered_to_other_parts(partition: &Partition, nodes: &[IndexNode], edges: &[IndexEdge], entry_points: &[EntryPoint], files: &[String]) -> Vec<EntryPoint> {
    let owner: HashMap<&str, &str> = partition.assignment.iter().map(|(path, id)| (path.as_str(), id.as_str())).collect();
    let file_of = |id: &str| id.split(':').next().unwrap_or(id).to_string();
    let part_of_file = |path: &str| owner.get(path).copied();
    let acting: HashSet<&str> = entry_points
        .iter()
        .filter(|entry| STARTS_OR_SERVES.contains(&entry.kind) && !crate::unshipped::is_set_aside(entry.unshipped.as_ref()))
        .filter_map(|entry| files.get(entry.file as usize).and_then(|path| part_of_file(path)))
        .collect();
    let declared: HashMap<&str, &IndexNode> = nodes
        .iter()
        .filter(|node| node.kind.is_declaration() && node.parent.is_some())
        .map(|node| (node.id.as_str(), node))
        .collect();
    let already: HashSet<&str> = entry_points.iter().filter(|entry| entry.kind == "export").map(|entry| entry.handler.as_str()).collect();
    let mut offered: HashSet<&str> = HashSet::default();
    for edge in edges.iter().filter(|edge| reaches_across(edge.kind)) {
        let Some(target) = declared.get(edge.target.as_str()) else { continue };
        let from = file_of(&edge.source);
        if crate::paths::is_test(&from) {
            continue;
        }
        let Some(to_path) = files.get(target.file as usize) else { continue };
        if crate::paths::is_test(to_path) {
            continue;
        }
        let (Some(caller), Some(callee)) = (part_of_file(&from), part_of_file(to_path)) else { continue };
        if caller != callee && !acting.contains(callee) && !already.contains(target.id.as_str()) {
            offered.insert(target.id.as_str());
        }
    }
    let mut found: Vec<EntryPoint> = offered
        .into_iter()
        .filter_map(|id| declared.get(id))
        .map(|node| offering(node, "offered", "export", USED_BY_OTHER_PARTS))
        .collect();
    found.sort_by(|left, right| left.id.cmp(&right.id));
    found
}

fn hosted_elsewhere<'a>(nodes: &'a [IndexNode], calls: &[CallFact], part_of_file: &impl Fn(u32) -> Option<&'a str>) -> HashSet<(String, &'a str)> {
    let node_of: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut hosted = HashSet::default();
    for call in calls.iter().filter(|call| crate::behaviours::hosts(&call.callee)) {
        let Some(host) = call.caller.as_deref().and_then(|caller| node_of.get(caller)).and_then(|caller| part_of_file(caller.file)) else { continue };
        for argument in &call.type_arguments {
            for named in argument.split(['<', '>', ',', ' ']).filter(|named| !named.is_empty()) {
                hosted.insert((crate::names::leaf(named).to_string(), host));
            }
        }
    }
    hosted
}

fn owning_type<'a>(handler: &str, node_of: &HashMap<&str, &'a IndexNode>) -> Option<&'a IndexNode> {
    let mut owner = node_of.get(handler).copied();
    while let Some(node) = owner.filter(|node| !node.kind.is_type()) {
        owner = node.parent.as_deref().and_then(|parent| node_of.get(parent).copied());
    }
    owner
}

pub fn public_where_nothing_enters(partition: &Partition, nodes: &[IndexNode], entry_points: &[EntryPoint], files: &[String], calls: &[CallFact]) -> Vec<EntryPoint> {
    let owner: HashMap<&str, &str> = partition.assignment.iter().map(|(path, id)| (path.as_str(), id.as_str())).collect();
    let part_of_file = |file: u32| files.get(file as usize).and_then(|path| owner.get(path.as_str()).copied());
    let hosted = hosted_elsewhere(nodes, calls, &part_of_file);
    let node_of: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let entered: HashSet<&str> = entry_points
        .iter()
        .filter(|entry| entry.kind != "test")
        .filter_map(|entry| {
            let part = part_of_file(entry.file)?;
            let elsewhere = owning_type(&entry.handler, &node_of).is_some_and(|owner| hosted.iter().any(|(named, host)| named == &owner.name && *host != part));
            (!elsewhere).then_some(part)
        })
        .collect();
    let public: Vec<&IndexNode> = nodes
        .iter()
        .filter(|node| node.modifiers.exported && (node.kind.is_type() || matches!(node.kind, NodeKind::Function | NodeKind::Method)))
        .filter(|node| files.get(node.file as usize).is_some_and(|path| !crate::paths::is_test(path)))
        .filter(|node| part_of_file(node.file).is_some_and(|part| !entered.contains(part)))
        .collect();
    let acting: HashSet<&str> = public
        .iter()
        .filter(|node| !node.kind.is_type())
        .filter_map(|node| part_of_file(node.file))
        .collect();
    public
        .into_iter()
        .filter(|node| !node.kind.is_type() || part_of_file(node.file).is_some_and(|part| !acting.contains(part)))
        .map(|node| offering(node, "public", "public", PUBLIC_TO_ANY_CALLER))
        .collect()
}
