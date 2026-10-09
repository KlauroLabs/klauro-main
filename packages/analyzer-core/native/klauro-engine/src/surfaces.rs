use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::entry_exit::EntryPoint;
use crate::model::{EdgeKind, IndexEdge, IndexNode, NodeKind};
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

pub fn public_where_nothing_enters(partition: &Partition, nodes: &[IndexNode], entry_points: &[EntryPoint], files: &[String]) -> Vec<EntryPoint> {
    let owner: HashMap<&str, &str> = partition.assignment.iter().map(|(path, id)| (path.as_str(), id.as_str())).collect();
    let part_of_file = |file: u32| files.get(file as usize).and_then(|path| owner.get(path.as_str()).copied());
    let entered: HashSet<&str> = entry_points
        .iter()
        .filter(|entry| entry.kind != "test")
        .filter_map(|entry| part_of_file(entry.file))
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
