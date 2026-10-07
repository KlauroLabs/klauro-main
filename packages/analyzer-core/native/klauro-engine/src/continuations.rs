use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::entry_exit::EntryPoint;
use crate::model::{EdgeKind, IndexEdge, IndexNode, LocalBinding, NodeKind};
use crate::names;

static RUNTIME_EMITTERS: &str = include_str!("../data/runtime_emitters.tsv");
static HANDLING: &[&str] = &["background", "graphql", "http", "ipc", "message", "rpc", "schedule", "tool", "ui"];

static STREAM_EVENTS: &str = include_str!("../data/stream_events.tsv");

fn a_streams_own_event(name: &str) -> bool {
    STREAM_EVENTS.lines().any(|held| held == name)
}

fn emitted_by_the_runtime(registrar: &str) -> bool {
    let Some((receiver, _)) = registrar.rsplit_once('.') else { return false };
    let root = names::root(receiver);
    RUNTIME_EMITTERS.lines().filter_map(|line| line.split_once('\t')).any(|(_, emitter)| emitter == root)
}

fn reached_while_handling<'a>(entry_points: &'a [EntryPoint], nodes: &'a [IndexNode], edges: &'a [IndexEdge]) -> HashSet<&'a str> {
    let mut next: HashMap<&str, Vec<&str>> = HashMap::default();
    for edge in edges.iter().filter(|edge| matches!(edge.kind, EdgeKind::Calls | EdgeKind::Contains | EdgeKind::Instantiates)) {
        next.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
    }
    for node in nodes {
        if let Some(parent) = node.parent.as_deref() {
            next.entry(parent).or_default().push(node.id.as_str());
        }
    }
    let mut reached: HashSet<&str> = HashSet::default();
    let mut queue: Vec<&str> = entry_points
        .iter()
        .filter(|entry| HANDLING.contains(&entry.kind) || (entry.kind == "cli" && !entry.id.ends_with(":program")))
        .map(|entry| entry.handler.as_str())
        .collect();
    while let Some(current) = queue.pop() {
        if !reached.insert(current) {
            continue;
        }
        if let Some(targets) = next.get(current) {
            queue.extend(targets.iter().copied().filter(|target| !reached.contains(target)));
        }
    }
    reached
}

fn is_callable(node: &IndexNode) -> bool {
    matches!(node.kind, NodeKind::Function | NodeKind::Method | NodeKind::Constructor)
}

fn enclosing_callables<'a>(registered_in: Option<&str>, node_of: &HashMap<&str, &'a IndexNode>) -> Vec<&'a IndexNode> {
    let mut found = Vec::new();
    let mut unit = registered_in.and_then(|id| node_of.get(id).copied()).filter(|node| is_callable(node));
    while let Some(held) = unit.filter(|_| found.len() < 16) {
        found.push(held);
        unit = held.parent.as_deref().and_then(|id| node_of.get(id).copied()).filter(|node| is_callable(node));
    }
    found
}

fn started_by_the_registering_unit(registrar: &str, registered_in: Option<&str>, node_of: &HashMap<&str, &IndexNode>, started: &HashMap<(&str, &str), &LocalBinding>) -> bool {
    let Some((receiver, _)) = registrar.rsplit_once('.') else { return false };
    let root = names::root(receiver);
    enclosing_callables(registered_in, node_of).iter().any(|unit| {
        started
            .get(&(unit.id.as_str(), root))
            .and_then(|local| local.from_call.as_deref().or(local.constructed.as_deref()))
            .is_some_and(crate::entry_exit::starts_a_continuation)
    })
}

pub fn fold_into_what_started_them(entry_points: &mut Vec<EntryPoint>, continued: &mut Vec<String>, nodes: &[IndexNode], edges: &[IndexEdge], locals: &[LocalBinding]) {
    let parent_of: HashMap<&str, &str> = nodes.iter().filter_map(|node| Some((node.id.as_str(), node.parent.as_deref()?))).collect();
    let node_of: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let started: HashMap<(&str, &str), &LocalBinding> = locals.iter().filter(|local| !local.unit.is_empty()).map(|local| ((local.unit.as_str(), local.name.as_str()), local)).collect();
    let reached = reached_while_handling(entry_points, nodes, edges);
    let drawn: HashSet<&str> = edges
        .iter()
        .filter(|edge| edge.kind == EdgeKind::Renders)
        .flat_map(|edge| [edge.source.as_str(), edge.target.as_str()])
        .collect();
    let declared_here: HashSet<&str> = nodes
        .iter()
        .filter(|node| matches!(node.kind, NodeKind::Function | NodeKind::Variable))
        .map(|node| node.name.as_str())
        .collect();
    let on_our_own_bus = |entry: &EntryPoint| {
        !entry.registrar.contains('.')
            && declared_here.contains(entry.registrar.as_str())
            && node_of.get(entry.handler.as_str()).is_some_and(|handler| handler.decorators.iter().any(|decorator| decorator.name == entry.registrar))
    };
    let folded: HashSet<String> = entry_points
        .iter()
        .filter(|entry| matches!(entry.kind, "event" | "schedule"))
        .filter(|entry| {
            let registered_in = parent_of.get(entry.handler.as_str()).copied();
            if entry.kind == "schedule" {
                return node_of.get(entry.handler.as_str()).is_some_and(|handler| handler.kind == NodeKind::Variable)
                    || enclosing_callables(registered_in, &node_of).iter().any(|unit| reached.contains(unit.id.as_str()));
            }
            a_streams_own_event(&entry.name)
                || emitted_by_the_runtime(&entry.registrar)
                || on_our_own_bus(entry)
                || registered_in.is_some_and(|unit| reached.contains(unit))
                || started_by_the_registering_unit(&entry.registrar, registered_in, &node_of, &started)
                || enclosing_callables(registered_in, &node_of).iter().any(|unit| drawn.contains(unit.id.as_str()))
        })
        .map(|entry| entry.id.clone())
        .collect();
    for entry in entry_points.iter().filter(|entry| folded.contains(&entry.id)) {
        continued.push(entry.handler.clone());
    }
    entry_points.retain(|entry| !folded.contains(&entry.id));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_the_process_itself_emits_is_never_an_entry() {
        assert!(emitted_by_the_runtime("process.on"));
        assert!(emitted_by_the_runtime("process.stdin.on"));
        assert!(!emitted_by_the_runtime("socket.on"));
        assert!(!emitted_by_the_runtime("document.addEventListener"));
    }
}
