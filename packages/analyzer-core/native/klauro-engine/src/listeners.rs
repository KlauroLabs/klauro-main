use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::entry_exit::EntryPoint;
use crate::model::{CallFact, EdgeKind, IndexNode, TypeReferenceFact};

static WORDS: &str = include_str!("../data/listen_words.tsv");

fn listens(registrar: &str) -> bool {
    let words = crate::effects::words_of(registrar);
    words.first().is_some_and(|first| WORDS.lines().any(|word| word == first))
}

pub fn inherited(nodes: &[IndexNode], calls: &[CallFact], references: &[TypeReferenceFact], entries: &[EntryPoint]) -> Vec<EntryPoint> {
    let by_id: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut members: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
    for node in nodes.iter().filter(|node| node.kind.is_unit()) {
        if let Some(parent) = node.parent.as_deref() {
            members.entry(parent).or_default().push(node);
        }
    }
    let class_of = |node: &IndexNode| -> Option<&IndexNode> {
        let mut at = node.parent.as_deref().and_then(|parent| by_id.get(parent).copied());
        while let Some(held) = at {
            if held.kind.is_type() {
                return Some(held);
            }
            at = held.parent.as_deref().and_then(|parent| by_id.get(parent).copied());
        }
        None
    };
    let mut extended_by: HashMap<&str, Vec<(&str, Option<&str>)>> = HashMap::default();
    for reference in references.iter().filter(|reference| matches!(reference.kind, EdgeKind::Extends | EdgeKind::Implements)) {
        let named = crate::names::leaf(&reference.name);
        let named = named.split('<').next().unwrap_or(named);
        extended_by.entry(named).or_default().push((reference.source.as_str(), reference.arguments.first().map(String::as_str)));
    }
    let handled: HashSet<&str> = entries.iter().map(|entry| entry.handler.as_str()).collect();
    let mut found: Vec<EntryPoint> = Vec::new();
    for callback in nodes.iter().filter(|node| node.callback_of.as_deref().is_some_and(listens)) {
        let Some(base) = class_of(callback) else { continue };
        let own: HashSet<&str> = members.get(base.id.as_str()).into_iter().flatten().map(|member| member.name.as_str()).collect();
        let reached: Vec<&str> = calls
            .iter()
            .filter(|call| call.caller.as_deref() == Some(callback.id.as_str()) && call.receiver.is_none())
            .map(|call| call.callee.as_str())
            .filter(|callee| own.contains(callee))
            .collect();
        if reached.is_empty() {
            continue;
        }
        let mut pending: Vec<(&str, Option<&str>)> = extended_by.get(base.name.as_str()).cloned().unwrap_or_default();
        let mut seen: HashSet<&str> = HashSet::default();
        while let Some((subclass, carried)) = pending.pop() {
            if !seen.insert(subclass) {
                continue;
            }
            let Some(held) = by_id.get(subclass).copied() else { continue };
            for (deeper, argument) in extended_by.get(held.name.as_str()).into_iter().flatten() {
                pending.push((*deeper, argument.or(carried)));
            }
            for member in members.get(subclass).into_iter().flatten().filter(|member| reached.contains(&member.name.as_str())) {
                if handled.contains(member.id.as_str()) || found.iter().any(|entry| entry.handler == member.id) {
                    continue;
                }
                found.push(EntryPoint {
                    id: format!("entry:{}:message", member.id),
                    kind: "message",
                    name: carried.map(|argument| crate::names::leaf(argument).to_string()).unwrap_or_else(|| held.name.clone()),
                    method: None,
                    path: None,
                    handler: member.id.clone(),
                    file: member.file,
                    line: member.span.line,
                    guards: Vec::new(),
                    registrar: callback.callback_of.clone().unwrap_or_default(),
                    unshipped: None,
                });
            }
        }
    }
    found
}
