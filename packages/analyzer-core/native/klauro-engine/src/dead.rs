use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::entry_exit::EntryPoint;
use crate::graph::GraphFacts;
use crate::mentions::Mentions;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention: Option<String>,
}

fn is_zero(count: &u32) -> bool {
    *count == 0
}

const LIFECYCLE: &[&str] = &[
    "main", "init", "new", "default", "drop", "fmt", "from", "into", "clone", "eq", "hash", "next", "deref",
    "constructor", "initialize", "setUp", "tearDown", "setup", "teardown", "render", "toString", "equals", "hashCode",
    "ngOnInit", "ngOnDestroy", "componentDidMount", "componentWillUnmount", "method_missing", "respond_to_missing?",
    "ServeHTTP", "String", "Error", "Close", "Read", "Write", "Less", "Len", "Swap", "run", "call", "perform",
];

fn is_lifecycle(name: &str) -> bool {
    LIFECYCLE.contains(&name) || (name.len() > 4 && name.starts_with("__") && name.ends_with("__"))
}

const ANONYMOUS: &[&str] = &["", "lambda", "closure", "anonymous", "<anonymous>", "default"];

pub fn derive(
    nodes: &[IndexNode],
    files: &[String],
    edges: &[IndexEdge],
    entry_points: &[EntryPoint],
    calls: &[CallFact],
    graph: &GraphFacts,
    scan: &dyn Fn(&HashSet<&str>) -> Mentions,
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
    let member = |node: &IndexNode| {
        matches!(node.kind, NodeKind::Method)
            || (node.span.column > 0
                && matches!(node.kind, NodeKind::Function)
                && files.get(node.file as usize).is_some_and(|path| path.ends_with(".rs")))
    };
    let mut spelled: HashMap<&str, u32> = HashMap::default();
    for node in nodes.iter().filter(|node| member(node)) {
        *spelled.entry(node.name.as_str()).or_insert(0) += 1;
    }
    let mut named: HashMap<&str, u32> = HashMap::default();
    let mut recursive: HashMap<&str, u32> = HashMap::default();
    let mut handed: HashSet<&str> = HashSet::default();
    for call in calls {
        *named.entry(call.callee.as_str()).or_insert(0) += 1;
        if matches!(call.receiver.as_deref(), None | Some("self" | "this" | "Self"))
            && let Some(caller) = call.caller.as_deref()
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

    let mut candidates: Vec<(usize, &'static str)> = Vec::new();
    for (position, node) in nodes.iter().enumerate() {
        if !matches!(node.kind, NodeKind::Function | NodeKind::Method)
            || graph.served.get(position).copied().unwrap_or(true)
            || node.callback_of.is_some()
            || ANONYMOUS.contains(&node.name.split('#').next().unwrap_or(""))
            || handlers.contains(node.id.as_str())
            || files.get(node.file as usize).is_none_or(|path| crate::paths::is_test(path))
            || !node.decorators.is_empty()
            || is_lifecycle(&node.name)
            || (member(node)
                && spelled.get(node.name.as_str()).copied().unwrap_or(0) > 1
                && node.parent.as_deref().is_some_and(|owner| extending.contains(owner)))
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
        candidates.push((position, reason));
    }

    let wanted: HashSet<&str> = candidates.iter().map(|(position, _)| nodes[*position].name.as_str()).collect();
    let mentions = scan(&wanted);
    let mut declared_in: HashMap<(&str, u32), u32> = HashMap::default();
    for node in nodes {
        if wanted.contains(node.name.as_str()) {
            *declared_in.entry((node.name.as_str(), node.file)).or_insert(0) += 1;
        }
    }
    let mut called_in: HashMap<(&str, u32), u32> = HashMap::default();
    for call in calls {
        if wanted.contains(call.callee.as_str()) {
            *called_in.entry((call.callee.as_str(), call.file)).or_insert(0) += 1;
        }
    }

    let path_of = |file: u32| files.get(file as usize).map(String::as_str).or_else(|| mentions.extra_path(file, files.len()));
    let mut found = Vec::new();
    for (position, reason) in candidates {
        let node = &nodes[position];
        let mut elsewhere: Option<(u32, u32)> = None;
        let mut in_tests: Option<(u32, u32)> = None;
        for (file, count, line) in mentions.of(node.name.as_str()) {
            let known = declared_in.get(&(node.name.as_str(), *file)).copied().unwrap_or(0)
                + called_in.get(&(node.name.as_str(), *file)).copied().unwrap_or(0);
            if *count <= known {
                continue;
            }
            let slot = if path_of(*file).is_some_and(crate::paths::is_test) { &mut in_tests } else { &mut elsewhere };
            if slot.is_none_or(|(held, _)| held > *file) {
                *slot = Some((*file, *line));
            }
        }
        let by_name = named.get(node.name.as_str()).copied().unwrap_or(0);
        let own = recursive.get(node.id.as_str()).copied().unwrap_or(0);
        let unlinked = by_name.saturating_sub(own).saturating_sub(callers[position]);
        let dispatched = member(node)
            && (spelled.get(node.name.as_str()).copied().unwrap_or(0) > 1
                || node.parent.as_deref().is_some_and(|owner| extending.contains(owner)));
        found.push(Dead {
            node: node.id.clone(),
            reason,
            callers: callers[position],
            open: if unlinked > 0 {
                Some("unlinked-calls")
            } else if handed.contains(node.name.as_str()) {
                Some("passed-as-value")
            } else if elsewhere.is_some() {
                Some("name-referenced")
            } else if in_tests.is_some() {
                Some("name-in-tests")
            } else if dispatched {
                Some("dynamic-dispatch")
            } else {
                None
            },
            unlinked,
            mention: elsewhere
                .or(in_tests)
                .and_then(|(file, line)| path_of(file).map(|path| format!("{path}:{line}"))),
        });
    }
    found
}
