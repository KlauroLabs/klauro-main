use tree_sitter::{Node, Tree};

use crate::model::*;

pub fn is_config(path: &str) -> bool {
    let basename = crate::paths::basename(path).to_ascii_lowercase();
    let stem = basename.split('.').next().unwrap_or(&basename);
    basename.contains(".config.") && CONFIGURED.contains(&stem)
}

static CONFIGURED: &[&str] = &["nuxt", "rollup", "rsbuild", "rspack", "svelte", "vite", "webpack"];

pub fn declared_aliases(tree: &Tree, source: &[u8], file: u32, path: &str) -> Vec<IndexNode> {
    let mut found = Vec::new();
    let mut pending = vec![tree.root_node()];
    while let Some(node) = pending.pop() {
        if node.kind() == "pair"
            && let Some(key) = node.child_by_field_name("key")
            && unquoted(text(source, key)) == "alias"
            && let Some(value) = node.child_by_field_name("value")
        {
            declare(source, value, file, path, &mut found);
            continue;
        }
        let mut cursor = node.walk();
        pending.extend(node.named_children(&mut cursor));
    }
    match found.is_empty() {
        true => Vec::new(),
        false => {
            let line = found[0].span.line;
            let mut nodes = vec![section(path, line, file)];
            nodes.extend(found);
            nodes
        }
    }
}

fn declare(source: &[u8], value: Node, file: u32, path: &str, found: &mut Vec<IndexNode>) {
    let mut cursor = value.walk();
    for member in value.named_children(&mut cursor) {
        match member.kind() {
            "pair" => {
                let (Some(key), Some(target)) = (
                    member.child_by_field_name("key"),
                    member.child_by_field_name("value"),
                ) else {
                    continue;
                };
                let (Some(name), Some(target)) = (
                    Some(unquoted(text(source, key))),
                    mapped_path(source, target),
                ) else {
                    continue;
                };
                found.push(mapping(path, name, &target, member, file));
            }
            "object" => {
                let mut pairs = member.walk();
                let mut name = None;
                let mut target = None;
                for pair in member.named_children(&mut pairs) {
                    let (Some(key), Some(value)) = (
                        pair.child_by_field_name("key"),
                        pair.child_by_field_name("value"),
                    ) else {
                        continue;
                    };
                    match unquoted(text(source, key)) {
                        "find" => name = Some(unquoted(text(source, value))),
                        "replacement" => target = mapped_path(source, value),
                        _ => {}
                    }
                }
                if let (Some(name), Some(target)) = (name, target) {
                    found.push(mapping(path, name, &target, member, file));
                }
            }
            _ => {}
        }
    }
}

fn mapped_path(source: &[u8], node: Node) -> Option<String> {
    if node.kind().contains("string") {
        return Some(unquoted(text(source, node)).to_string());
    }
    let mut last = None;
    let mut pending = vec![node];
    while let Some(found) = pending.pop() {
        if found.kind().contains("string") {
            let text = unquoted(text(source, found));
            if text.contains('/') || !text.contains(':') {
                last = Some(text.to_string());
            }
        }
        let mut cursor = found.walk();
        pending.extend(found.named_children(&mut cursor));
    }
    last
}

fn mapping(path: &str, name: &str, target: &str, node: Node, file: u32) -> IndexNode {
    let line = node.start_position().row as u32 + 1;
    declaration(
        format!("{path}:key:{name}:{line}"),
        name.to_string(),
        NodeKind::Property,
        file,
        line,
        Some(format!("{path}:section:alias")),
        Some(target.to_string()),
    )
}

fn section(path: &str, line: u32, file: u32) -> IndexNode {
    declaration(
        format!("{path}:section:alias"),
        "alias".to_string(),
        NodeKind::Class,
        file,
        line,
        Some(path.to_string()),
        None,
    )
}

fn declaration(
    id: String,
    name: String,
    kind: NodeKind,
    file: u32,
    line: u32,
    parent: Option<String>,
    annotation: Option<String>,
) -> IndexNode {
    IndexNode {
        id,
        name,
        kind,
        file,
        span: Span { line, column: 0, end_line: line, end_column: 0 },
        parent,
        signature: None,
        modifiers: Modifiers::default(),
        decorators: Vec::new(),
        type_annotation: annotation,
        documentation: None,
        project: None,
        callback_of: None,
        registration_label: None,
    }
}

fn text<'a>(source: &'a [u8], node: Node) -> &'a str {
    std::str::from_utf8(&source[node.byte_range()]).unwrap_or_default()
}

fn unquoted(value: &str) -> &str {
    value.trim().trim_matches(['"', '\'', '`'])
}
