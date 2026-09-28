use tree_sitter::{Node, Tree};

use crate::model::*;

pub fn is_config(path: &str) -> bool {
    let basename = crate::paths::basename(path).to_ascii_lowercase();
    let stem = basename.split('.').next().unwrap_or(&basename);
    basename.contains(".config.") && CONFIGURED.contains(&stem)
}

static CONFIGURED: &[&str] = &[
    "jest", "nuxt", "rollup", "rsbuild", "rspack", "svelte", "vite", "vitest", "webpack",
];

static MAPPINGS: &[&str] = &["alias", "moduleNameMapper"];

pub fn declared_aliases(tree: &Tree, source: &[u8], file: u32, path: &str) -> Vec<IndexNode> {
    let mut found = Vec::new();
    let mut pending = vec![tree.root_node()];
    while let Some(node) = pending.pop() {
        if node.kind() == "pair"
            && let Some(key) = node.child_by_field_name("key")
            && let Some(section) = MAPPINGS
                .iter()
                .find(|known| **known == unquoted(text(source, key)))
            && let Some(value) = node.child_by_field_name("value")
        {
            declare(source, value, file, path, section, &mut found);
            continue;
        }
        let mut cursor = node.walk();
        pending.extend(node.named_children(&mut cursor));
    }
    let mut sections: Vec<IndexNode> = Vec::new();
    for declared in &found {
        let Some(parent) = declared.parent.as_deref() else { continue };
        if sections.iter().any(|known| known.id == parent) {
            continue;
        }
        let name = parent.rsplit(':').next().unwrap_or_default().to_string();
        sections.push(section(path, &name, declared.span.line, file));
    }
    sections.extend(found);
    sections
}

fn declare(
    source: &[u8],
    value: Node,
    file: u32,
    path: &str,
    section: &str,
    found: &mut Vec<IndexNode>,
) {
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
                found.push(mapping(path, section, name, &target, member, file));
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
                    found.push(mapping(path, section, name, &target, member, file));
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

fn mapping(
    path: &str,
    section: &str,
    name: &str,
    target: &str,
    node: Node,
    file: u32,
) -> IndexNode {
    let line = node.start_position().row as u32 + 1;
    declaration(
        format!("{path}:key:{name}:{line}"),
        name.to_string(),
        NodeKind::Property,
        file,
        line,
        Some(format!("{path}:section:{section}")),
        Some(target.to_string()),
    )
}

fn section(path: &str, name: &str, line: u32, file: u32) -> IndexNode {
    declaration(
        format!("{path}:section:{name}"),
        name.to_string(),
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

static ENTRY_KEYS: &[&str] = &["entry", "entryPoints", "input"];

pub fn declared_builds(tree: &Tree, source: &[u8], file: u32) -> Vec<BundlerBuild> {
    let mut found = Vec::new();
    let mut pending = vec![tree.root_node()];
    while let Some(node) = pending.pop() {
        if node.kind() == "object"
            && let Some(build) = build_from_object(source, node, file)
        {
            found.push(build);
        }
        let mut cursor = node.walk();
        pending.extend(node.named_children(&mut cursor));
    }
    found
}

fn string_or_array(source: &[u8], value: Node) -> Vec<String> {
    if value.kind().contains("string") {
        return vec![unquoted(text(source, value)).to_string()];
    }
    if value.kind() == "array" {
        let mut cursor = value.walk();
        return value
            .named_children(&mut cursor)
            .filter(|element| element.kind().contains("string"))
            .map(|element| unquoted(text(source, element)).to_string())
            .collect();
    }
    Vec::new()
}

fn output_from_object(source: &[u8], object: Node) -> Option<(String, bool)> {
    let mut file_value = None;
    let mut dir_value = None;
    let mut path_value = None;
    let mut filename_value = None;
    let mut cursor = object.walk();
    for pair in object.named_children(&mut cursor) {
        if pair.kind() != "pair" {
            continue;
        }
        let (Some(key), Some(value)) = (pair.child_by_field_name("key"), pair.child_by_field_name("value")) else {
            continue;
        };
        if !value.kind().contains("string") {
            continue;
        }
        match unquoted(text(source, key)) {
            "file" => file_value = Some(unquoted(text(source, value)).to_string()),
            "dir" => dir_value = Some(unquoted(text(source, value)).to_string()),
            "path" => path_value = Some(unquoted(text(source, value)).to_string()),
            "filename" => filename_value = Some(unquoted(text(source, value)).to_string()),
            _ => {}
        }
    }
    if let Some(named) = file_value {
        return Some((named, false));
    }
    if let (Some(path), Some(filename)) = (&path_value, &filename_value) {
        return Some((format!("{path}/{filename}"), false));
    }
    if let Some(named) = dir_value.or(path_value) {
        return Some((named, true));
    }
    None
}

fn first_output_from_value(source: &[u8], value: Node) -> Option<(String, bool)> {
    if value.kind() == "object" {
        return output_from_object(source, value);
    }
    if value.kind() == "array" {
        let mut cursor = value.walk();
        for element in value.named_children(&mut cursor) {
            if element.kind() == "object"
                && let Some(resolved) = output_from_object(source, element)
            {
                return Some(resolved);
            }
        }
    }
    None
}

fn child_object<'t>(source: &[u8], object: Node<'t>, key: &str) -> Option<Node<'t>> {
    let mut cursor = object.walk();
    for pair in object.named_children(&mut cursor) {
        if pair.kind() != "pair" {
            continue;
        }
        let (Some(pair_key), Some(value)) = (pair.child_by_field_name("key"), pair.child_by_field_name("value")) else {
            continue;
        };
        if unquoted(text(source, pair_key)) == key && value.kind() == "object" {
            return Some(value);
        }
    }
    None
}

fn build_from_object(source: &[u8], object: Node, file: u32) -> Option<BundlerBuild> {
    let mut entries = Vec::new();
    let mut output: Option<(String, bool)> = None;
    let mut cursor = object.walk();
    for pair in object.named_children(&mut cursor) {
        if pair.kind() != "pair" {
            continue;
        }
        let (Some(key), Some(value)) = (pair.child_by_field_name("key"), pair.child_by_field_name("value")) else {
            continue;
        };
        let named = unquoted(text(source, key));
        if ENTRY_KEYS.contains(&named) {
            let held = string_or_array(source, value);
            if !held.is_empty() {
                entries = held;
            }
            continue;
        }
        match named {
            "outfile" if value.kind().contains("string") => {
                output = Some((unquoted(text(source, value)).to_string(), false));
            }
            "outdir" if value.kind().contains("string") => {
                output = Some((unquoted(text(source, value)).to_string(), true));
            }
            "output" => {
                output = first_output_from_value(source, value).or(output);
            }
            "build" if value.kind() == "object" => {
                if let Some(lib) = child_object(source, value, "lib") {
                    let mut lib_cursor = lib.walk();
                    for lib_pair in lib.named_children(&mut lib_cursor) {
                        if lib_pair.kind() != "pair" {
                            continue;
                        }
                        let (Some(lib_key), Some(lib_value)) =
                            (lib_pair.child_by_field_name("key"), lib_pair.child_by_field_name("value"))
                        else {
                            continue;
                        };
                        match unquoted(text(source, lib_key)) {
                            "entry" => {
                                let held = string_or_array(source, lib_value);
                                if !held.is_empty() {
                                    entries = held;
                                }
                            }
                            "fileName" if lib_value.kind().contains("string") => {
                                output = Some((unquoted(text(source, lib_value)).to_string(), false));
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let (output, output_is_dir) = output?;
    (!entries.is_empty()).then_some(BundlerBuild { file, entries, output, output_is_dir })
}
