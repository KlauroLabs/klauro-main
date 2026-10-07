use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::entry_exit::EntryPoint;
use crate::model::{EdgeKind, IndexEdge, IndexNode, NodeKind};

#[derive(Default)]
pub struct SetAside {
    spans: HashMap<u32, Vec<(u32, u32)>>,
}

impl SetAside {
    pub fn find(nodes: &[IndexNode], entry_points: &[EntryPoint], edges: &[IndexEdge]) -> SetAside {
        let mut testing: HashSet<&str> =
            entry_points
            .iter()
            .filter(|entry| entry.kind == "test" || crate::unshipped::is_set_aside(entry.unshipped.as_ref()))
            .map(|entry| entry.handler.as_str())
            .collect();
        let callable: HashSet<&str> = nodes
            .iter()
            .filter(|node| matches!(node.kind, NodeKind::Function | NodeKind::Method))
            .map(|node| node.id.as_str())
            .collect();
        let mut callers: HashMap<&str, Vec<&str>> = HashMap::default();
        for edge in edges.iter().filter(|edge| edge.kind == EdgeKind::Calls) {
            callers.entry(edge.target.as_str()).or_default().push(edge.source.as_str());
        }
        loop {
            let reached: Vec<&str> = callers
                .iter()
                .filter(|(callee, _)| callable.contains(*callee) && !testing.contains(*callee))
                .filter(|(_, from)| from.iter().all(|caller| testing.contains(caller)))
                .map(|(callee, _)| *callee)
                .collect();
            if reached.is_empty() {
                break;
            }
            testing.extend(reached);
        }
        let mut spans: HashMap<u32, Vec<(u32, u32)>> = HashMap::default();
        for node in nodes.iter().filter(|node| testing.contains(node.id.as_str())) {
            spans.entry(node.file).or_default().push((node.span.line, node.span.end_line.max(node.span.line)));
        }
        SetAside { spans }
    }

    pub fn holds(&self, file: u32, line: u32) -> bool {
        self.spans.get(&file).is_some_and(|spans| spans.iter().any(|(first, last)| (*first..=*last).contains(&line)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Span;

    fn function(id: &str, file: u32, line: u32, end_line: u32) -> IndexNode {
        IndexNode {
            id: id.to_string(),
            name: id.to_string(),
            kind: NodeKind::Function,
            file,
            span: Span { line, column: 0, end_line, end_column: 0 },
            parent: None,
            signature: None,
            modifiers: Default::default(),
            decorators: Vec::new(),
            type_annotation: None,
            documentation: None,
            project: None,
            callback_of: None,
            registration_label: None,
        }
    }

    fn case(handler: &str) -> EntryPoint {
        EntryPoint {
            id: format!("entry:{handler}:test"),
            kind: "test",
            name: handler.to_string(),
            method: None,
            path: None,
            handler: handler.to_string(),
            file: 0,
            line: 0,
            guards: Vec::new(),
            registrar: String::new(),
            unshipped: None,
        }
    }

    fn calls(source: &str, target: &str) -> IndexEdge {
        IndexEdge { source: source.to_string(), target: target.to_string(), kind: EdgeKind::Calls, via: Default::default() }
    }

    #[test]
    fn a_test_case_and_the_helpers_only_tests_call_are_set_aside() {
        let nodes = vec![function("serve", 0, 1, 20), function("case", 0, 30, 40), function("helper", 0, 42, 50), function("shared", 0, 52, 60)];
        let edges = vec![calls("case", "helper"), calls("case", "shared"), calls("serve", "shared")];
        let found = SetAside::find(&nodes, &[case("case")], &edges);
        assert!(found.holds(0, 35));
        assert!(found.holds(0, 45));
        assert!(!found.holds(0, 55));
        assert!(!found.holds(0, 10));
        assert!(!found.holds(1, 35));
    }
}
