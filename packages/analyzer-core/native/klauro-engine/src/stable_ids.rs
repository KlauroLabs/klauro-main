use rustc_hash::FxHashMap;

use crate::model::{FileFacts, NodeKind};

fn positioned<'a>(id: &'a str, line: u32, column: u32) -> Option<&'a str> {
    id.strip_suffix(&format!(":{line}:{}", column + 1))
        .or_else(|| id.strip_suffix(&format!(":{line}:{column}")))
}

fn unnumbered(base: &str) -> String {
    if !base.contains(":callback:") {
        return base.to_string();
    }
    match base.rsplit_once('#') {
        Some((named, line)) if !line.is_empty() && line.chars().all(|held| held.is_ascii_digit()) => named.to_string(),
        _ => base.to_string(),
    }
}

pub fn names(id: &str, kind: &str, name: &str) -> bool {
    let wanted = format!(":{kind}:{name}");
    id.match_indices(&wanted).any(|(at, _)| {
        matches!(id[at + wanted.len()..].chars().next(), None | Some('@' | '#' | ':'))
    })
}

pub fn stabilize(facts: &mut FileFacts) {
    let bases: Vec<Option<String>> = facts
        .nodes
        .iter()
        .map(|node| positioned(&node.id, node.span.line, node.span.column).map(unnumbered))
        .collect();
    if bases.iter().all(Option::is_none) {
        return;
    }
    let name_of: FxHashMap<&str, &str> = facts
        .nodes
        .iter()
        .filter(|node| node.kind != NodeKind::Module)
        .map(|node| (node.id.as_str(), node.name.as_str()))
        .collect();
    let mut seen: FxHashMap<&str, usize> = FxHashMap::default();
    for base in bases.iter().flatten() {
        *seen.entry(base.as_str()).or_default() += 1;
    }
    let owned: Vec<Option<String>> = facts
        .nodes
        .iter()
        .zip(&bases)
        .map(|(node, base)| {
            let base = base.as_ref()?;
            if seen[base.as_str()] == 1 {
                return Some(base.clone());
            }
            let owner = node.parent.as_deref().and_then(|parent| name_of.get(parent)).copied().unwrap_or("");
            Some(format!("{base}@{owner}"))
        })
        .collect();
    let mut owned_seen: FxHashMap<&str, usize> = FxHashMap::default();
    for held in owned.iter().flatten() {
        *owned_seen.entry(held.as_str()).or_default() += 1;
    }
    let mut ordinal: FxHashMap<&str, usize> = FxHashMap::default();
    let declared: rustc_hash::FxHashSet<&str> = facts.nodes.iter().map(|node| node.id.as_str()).collect();
    let mut renamed: FxHashMap<String, String> = FxHashMap::default();
    for (node, held) in facts.nodes.iter().zip(&owned) {
        let Some(held) = held else { continue };
        let stable = match owned_seen[held.as_str()] {
            1 => held.clone(),
            _ => {
                let at = ordinal.entry(held.as_str()).or_default();
                *at += 1;
                format!("{held}#{at}")
            }
        };
        if stable != node.id && !declared.contains(stable.as_str()) {
            renamed.insert(node.id.clone(), stable);
        }
    }
    if renamed.is_empty() {
        return;
    }
    let swap = |held: &mut String| {
        if let Some(stable) = renamed.get(held.as_str()) {
            held.clone_from(stable);
        }
    };
    let swap_some = |held: &mut Option<String>| {
        if let Some(inner) = held.as_mut()
            && let Some(stable) = renamed.get(inner.as_str())
        {
            inner.clone_from(stable);
        }
    };
    for node in facts.nodes.iter_mut() {
        swap(&mut node.id);
        swap_some(&mut node.parent);
        swap_some(&mut node.callback_of);
    }
    for edge in facts.edges.iter_mut() {
        swap(&mut edge.source);
        swap(&mut edge.target);
    }
    for call in facts.calls.iter_mut() {
        swap_some(&mut call.caller);
    }
    for reference in facts.type_references.iter_mut() {
        swap(&mut reference.source);
    }
    for local in facts.locals.iter_mut() {
        swap(&mut local.unit);
    }
    for entry in facts.metrics.iter_mut() {
        swap(&mut entry.unit);
    }
    for registration in facts.registrations.iter_mut() {
        swap(&mut registration.handler);
    }
    for kept in facts.kept.iter_mut() {
        swap(&mut kept.unit);
    }
    for setting in facts.settings.iter_mut() {
        swap_some(&mut setting.unit);
    }
    for table in facts.tables.iter_mut() {
        swap_some(&mut table.declared_by);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{IndexEdge, IndexNode, Modifiers, Span, EdgeKind, Via};

    fn node(id: &str, name: &str, line: u32, parent: Option<&str>) -> IndexNode {
        IndexNode {
            id: id.to_string(),
            name: name.to_string(),
            kind: NodeKind::Method,
            file: 0,
            span: Span { line, column: 4, end_line: line, end_column: 5 },
            parent: parent.map(str::to_string),
            signature: None,
            modifiers: Modifiers::default(),
            decorators: Vec::new(),
            type_annotation: None,
            documentation: None,
            project: None,
            callback_of: None,
            registration_label: None,
        }
    }

    #[test]
    fn an_id_names_its_kind_and_name_whatever_follows_it() {
        assert!(names("Cargo.toml:section:package", "section", "package"));
        assert!(names("Cargo.toml:section:package@root", "section", "package"));
        assert!(names("Cargo.toml:section:package:3:1", "section", "package"));
        assert!(!names("Cargo.toml:section:packages", "section", "package"));
    }

    #[test]
    fn an_id_no_longer_moves_when_lines_are_added_above_it() {
        let mut facts = FileFacts::default();
        facts.nodes.push(node("a.ts:type:Shop:1:5", "Shop", 1, None));
        facts.nodes.push(node("a.ts:type:Cart:9:5", "Cart", 9, None));
        facts.nodes.push(node("a.ts:method:render:3:5", "render", 3, Some("a.ts:type:Shop:1:5")));
        facts.nodes.push(node("a.ts:method:render:11:5", "render", 11, Some("a.ts:type:Cart:9:5")));
        facts.nodes.push(node("a.ts:callback:test#20:20:5", "test#20", 20, None));
        facts.nodes.push(node("a.ts:callback:test#25:25:5", "test#25", 25, None));
        facts.edges.push(IndexEdge {
            via: Via::Structure,
            source: "a.ts:type:Shop:1:5".to_string(),
            target: "a.ts:method:render:3:5".to_string(),
            kind: EdgeKind::HasMethod,
        });
        stabilize(&mut facts);
        let ids: Vec<&str> = facts.nodes.iter().map(|node| node.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "a.ts:type:Shop",
                "a.ts:type:Cart",
                "a.ts:method:render@Shop",
                "a.ts:method:render@Cart",
                "a.ts:callback:test@#1",
                "a.ts:callback:test@#2",
            ]
        );
        assert_eq!(facts.nodes[2].parent.as_deref(), Some("a.ts:type:Shop"));
        assert_eq!(facts.edges[0].source, "a.ts:type:Shop");
        assert_eq!(facts.edges[0].target, "a.ts:method:render@Shop");
    }
}
