use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::entry_exit::EntryPoint;
use crate::graph::GraphFacts;
use crate::model::*;

#[derive(Debug, Serialize)]
pub struct Dead {
    pub node: String,
    pub reason: &'static str,
    pub callers: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open: Option<&'static str>,
    #[serde(skip_serializing_if = "is_zero")]
    pub unlinked: u32,
}

fn is_zero(count: &u32) -> bool {
    *count == 0
}

const ANONYMOUS: &[&str] = &["", "lambda", "closure", "anonymous", "<anonymous>", "default"];

pub fn derive(
    nodes: &[IndexNode],
    files: &[String],
    edges: &[IndexEdge],
    entry_points: &[EntryPoint],
    calls: &[CallFact],
    graph: &GraphFacts,
) -> Vec<Dead> {
    let position_of: HashMap<&str, usize> =
        nodes.iter().enumerate().map(|(position, node)| (node.id.as_str(), position)).collect();
    let mut callers = vec![0u32; nodes.len()];
    let mut extending: HashSet<&str> = HashSet::default();
    for edge in edges {
        match edge.kind {
            EdgeKind::Calls | EdgeKind::Instantiates if edge.source != edge.target => {
                if let (Some(_), Some(target)) = (position_of.get(edge.source.as_str()), position_of.get(edge.target.as_str())) {
                    callers[*target] += 1;
                }
            }
            EdgeKind::Extends | EdgeKind::Implements => {
                extending.insert(edge.source.as_str());
            }
            _ => {}
        }
    }
    let mut spelled: HashMap<&str, u32> = HashMap::default();
    for node in nodes.iter().filter(|node| matches!(node.kind, NodeKind::Method)) {
        *spelled.entry(node.name.as_str()).or_insert(0) += 1;
    }
    let mut named: HashMap<&str, u32> = HashMap::default();
    let mut recursive: HashMap<&str, u32> = HashMap::default();
    let mut handed: HashSet<&str> = HashSet::default();
    for call in calls {
        *named.entry(call.callee.as_str()).or_insert(0) += 1;
        if let Some(caller) = call.caller.as_deref()
            && position_of.get(caller).is_some_and(|at| nodes[*at].name == call.callee)
        {
            *recursive.entry(caller).or_insert(0) += 1;
        }
        for held in &call.passes {
            if let Some((_, path)) = held.split_once('=') {
                handed.insert(path.rsplit(['.', ':']).next().unwrap_or(path));
            }
        }
    }
    let handlers: HashSet<&str> = entry_points.iter().map(|entry| entry.handler.as_str()).collect();
    let served_anywhere = entry_points.iter().any(|entry| entry.kind != "test");

    let mut found = Vec::new();
    for (position, node) in nodes.iter().enumerate() {
        if !matches!(node.kind, NodeKind::Function | NodeKind::Method)
            || graph.served.get(position).copied().unwrap_or(true)
            || node.callback_of.is_some()
            || ANONYMOUS.contains(&node.name.split('#').next().unwrap_or(""))
            || handlers.contains(node.id.as_str())
            || files.get(node.file as usize).is_none_or(|path| crate::paths::is_test(path))
        {
            continue;
        }
        let reason = match (callers[position], graph.tested.get(position).copied().unwrap_or(false)) {
            (0, _) if node.modifiers.exported => "exported-unused",
            (0, _) => "no-inbound",
            (_, true) if served_anywhere => "only-from-tests",
            (_, false) if served_anywhere => "only-from-dead-callers",
            _ => continue,
        };
        let by_name = named.get(node.name.as_str()).copied().unwrap_or(0);
        let own = recursive.get(node.id.as_str()).copied().unwrap_or(0);
        let unlinked = by_name.saturating_sub(own).saturating_sub(callers[position]);
        let dispatched = matches!(node.kind, NodeKind::Method)
            && (spelled.get(node.name.as_str()).copied().unwrap_or(0) > 1
                || node.parent.as_deref().is_some_and(|owner| extending.contains(owner)));
        found.push(Dead {
            node: node.id.clone(),
            reason,
            callers: callers[position],
            open: match (unlinked > 0, handed.contains(node.name.as_str()), dispatched) {
                (true, _, _) => Some("unlinked-calls"),
                (_, true, _) => Some("passed-as-value"),
                (_, _, true) => Some("dynamic-dispatch"),
                _ => None,
            },
            unlinked,
        });
    }
    found
}
