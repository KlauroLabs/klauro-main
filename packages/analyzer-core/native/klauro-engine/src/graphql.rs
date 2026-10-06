use std::path::Path;

use rayon::prelude::*;
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::IndexedFile;
use crate::entry_exit::EntryPoint;
use crate::model::*;
use crate::names;
use crate::render_tree::property_text;

static TABLE: &str = include_str!("../data/graphql.tsv");

const LARGEST_SOURCE: u64 = 2_000_000;

const OPERATIONS: [(&str, &str); 3] = [("query", "Query"), ("mutation", "Mutation"), ("subscription", "Subscription")];

struct Table {
    evidence: Vec<&'static str>,
    operations: HashMap<&'static str, &'static str>,
    fields: HashSet<&'static str>,
    class_operations: HashMap<&'static str, &'static str>,
    class_extends: HashSet<&'static str>,
    object_bases: HashSet<&'static str>,
    mutation_members: Vec<&'static str>,
    binders: HashMap<&'static str, Option<&'static str>>,
}

fn table() -> Table {
    let mut held = Table {
        evidence: Vec::new(),
        operations: HashMap::default(),
        fields: HashSet::default(),
        class_operations: HashMap::default(),
        class_extends: HashSet::default(),
        object_bases: HashSet::default(),
        mutation_members: Vec::new(),
        binders: HashMap::default(),
    };
    for row in TABLE.lines().filter(|row| !row.trim().is_empty()) {
        let cells: Vec<&'static str> = row.split('\t').collect();
        match cells.as_slice() {
            ["evidence", word] => held.evidence.push(word),
            ["operation", name, root] => {
                held.operations.insert(name, root);
            }
            ["field", name] => {
                held.fields.insert(name);
            }
            ["class_operation", name, root] => {
                held.class_operations.insert(name, root);
            }
            ["class_extends", name] => {
                held.class_extends.insert(name);
            }
            ["object_base", name] => {
                held.object_bases.insert(name);
            }
            ["mutation_member", name] => held.mutation_members.push(name),
            ["binder", name, root] => {
                held.binders.insert(name, Some(root));
            }
            ["binder", name] => {
                held.binders.insert(name, None);
            }
            _ => {}
        }
    }
    held
}

pub fn spelled(name: &str) -> String {
    name.chars().filter(|held| *held != '_').flat_map(char::to_lowercase).collect()
}

fn spellings(name: &str) -> Vec<String> {
    let mut found = vec![spelled(name)];
    let bare = name.strip_suffix("Async").unwrap_or(name);
    let bare = match bare.strip_prefix("Get") {
        Some(rest) if rest.starts_with(char::is_uppercase) => rest,
        _ => bare,
    };
    let bare = spelled(bare);
    if !found.contains(&bare) {
        found.push(bare);
    }
    found
}

struct SdlType {
    name: String,
    interface: bool,
    file: u32,
    line: u32,
    fields: Vec<(String, u32)>,
}

#[derive(Default)]
struct Sdl {
    types: Vec<SdlType>,
    roots: Vec<(&'static str, String)>,
}

fn is_source(language: Option<&str>) -> bool {
    !matches!(
        language,
        None | Some("json" | "toml" | "ini" | "yaml" | "css" | "html" | "markdown" | "xml" | "configuration" | "shell" | "dockerfile")
    )
}

fn matching_brace(text: &str, open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut quoted = false;
    for (at, letter) in text[open..].char_indices() {
        match letter {
            '"' => quoted = !quoted,
            '{' if !quoted => depth += 1,
            '}' if !quoted => {
                depth -= 1;
                if depth == 0 {
                    return Some(open + at);
                }
            }
            _ => {}
        }
    }
    None
}

fn declared_blocks(text: &str) -> Vec<(u32, String)> {
    static HEAD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let head = HEAD.get_or_init(|| {
        regex::Regex::new(
            r"(?m)^[ \t]*(?:(?:extend[ \t]+)?(?:type|interface)[ \t]+\w+(?:[ \t]+implements[ \t]+[\w &,]+)?|schema)[ \t]*(?:@\w+(?:\([^)\n]*\))?[ \t]*)*\{",
        )
        .expect("a valid pattern")
    });
    let mut blocks = Vec::new();
    let mut from = 0;
    while let Some(found) = head.find_at(text, from) {
        let Some(close) = matching_brace(text, found.end() - 1) else { break };
        let line = text[..found.start()].matches('\n').count() as u32 + 1;
        blocks.push((line, text[found.start()..=close].to_string()));
        from = close + 1;
    }
    blocks
}

fn read_sdl(text: &str, file: u32, whole: bool, into: &mut Sdl) {
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&tree_sitter_graphql::LANGUAGE.into()).is_err() {
        return;
    }
    let pieces: Vec<(u32, String)> = if whole { vec![(1, text.to_string())] } else { declared_blocks(text) };
    for (line, piece) in pieces {
        let Some(tree) = parser.parse(&piece, None) else { continue };
        if !whole && tree.root_node().has_error() {
            continue;
        }
        let mut pending = vec![tree.root_node()];
        while let Some(node) = pending.pop() {
            if node.kind() == "root_operation_type_definition" {
                let mut cursor = node.walk();
                let mut parts = node.named_children(&mut cursor);
                let operation = parts.find(|child| child.kind() == "operation_type").and_then(|child| piece.get(child.byte_range()));
                let named = parts.find(|child| child.kind() == "named_type").and_then(|child| piece.get(child.byte_range()));
                if let (Some(operation), Some(named)) = (operation, named)
                    && let Some((word, _)) = OPERATIONS.iter().find(|(word, _)| *word == operation.trim())
                {
                    into.roots.push((*word, named.trim().to_string()));
                }
                continue;
            }
            let interface = matches!(node.kind(), "interface_type_definition" | "interface_type_extension");
            if interface || matches!(node.kind(), "object_type_definition" | "object_type_extension") {
                let mut cursor = node.walk();
                let named = node.named_children(&mut cursor).find(|child| child.kind() == "name");
                let Some(named) = named.and_then(|child| piece.get(child.byte_range())) else { continue };
                let mut fields = Vec::new();
                let mut inside = vec![node];
                while let Some(here) = inside.pop() {
                    let mut walk = here.walk();
                    for child in here.named_children(&mut walk) {
                        if child.kind() == "field_definition" {
                            let mut within = child.walk();
                            let label = child.named_children(&mut within).find(|held| held.kind() == "name");
                            if let Some(label) = label.and_then(|held| piece.get(held.byte_range())) {
                                fields.push((label.to_string(), line + child.start_position().row as u32));
                            }
                        } else if child.kind() == "fields_definition" {
                            inside.push(child);
                        }
                    }
                }
                into.types.push(SdlType {
                    name: named.to_string(),
                    interface,
                    file,
                    line: line + node.start_position().row as u32,
                    fields,
                });
                continue;
            }
            let mut cursor = node.walk();
            pending.extend(node.named_children(&mut cursor));
        }
    }
}

fn read_text(root: &Path, path: &str) -> Option<String> {
    let absolute = crate::paths::kept_inside(root, Path::new(path))?;
    if std::fs::metadata(&absolute).ok()?.len() > LARGEST_SOURCE {
        return None;
    }
    std::fs::read_to_string(absolute).ok()
}

fn mentions_a_schema(text: &str) -> bool {
    ["type Query", "type Mutation", "type Subscription", "extend type", "schema {"].iter().any(|marker| text.contains(marker))
}

fn declared_schema(root: &Path, files: &[IndexedFile]) -> Sdl {
    let found: Vec<Sdl> = files
        .par_iter()
        .enumerate()
        .filter(|(_, file)| file.kind == crate::discovery::FileKind::Source && is_source(file.language))
        .filter_map(|(at, file)| {
            let text = read_text(root, &file.path)?;
            let whole = file.language == Some("graphql");
            if !whole && !mentions_a_schema(&text) {
                return None;
            }
            let mut held = Sdl::default();
            read_sdl(&text, at as u32, whole, &mut held);
            (!held.types.is_empty() || !held.roots.is_empty()).then_some(held)
        })
        .collect();
    let mut merged = Sdl::default();
    for held in found {
        merged.types.extend(held.types);
        merged.roots.extend(held.roots);
    }
    merged.types.sort_by(|left, right| left.file.cmp(&right.file).then(left.line.cmp(&right.line)));
    merged
}

#[derive(Clone)]
pub struct SchemaField {
    pub type_name: String,
    pub name: String,
    pub id: String,
}

pub enum Handler {
    Node(String),
    Named(u32, String),
}

pub struct Mapped {
    pub type_name: String,
    pub field: String,
    pub file: u32,
    pub line: u32,
    pub handler: Handler,
}

pub struct Lifted {
    pub fields: Vec<SchemaField>,
    pub roots: HashMap<&'static str, String>,
    pub mapped: Vec<Mapped>,
}

fn node_of(
    id: String,
    name: &str,
    kind: NodeKind,
    file: u32,
    line: u32,
    parent: Option<String>,
) -> IndexNode {
    IndexNode {
        id,
        name: name.to_string(),
        kind,
        file,
        span: Span { line, column: 0, end_line: line, end_column: 0 },
        parent,
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

fn schema_nodes(sdl: &Sdl, files: &[IndexedFile], nodes: &mut Vec<IndexNode>, edges: &mut Vec<IndexEdge>) -> Vec<SchemaField> {
    let by_id: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut declared: HashMap<(u32, &str, &str), &str> = HashMap::default();
    let mut types: HashMap<(u32, &str), &str> = HashMap::default();
    for node in nodes.iter() {
        let Some(parent) = node.parent.as_deref().and_then(|parent| by_id.get(parent)) else { continue };
        if parent.kind.is_type() && parent.file == node.file {
            declared.insert((node.file, parent.name.as_str(), node.name.as_str()), node.id.as_str());
        }
        if node.kind.is_type() {
            types.insert((node.file, node.name.as_str()), node.id.as_str());
        }
    }
    let mut found = Vec::new();
    let mut made: Vec<IndexNode> = Vec::new();
    let mut linked: Vec<IndexEdge> = Vec::new();
    let mut announced: HashSet<(u32, String)> = HashSet::default();
    for held in &sdl.types {
        let path = &files[held.file as usize].path;
        let type_id = match types.get(&(held.file, held.name.as_str())) {
            Some(existing) => (*existing).to_string(),
            None => {
                let id = format!("{path}:graphql:{}", held.name);
                if announced.insert((held.file, held.name.clone())) {
                    let kind = if held.interface { NodeKind::Interface } else { NodeKind::Class };
                    made.push(node_of(id.clone(), &held.name, kind, held.file, held.line, Some(path.clone())));
                }
                id
            }
        };
        for (label, line) in &held.fields {
            let id = match declared.get(&(held.file, held.name.as_str(), label.as_str())) {
                Some(existing) => (*existing).to_string(),
                None => {
                    let id = format!("{path}:graphql:{}.{label}", held.name);
                    if announced.insert((held.file, format!("{}.{label}", held.name))) {
                        made.push(node_of(id.clone(), label, NodeKind::Property, held.file, *line, Some(type_id.clone())));
                        linked.push(IndexEdge { source: type_id.clone(), target: id.clone(), kind: EdgeKind::HasField, via: Via::Structure });
                    }
                    id
                }
            };
            found.push(SchemaField { type_name: held.name.clone(), name: label.clone(), id });
        }
    }
    nodes.extend(made);
    edges.extend(linked);
    found
}

fn unquoted(text: &str) -> &str {
    text.trim().trim_matches(['"', '\'', '`'])
}

struct Entry {
    type_name: String,
    key: String,
    line: u32,
    start: (u32, u32),
    end: (u32, u32),
    value: Shape,
}

enum Shape {
    Inline,
    Named(String),
}

fn key_of(node: tree_sitter::Node, source: &[u8]) -> Option<String> {
    let text = node.utf8_text(source).ok()?;
    match node.kind() {
        "property_identifier" | "identifier" | "shorthand_property_identifier" | "number" => Some(text.to_string()),
        "string" => Some(unquoted(text).to_string()),
        _ => None,
    }
}

fn is_function(kind: &str) -> bool {
    matches!(kind, "arrow_function" | "function_expression" | "function" | "generator_function")
}

fn shape_of<'t>(value: tree_sitter::Node<'t>, source: &[u8]) -> Option<(Shape, tree_sitter::Node<'t>)> {
    match value.kind() {
        "identifier" => Some((Shape::Named(value.utf8_text(source).ok()?.to_string()), value)),
        "object" => {
            let mut cursor = value.walk();
            let configured = value.named_children(&mut cursor).find_map(|pair| {
                let key = key_of(pair.child_by_field_name("key")?, source)?;
                (pair.kind() == "pair" && matches!(key.as_str(), "resolve" | "subscribe")).then(|| pair.child_by_field_name("value"))?
            })?;
            shape_of(configured, source)
        }
        "spread_element" | "undefined" | "null" => None,
        kind if is_function(kind) || kind == "method_definition" => Some((Shape::Inline, value)),
        _ => Some((Shape::Inline, value)),
    }
}

fn maps_in(
    source: &[u8],
    tree: &tree_sitter::Tree,
    roots: &HashSet<&str>,
    types: &HashMap<&str, HashSet<String>>,
) -> Vec<Entry> {
    let mut found = Vec::new();
    let mut pending = vec![tree.root_node()];
    while let Some(node) = pending.pop() {
        let mut cursor = node.walk();
        pending.extend(node.named_children(&mut cursor));
        if node.kind() != "object" {
            continue;
        }
        let mut cursor = node.walk();
        let mut accepted: Vec<(String, tree_sitter::Node)> = Vec::new();
        for pair in node.named_children(&mut cursor).filter(|pair| pair.kind() == "pair") {
            let (Some(key), Some(value)) = (pair.child_by_field_name("key"), pair.child_by_field_name("value")) else { continue };
            let Some(type_name) = key_of(key, source) else { continue };
            if value.kind() != "object" {
                continue;
            }
            let known = types.get(type_name.as_str()).is_some_and(|fields| {
                let mut walk = value.walk();
                let mut members = value.named_children(&mut walk).filter_map(|member| {
                    let label = match member.kind() {
                        "pair" => member.child_by_field_name("key"),
                        _ => member.child_by_field_name("name").or(Some(member)),
                    }?;
                    key_of(label, source)
                });
                members.any(|label| fields.contains(&spelled(&label)))
            });
            if roots.contains(type_name.as_str()) || known {
                accepted.push((type_name, value));
            }
        }
        for (type_name, object) in accepted {
            let mut walk = object.walk();
            for member in object.named_children(&mut walk) {
                let (label, value) = match member.kind() {
                    "pair" => (member.child_by_field_name("key"), member.child_by_field_name("value")),
                    "method_definition" => (member.child_by_field_name("name"), Some(member)),
                    "shorthand_property_identifier" => (Some(member), Some(member)),
                    _ => continue,
                };
                let (Some(label), Some(value)) = (label, value) else { continue };
                let Some(key) = key_of(label, source) else { continue };
                let Some((shape, at)) = shape_of(value, source) else { continue };
                let shape = match (member.kind(), shape) {
                    ("shorthand_property_identifier", _) => Shape::Named(key.clone()),
                    (_, shape) => shape,
                };
                found.push(Entry {
                    type_name: type_name.clone(),
                    key,
                    line: member.start_position().row as u32 + 1,
                    start: (at.start_position().row as u32 + 1, at.start_position().column as u32),
                    end: (at.end_position().row as u32 + 1, at.end_position().column as u32),
                    value: shape,
                });
            }
        }
    }
    found
}

fn within(inner: (u32, u32), start: (u32, u32), end: (u32, u32)) -> bool {
    inner >= start && inner <= end
}

pub fn lift(
    root: &Path,
    files: &[IndexedFile],
    nodes: &mut Vec<IndexNode>,
    edges: &mut Vec<IndexEdge>,
    calls: &mut [CallFact],
) -> Lifted {
    let sdl = declared_schema(root, files);
    let fields = schema_nodes(&sdl, files, nodes, edges);
    let mut roots: HashMap<&'static str, String> = OPERATIONS.iter().map(|(word, name)| (*word, name.to_string())).collect();
    for (word, named) in &sdl.roots {
        roots.insert(*word, named.clone());
    }
    let root_names: HashSet<&str> = roots.values().map(String::as_str).collect();
    let mut by_type: HashMap<&str, HashSet<String>> = HashMap::default();
    for held in &fields {
        by_type.entry(held.type_name.as_str()).or_default().insert(spelled(&held.name));
    }

    let candidates: Vec<(u32, Vec<Entry>)> = files
        .par_iter()
        .enumerate()
        .filter(|(_, file)| file.kind == crate::discovery::FileKind::Source && file.language.is_some_and(crate::typescript::reads))
        .filter_map(|(at, file)| {
            let mut source = crate::paths::read_bytes_inside(root, &file.path)?;
            if source.len() as u64 > LARGEST_SOURCE || !mentions_a_resolver_map(&source, &root_names) {
                return None;
            }
            if file.language.is_some_and(crate::typescript::wraps_script) {
                crate::source_rewrite::component_script(&mut source);
            }
            let mut parser = crate::typescript::parser_for(&file.path).or_else(|| crate::typescript::parser_for_language(file.language?))?;
            let tree = parser.parse(&source, None)?;
            let found = maps_in(&source, &tree, &root_names, &by_type);
            (!found.is_empty()).then_some((at as u32, found))
        })
        .collect();

    let spans: HashMap<u32, Vec<usize>> = {
        let mut held: HashMap<u32, Vec<usize>> = HashMap::default();
        for (at, node) in nodes.iter().enumerate() {
            held.entry(node.file).or_default().push(at);
        }
        held
    };
    let mapped_files: HashSet<u32> = candidates.iter().map(|(file, _)| *file).collect();
    let mut in_file: HashMap<u32, Vec<usize>> = HashMap::default();
    for (at, call) in calls.iter().enumerate() {
        if mapped_files.contains(&call.file) {
            in_file.entry(call.file).or_default().push(at);
        }
    }
    let mut made = Vec::new();
    let mut mapped = Vec::new();
    for (file, entries) in candidates {
        let path = &files[file as usize].path;
        for entry in entries {
            let handler = match entry.value {
                Shape::Named(name) => Handler::Named(file, name),
                Shape::Inline => {
                    let container = spans
                        .get(&file)
                        .into_iter()
                        .flatten()
                        .map(|at| &nodes[*at])
                        .filter(|node| {
                            node.kind != NodeKind::Module
                                && within((entry.start.0, entry.start.1), (node.span.line, node.span.column), (node.span.end_line, node.span.end_column))
                        })
                        .min_by_key(|node| node.span.end_line - node.span.line)
                        .map(|node| node.id.clone());
                    let id = format!("{path}:resolver:{}.{}", entry.type_name, entry.key);
                    let mut held = node_of(id.clone(), &entry.key, NodeKind::Function, file, entry.start.0, container.clone().or_else(|| Some(path.clone())));
                    held.span = Span { line: entry.start.0, column: entry.start.1, end_line: entry.end.0, end_column: entry.end.1 };
                    held.callback_of = Some(format!("graphql:{}", entry.type_name));
                    held.registration_label = Some(format!("{}.{}", entry.type_name, entry.key));
                    if let Some(container) = container {
                        for at in in_file.get(&file).into_iter().flatten().copied() {
                            let call = &mut calls[at];
                            if call.caller.as_deref() == Some(container.as_str()) && within((call.line, call.column), entry.start, entry.end) {
                                call.caller = Some(id.clone());
                            }
                        }
                    }
                    made.push(held);
                    Handler::Node(id)
                }
            };
            mapped.push(Mapped { type_name: entry.type_name, field: entry.key, file, line: entry.line, handler });
        }
    }
    nodes.extend(made);
    Lifted { fields, roots, mapped }
}

fn mentions_a_resolver_map(source: &[u8], roots: &HashSet<&str>) -> bool {
    let text = String::from_utf8_lossy(source);
    text.to_ascii_lowercase().contains("resolver") || roots.iter().any(|name| text.contains(*name))
}

pub struct Context<'a> {
    pub files: &'a [String],
    pub languages: &'a [&'a str],
    pub nodes: &'a [IndexNode],
    pub type_references: &'a [TypeReferenceFact],
    pub calls: &'a [CallFact],
    pub imports: &'a [ImportFact],
    pub locals: &'a [LocalBinding],
    pub local: &'a HashMap<(u32, String), String>,
    pub imported: &'a HashMap<(u32, String), String>,
    pub root: &'a Path,
}

#[derive(Default)]
pub struct Wiring {
    pub nodes: Vec<IndexNode>,
    pub edges: Vec<IndexEdge>,
    pub entry_points: Vec<EntryPoint>,
}

struct Resolver {
    types: Vec<String>,
    root: Option<&'static str>,
    keys: Vec<String>,
    field: String,
    handler: String,
    file: u32,
    line: u32,
    registrar: String,
}

fn type_written(text: &str) -> Option<String> {
    if let Some(found) = property_text(text, "typeName") {
        return Some(found);
    }
    let text = text.trim();
    if text.starts_with(['\'', '"']) {
        return Some(unquoted(text).to_string());
    }
    let stripped = text.trim_start_matches("typeof").trim().trim_start_matches('(').trim_end_matches(')');
    let last = stripped.rsplit(|held: char| !(held.is_alphanumeric() || held == '_')).find(|word| !word.is_empty())?;
    last.starts_with(char::is_uppercase).then(|| last.to_string())
}

fn overridden(decorator: &Decorator) -> Option<String> {
    decorator.arguments.iter().find_map(|argument| {
        if argument.literal {
            return Some(unquoted(&argument.value).to_string());
        }
        property_text(&argument.value, "name").or_else(|| property_text(&argument.value, "field"))
    })
}

fn leaf_of(name: &str) -> String {
    let bare = name.split('<').next().unwrap_or(name);
    names::leaf(bare).to_ascii_lowercase()
}

pub fn wire(lifted: &Lifted, context: &Context) -> Wiring {
    let table = table();
    let by_id: HashMap<&str, &IndexNode> = context.nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let evidence: HashSet<u32> = context
        .imports
        .iter()
        .filter(|held| {
            let specifier = held.specifier.to_ascii_lowercase();
            table.evidence.iter().any(|word| specifier.contains(word))
        })
        .map(|held| held.file)
        .collect();
    let mut bases: HashMap<&str, Vec<&str>> = HashMap::default();
    let mut descendants: HashMap<String, Vec<&IndexNode>> = HashMap::default();
    for reference in context.type_references.iter().filter(|held| matches!(held.kind, EdgeKind::Extends | EdgeKind::Implements)) {
        let Some(class) = by_id.get(reference.source.as_str()) else { continue };
        bases.entry(reference.source.as_str()).or_default().push(reference.name.as_str());
        descendants.entry(names::leaf(&reference.name).to_string()).or_default().push(class);
    }
    let children: HashMap<&str, Vec<&IndexNode>> = {
        let mut held: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
        for node in context.nodes {
            if let Some(parent) = node.parent.as_deref() {
                held.entry(parent).or_default().push(node);
            }
        }
        held
    };
    let effective = |class: &IndexNode| -> Vec<String> {
        let mut found = vec![class.name.clone()];
        let mut pending = vec![class.name.clone()];
        let mut seen: HashSet<String> = HashSet::default();
        while let Some(named) = pending.pop() {
            if !seen.insert(named.clone()) {
                continue;
            }
            for below in descendants.get(&named).into_iter().flatten() {
                if !found.contains(&below.name) {
                    found.push(below.name.clone());
                }
                pending.push(below.name.clone());
            }
        }
        found
    };
    let root_of = |type_name: &str| -> Option<&'static str> {
        OPERATIONS.iter().map(|(word, _)| *word).find(|word| lifted.roots.get(word).is_some_and(|named| named == type_name))
    };

    let mut found: Vec<Resolver> = Vec::new();

    for node in context.nodes.iter().filter(|node| node.kind.is_unit() && evidence.contains(&node.file)) {
        let owner = node.parent.as_deref().and_then(|parent| by_id.get(parent)).filter(|owner| owner.kind.is_type());
        for decorator in &node.decorators {
            let leaf = leaf_of(&decorator.name);
            let qualified = decorator.name.contains('.');
            let strawberry = decorator.name.to_ascii_lowercase().contains("strawberry");
            let declared_field = overridden(decorator);
            let (types, root, registrar): (Vec<String>, Option<&'static str>, &str) = if strawberry
                && matches!(leaf.as_str(), "field" | "mutation" | "subscription")
            {
                let Some(owner) = owner else { continue };
                (vec![owner.name.clone()], root_of(&owner.name), decorator.name.as_str())
            } else if let Some(word) = table.operations.get(leaf.as_str()) {
                let word = OPERATIONS.iter().map(|(word, _)| *word).find(|held| held.eq_ignore_ascii_case(word)).unwrap_or("query");
                match lifted.roots.get(word) {
                    Some(named) => (vec![named.clone()], Some(word), decorator.name.as_str()),
                    None => continue,
                }
            } else if table.fields.contains(leaf.as_str()) {
                let from_class = owner.and_then(|owner| {
                    owner.decorators.iter().find(|held| leaf_of(&held.name) == "resolver").and_then(|held| held.arguments.first()).and_then(|argument| type_written(&argument.value))
                });
                let spoken = decorator.arguments.iter().find_map(|argument| type_written(&argument.value).filter(|_| argument.value.contains("typeName")));
                let held: Vec<String> = spoken.or(from_class).into_iter().collect();
                (held, None, decorator.name.as_str())
            } else if qualified && leaf == "field" {
                let variable = names::root(&decorator.name);
                let constructed = context
                    .locals
                    .iter()
                    .find(|held| held.file == node.file && held.name == variable)
                    .and_then(|held| held.constructed.as_deref().or(held.from_call.as_deref()))
                    .map(|written| names::leaf(written).to_ascii_lowercase());
                match constructed.as_deref().and_then(|written| table.binders.get(written)) {
                    Some(Some(root_name)) => {
                        let word = OPERATIONS.iter().map(|(word, _)| *word).find(|held| held.eq_ignore_ascii_case(root_name)).unwrap_or("query");
                        match lifted.roots.get(word) {
                            Some(named) => (vec![named.clone()], Some(word), decorator.name.as_str()),
                            None => continue,
                        }
                    }
                    Some(None) => (Vec::new(), None, decorator.name.as_str()),
                    None => continue,
                }
            } else {
                continue;
            };
            let field = declared_field.unwrap_or_else(|| node.name.clone());
            found.push(Resolver {
                keys: spellings(&field),
                types,
                root,
                field,
                handler: node.id.clone(),
                file: node.file,
                line: node.span.line,
                registrar: registrar.to_string(),
            });
        }
    }

    let object_classes = graphene_classes(context, &table, &bases);
    for class in context.nodes.iter().filter(|node| node.kind.is_type() && object_classes.contains(node.id.as_str())) {
        let mine = children.get(class.id.as_str()).map(Vec::as_slice).unwrap_or(&[]);
        for method in mine.iter().filter(|held| held.kind.is_unit()) {
            let Some(field) = method.name.strip_prefix("resolve_").filter(|rest| !rest.is_empty()) else { continue };
            let types = effective(class);
            found.push(Resolver {
                keys: spellings(field),
                root: types.iter().find_map(|held| root_of(held)),
                types,
                field: field.to_string(),
                handler: method.id.clone(),
                file: method.file,
                line: method.span.line,
                registrar: "resolve_".to_string(),
            });
        }
    }
    let mutations: HashMap<&str, &str> = context
        .nodes
        .iter()
        .filter(|node| node.kind.is_type() && object_classes.contains(node.id.as_str()))
        .map(|class| {
            let mine = children.get(class.id.as_str()).map(Vec::as_slice).unwrap_or(&[]);
            let member = table.mutation_members.iter().find_map(|wanted| mine.iter().find(|held| held.kind.is_unit() && held.name == *wanted));
            (class.name.as_str(), member.map_or(class.id.as_str(), |held| held.id.as_str()))
        })
        .collect();
    let mut text_of: HashMap<u32, Option<String>> = HashMap::default();
    for call in context.calls.iter().filter(|call| call.callee == "Field" && evidence.contains(&call.file)) {
        let Some(handler) = call.receiver.as_deref().map(names::leaf).and_then(|named| mutations.get(named)) else { continue };
        let text = text_of.entry(call.file).or_insert_with(|| read_text(context.root, &context.files[call.file as usize]));
        let Some(line) = text.as_deref().and_then(|held| held.lines().nth(call.line as usize - 1)) else { continue };
        let Some((label, _)) = line.split_once('=') else { continue };
        let label = label.trim();
        if label.is_empty() || !label.chars().all(|held| held.is_alphanumeric() || held == '_') {
            continue;
        }
        let Some(owner) = context
            .nodes
            .iter()
            .filter(|node| node.file == call.file && node.kind.is_type() && node.span.line <= call.line && node.span.end_line >= call.line)
            .min_by_key(|node| node.span.end_line - node.span.line)
        else {
            continue;
        };
        let types = effective(owner);
        found.push(Resolver {
            keys: spellings(label),
            root: types.iter().find_map(|held| root_of(held)),
            types,
            field: label.to_string(),
            handler: (*handler).to_string(),
            file: call.file,
            line: call.line,
            registrar: "Field".to_string(),
        });
    }

    for class in context.nodes.iter().filter(|node| node.kind.is_type() && context.languages.get(node.file as usize) == Some(&"go")) {
        let Some(stem) = class.name.strip_suffix("Resolver").filter(|stem| !stem.is_empty()) else { continue };
        let types: Vec<String> = lifted
            .fields
            .iter()
            .map(|held| held.type_name.clone())
            .filter(|named| named.eq_ignore_ascii_case(stem))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if types.is_empty() {
            continue;
        }
        for method in children.get(class.id.as_str()).into_iter().flatten().filter(|held| held.kind.is_unit()) {
            found.push(Resolver {
                keys: spellings(&method.name),
                root: types.iter().find_map(|held| root_of(held)),
                types: types.clone(),
                field: method.name.clone(),
                handler: method.id.clone(),
                file: method.file,
                line: method.span.line,
                registrar: class.name.clone(),
            });
        }
    }

    for class in context.nodes.iter().filter(|node| node.kind.is_type() && context.languages.get(node.file as usize) == Some(&"csharp")) {
        let mut types: Vec<String> = Vec::new();
        for decorator in &class.decorators {
            let leaf = leaf_of(&decorator.name);
            if let Some(word) = table.class_operations.get(leaf.as_str()) {
                types.push(lifted.roots.get(word.to_ascii_lowercase().as_str()).cloned().unwrap_or_else(|| word.to_string()));
            } else if table.class_extends.contains(leaf.as_str()) {
                let written = decorator.arguments.first().map(|argument| argument.value.as_str()).unwrap_or("");
                let from_generic = decorator.name.split_once('<').map(|(_, rest)| rest.trim_end_matches('>').to_string());
                let spoken = OPERATIONS
                    .iter()
                    .find(|(word, _)| written.to_ascii_lowercase().contains(word))
                    .map(|(word, _)| lifted.roots.get(word).cloned().unwrap_or_default())
                    .or_else(|| type_written(written))
                    .or(from_generic);
                types.extend(spoken);
            }
        }
        if types.is_empty() {
            if !evidence.contains(&class.file) || !OPERATIONS.iter().any(|(_, name)| *name == class.name) {
                continue;
            }
            types.push(class.name.clone());
        }
        for method in children.get(class.id.as_str()).into_iter().flatten().filter(|held| held.kind == NodeKind::Method && !held.modifiers.private_member) {
            found.push(Resolver {
                keys: spellings(&method.name),
                root: types.iter().find_map(|held| root_of(held)),
                types: types.clone(),
                field: method.name.clone(),
                handler: method.id.clone(),
                file: method.file,
                line: method.span.line,
                registrar: class.name.clone(),
            });
        }
    }

    let ruby = ruby_objects(context, &bases);
    let mut lines_of: HashMap<u32, Option<String>> = HashMap::default();
    for class in context.nodes.iter().filter(|node| node.kind.is_type() && ruby.contains(node.id.as_str())) {
        let mine = children.get(class.id.as_str()).map(Vec::as_slice).unwrap_or(&[]);
        if mine.iter().any(|held| held.kind.is_unit() && matches!(held.name.as_str(), "resolve" | "call")) {
            continue;
        }
        let stem = class.name.strip_suffix("Type").filter(|stem| !stem.is_empty()).unwrap_or(&class.name);
        for call in context.calls.iter().filter(|call| call.callee == "field" && call.caller.as_deref() == Some(class.id.as_str())) {
            let Some(label) = call.literals.first().map(|held| unquoted(held.trim_start_matches(':')).to_string()).filter(|held| !held.is_empty()) else {
                continue;
            };
            let text = lines_of.entry(call.file).or_insert_with(|| read_text(context.root, &context.files[call.file as usize]));
            let line = text.as_deref().and_then(|held| held.lines().nth(call.line as usize - 1)).unwrap_or("");
            let mut handler: Option<String> = None;
            for keyword in ["resolver", "mutation"] {
                if let Some(constant) = keyword_constant(line, keyword)
                    && let Some(target) = context.nodes.iter().find(|node| node.kind.is_type() && node.name == names::leaf(&constant))
                {
                    let own = children.get(target.id.as_str()).and_then(|held| held.iter().find(|member| member.kind.is_unit() && matches!(member.name.as_str(), "resolve" | "call")));
                    handler = Some(own.map(|member| member.id.clone()).unwrap_or_else(|| target.id.clone()));
                }
            }
            if handler.is_none() {
                let spoken = call.literals.iter().find_map(|held| held.strip_prefix("method=")).map(|held| unquoted(held.trim_start_matches(':')).to_string()).unwrap_or_else(|| label.clone());
                handler = mine.iter().find(|member| member.kind.is_unit() && member.name == spoken).map(|member| member.id.clone());
            }
            let Some(handler) = handler else { continue };
            found.push(Resolver {
                keys: spellings(&label),
                types: vec![stem.to_string()],
                root: root_of(stem),
                field: label,
                handler,
                file: call.file,
                line: call.line,
                registrar: "field".to_string(),
            });
        }
    }

    for held in &lifted.mapped {
        let handler = match &held.handler {
            Handler::Node(id) => Some(id.clone()),
            Handler::Named(file, name) => context
                .local
                .get(&(*file, name.clone()))
                .or_else(|| context.imported.get(&(*file, name.clone())))
                .cloned(),
        };
        let Some(handler) = handler else { continue };
        found.push(Resolver {
            keys: spellings(&held.field),
            types: vec![held.type_name.clone()],
            root: root_of(&held.type_name),
            field: held.field.clone(),
            handler,
            file: held.file,
            line: held.line,
            registrar: "resolvers".to_string(),
        });
    }

    emit(lifted, context, found, &by_id)
}

fn keyword_constant(line: &str, keyword: &str) -> Option<String> {
    let at = line.find(&format!("{keyword}:"))?;
    let rest = line[at + keyword.len() + 1..].trim_start();
    let constant: String = rest.chars().take_while(|held| held.is_alphanumeric() || matches!(held, '_' | ':')).collect();
    (!constant.is_empty() && constant.starts_with(char::is_uppercase)).then_some(constant)
}

fn ruby_objects<'a>(context: &'a Context, bases: &HashMap<&str, Vec<&str>>) -> HashSet<&'a str> {
    let is_ruby = |node: &&IndexNode| node.kind.is_type() && context.languages.get(node.file as usize) == Some(&"ruby");
    let mut held: HashSet<&str> = HashSet::default();
    let mut named: HashSet<&str> = HashSet::default();
    loop {
        let mut grew = false;
        for node in context.nodes.iter().filter(is_ruby) {
            if held.contains(node.id.as_str()) {
                continue;
            }
            let derived = bases.get(node.id.as_str()).is_some_and(|written| {
                written.iter().any(|base| base.contains("GraphQL::Schema") || named.contains(names::leaf(base)))
            });
            if derived {
                held.insert(node.id.as_str());
                named.insert(node.name.as_str());
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    held
}

fn graphene_classes<'a>(context: &'a Context, table: &Table, bases: &HashMap<&str, Vec<&str>>) -> HashSet<&'a str> {
    let mut held: HashSet<&str> = HashSet::default();
    let mut named: HashSet<&str> = HashSet::default();
    for node in context.nodes.iter().filter(|node| node.kind.is_type()) {
        let direct = bases.get(node.id.as_str()).is_some_and(|written| {
            written.iter().any(|base| table.object_bases.contains(names::leaf(base).to_ascii_lowercase().as_str()))
        });
        if direct && context.languages.get(node.file as usize) == Some(&"python") {
            held.insert(node.id.as_str());
            named.insert(node.name.as_str());
        }
    }
    loop {
        let mut grew = false;
        for node in context.nodes.iter().filter(|node| node.kind.is_type() && context.languages.get(node.file as usize) == Some(&"python")) {
            if held.contains(node.id.as_str()) {
                continue;
            }
            let derived = bases.get(node.id.as_str()).is_some_and(|written| written.iter().any(|base| named.contains(names::leaf(base))));
            if derived {
                held.insert(node.id.as_str());
                named.insert(node.name.as_str());
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    held
}

fn emit(lifted: &Lifted, context: &Context, found: Vec<Resolver>, by_id: &HashMap<&str, &IndexNode>) -> Wiring {
    let mut wiring = Wiring::default();
    let mut by_name: HashMap<&str, Vec<&SchemaField>> = HashMap::default();
    for field in &lifted.fields {
        by_name.entry(field.type_name.as_str()).or_default().push(field);
    }
    let mut every: HashMap<String, Vec<&SchemaField>> = HashMap::default();
    for field in &lifted.fields {
        every.entry(spelled(&field.name)).or_default().push(field);
    }
    let mut seen: HashSet<(String, String)> = HashSet::default();
    let mut made: HashSet<String> = HashSet::default();
    let mut served: HashSet<(String, String)> = HashSet::default();
    for resolver in found {
        let mut chosen: Option<(&SchemaField, String)> = None;
        for type_name in &resolver.types {
            let hit = by_name
                .get(type_name.as_str())
                .into_iter()
                .flatten()
                .find(|field| resolver.keys.iter().any(|key| *key == spelled(&field.name)));
            if let Some(hit) = hit {
                chosen = Some((hit, type_name.clone()));
                break;
            }
        }
        if chosen.is_none() && resolver.types.is_empty() {
            let candidates: Vec<&&SchemaField> =
                resolver.keys.iter().filter_map(|key| every.get(key)).flatten().collect();
            let roots: Vec<&&SchemaField> =
                candidates.iter().filter(|field| OPERATIONS.iter().any(|(word, _)| lifted.roots.get(word) == Some(&field.type_name))).copied().collect();
            let pick = match (roots.as_slice(), candidates.as_slice()) {
                ([only], _) => Some(**only),
                ([], [only]) => Some(**only),
                _ => None,
            };
            chosen = pick.map(|field| (field, field.type_name.clone()));
        }
        let Some(handler) = by_id.get(resolver.handler.as_str()).copied() else { continue };
        let (schema_id, type_name, spoken) = match chosen {
            Some((field, type_name)) => (field.id.clone(), type_name, field.name.clone()),
            None => {
                let Some(type_name) = resolver.types.first().cloned() else { continue };
                let path = &context.files[resolver.file as usize];
                let id = format!("{path}:graphql:{type_name}.{}", resolver.field);
                if made.insert(id.clone()) && !by_id.contains_key(id.as_str()) {
                    wiring.nodes.push(IndexNode {
                        id: id.clone(),
                        name: resolver.field.clone(),
                        kind: NodeKind::Property,
                        file: resolver.file,
                        span: Span { line: resolver.line, column: 0, end_line: resolver.line, end_column: 0 },
                        parent: None,
                        signature: None,
                        modifiers: Modifiers::default(),
                        decorators: Vec::new(),
                        type_annotation: None,
                        documentation: None,
                        project: None,
                        callback_of: None,
                        registration_label: None,
                    });
                }
                (id, type_name, resolver.field.clone())
            }
        };
        if !seen.insert((schema_id.clone(), resolver.handler.clone())) {
            continue;
        }
        wiring.edges.push(IndexEdge { source: schema_id, target: resolver.handler.clone(), kind: EdgeKind::ResolvedBy, via: Via::Structure });
        let operation = OPERATIONS
            .iter()
            .map(|(word, _)| *word)
            .find(|word| lifted.roots.get(word) == Some(&type_name))
            .or(resolver.root);
        if let Some(operation) = operation
            && served.insert((resolver.handler.clone(), format!("{type_name}.{spoken}")))
        {
            wiring.entry_points.push(EntryPoint {
                id: format!("entry:{}:graphql:{type_name}.{spoken}", resolver.handler),
                kind: "graphql",
                name: format!("{type_name}.{spoken}"),
                method: Some(operation.to_string()),
                path: None,
                handler: resolver.handler.clone(),
                file: handler.file,
                line: handler.span.line,
                guards: Vec::new(),
                registrar: resolver.registrar,
                unshipped: None,
            });
        }
    }
    wiring
}
