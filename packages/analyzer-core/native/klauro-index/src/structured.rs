use tree_sitter::{Language, Node, Parser, Tree};

use crate::model::*;

pub struct StructuredSpec {
    pub pair_kinds: &'static [&'static str],
    pub key_field: &'static str,
    pub value_field: &'static str,
    pub section_kinds: &'static [&'static str],
    pub table_kinds: &'static [&'static str],
    pub key_leaf_kinds: &'static [&'static str],
}

static YAML: StructuredSpec = StructuredSpec {
    pair_kinds: &["block_mapping_pair", "flow_pair"],
    key_field: "key",
    value_field: "value",
    section_kinds: &["block_mapping", "block_sequence", "flow_mapping", "flow_sequence"],
    table_kinds: &[],
    key_leaf_kinds: &["string_scalar", "double_quote_scalar", "single_quote_scalar"],
};

static JSON: StructuredSpec = StructuredSpec {
    pair_kinds: &["pair"],
    key_field: "key",
    value_field: "value",
    section_kinds: &["object", "array"],
    table_kinds: &[],
    key_leaf_kinds: &["string_content"],
};

static TOML: StructuredSpec = StructuredSpec {
    pair_kinds: &["pair"],
    key_field: "",
    value_field: "",
    section_kinds: &["table", "table_array_element", "inline_table", "array"],
    table_kinds: &["table", "table_array_element"],
    key_leaf_kinds: &["bare_key", "quoted_key", "dotted_key"],
};

pub fn language_for(id: &str) -> Option<(Language, &'static StructuredSpec)> {
    match id {
        "configuration" | "yaml" => Some((tree_sitter_yaml::LANGUAGE.into(), &YAML)),
        "json" => Some((tree_sitter_json::LANGUAGE.into(), &JSON)),
        "toml" => Some((tree_sitter_toml_ng::LANGUAGE.into(), &TOML)),
        _ => None,
    }
}

pub struct Extractor<'a> {
    source: &'a [u8],
    file: u32,
    module_id: String,
    spec: &'static StructuredSpec,
    facts: FileFacts,
}

fn span_of(node: Node) -> Span {
    Span {
        line: node.start_position().row as u32 + 1,
        column: node.start_position().column as u32,
        end_line: node.end_position().row as u32 + 1,
        end_column: node.end_position().column as u32,
    }
}

impl<'a> Extractor<'a> {
    pub fn new(source: &'a [u8], file: u32, path: &str, spec: &'static StructuredSpec) -> Self {
        Extractor {
            source,
            file,
            module_id: path.to_string(),
            spec,
            facts: FileFacts::default(),
        }
    }

    fn text(&self, node: Node) -> &'a str {
        std::str::from_utf8(&self.source[node.byte_range()]).unwrap_or("")
    }

    fn key_name(&self, node: Node) -> Option<String> {
        if self.spec.key_leaf_kinds.contains(&node.kind()) {
            return Some(self.text(node).trim().to_string());
        }
        let mut cursor = node.walk();
        let mut descend = true;
        loop {
            let current = cursor.node();
            if self.spec.key_leaf_kinds.contains(&current.kind()) {
                return Some(self.text(current).trim().to_string());
            }
            if descend && cursor.goto_first_child() {
                continue;
            }
            descend = true;
            while !cursor.goto_next_sibling() {
                if !cursor.goto_parent() {
                    return None;
                }
            }
        }
    }

    pub fn run(mut self, tree: &Tree, path: &str, line_count: u32) -> FileFacts {
        let root = tree.root_node();
        self.facts.lines = line_count;
        self.facts.parse_errors = crate::typescript::count_errors(root);
        self.facts.nodes.push(IndexNode {
            id: self.module_id.clone(),
            name: path.to_string(),
            kind: NodeKind::Module,
            file: self.file,
            span: span_of(root),
            parent: None,
            signature: None,
            modifiers: Modifiers::default(),
            decorators: Vec::new(),
            type_annotation: None,
            documentation: None,
            callback_of: None,
            registration_label: None,
        });
        let module = self.module_id.clone();
        self.walk(root, &module, 0);
        self.facts
    }

    fn walk(&mut self, node: Node, owner: &str, depth: u16) {
        if depth > 12 {
            return;
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if self.spec.table_kinds.contains(&child.kind()) {
                let Some(name) = self.key_name(child) else { continue };
                let id = self.declare(&name, child, owner, NodeKind::Class, EdgeKind::Contains);
                self.walk(child, &id, depth + 1);
                continue;
            }
            if self.spec.pair_kinds.contains(&child.kind()) {
                self.pair(child, owner, depth);
                continue;
            }
            self.walk(child, owner, depth + 1);
        }
    }

    fn pair(&mut self, node: Node, owner: &str, depth: u16) {
        let key = if self.spec.key_field.is_empty() {
            node.named_child(0)
        } else {
            node.child_by_field_name(self.spec.key_field)
        };
        let Some(key) = key else { return };
        let Some(name) = self.key_name(key) else { return };
        let value = if self.spec.value_field.is_empty() {
            node.named_child(1)
        } else {
            node.child_by_field_name(self.spec.value_field)
        };
        let section = value.is_some_and(|value| self.is_section(value));
        if section {
            let id = self.declare(&name, node, owner, NodeKind::Class, EdgeKind::Contains);
            if let Some(value) = value {
                self.walk(value, &id, depth + 1);
            }
            return;
        }
        let id = self.declare(&name, node, owner, NodeKind::Property, EdgeKind::HasField);
        if let Some(value) = value {
            let literal = self.text(value).trim();
            if !literal.is_empty() && literal.len() <= 200 {
                if let Some(found) = self.facts.nodes.iter_mut().find(|found| found.id == id) {
                    found.type_annotation = Some(literal.to_string());
                }
            }
        }
    }

    fn is_section(&self, value: Node) -> bool {
        if self.spec.section_kinds.contains(&value.kind()) {
            return true;
        }
        let mut cursor = value.walk();
        value
            .named_children(&mut cursor)
            .any(|child| self.spec.section_kinds.contains(&child.kind()))
    }

    fn declare(
        &mut self,
        name: &str,
        node: Node,
        owner: &str,
        kind: NodeKind,
        edge: EdgeKind,
    ) -> String {
        let id = format!(
            "{}:{}:{name}:{}",
            self.module_id,
            if kind == NodeKind::Class { "section" } else { "key" },
            node.start_position().row + 1
        );
        self.facts.nodes.push(IndexNode {
            id: id.clone(),
            name: name.to_string(),
            kind,
            file: self.file,
            span: span_of(node),
            parent: Some(owner.to_string()),
            signature: None,
            modifiers: Modifiers::default(),
            decorators: Vec::new(),
            type_annotation: None,
            documentation: None,
            callback_of: None,
            registration_label: None,
        });
        self.facts.edges.push(IndexEdge {
            source: owner.to_string(),
            target: id.clone(),
            kind: edge,
        });
        id
    }
}

pub fn parser_for(id: &str) -> Option<(Parser, &'static StructuredSpec)> {
    let (language, spec) = language_for(id)?;
    let mut parser = Parser::new();
    parser.set_language(&language).ok()?;
    Some((parser, spec))
}
