use std::collections::HashMap;

use crate::externals;
use crate::model::*;

pub struct Resolution {
    pub edges: Vec<IndexEdge>,
    pub external_nodes: Vec<IndexNode>,
    pub package_calls: u32,
    pub runtime_calls: u32,
    pub unresolved_calls: u32,
    pub no_caller: u32,
    pub unresolved_names: HashMap<String, u32>,
}

struct Symbols {
    exported: HashMap<(u32, String), String>,
    local: HashMap<(u32, String), String>,
    members: HashMap<(String, String), String>,
    types: HashMap<String, Vec<String>>,
    by_id: HashMap<String, usize>,
}

fn strip_extension(specifier: &str) -> &str {
    for extension in [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"] {
        if let Some(stripped) = specifier.strip_suffix(extension) {
            return stripped;
        }
    }
    specifier
}

fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn directory_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(at) => &path[..at],
        None => "",
    }
}

pub struct Index<'a> {
    pub files: &'a [String],
    pub nodes: &'a [IndexNode],
    pub imports: &'a [ImportFact],
    pub calls: &'a [CallFact],
    pub type_references: &'a [TypeReferenceFact],
}

fn build_symbols(index: &Index) -> Symbols {
    let mut symbols = Symbols {
        exported: HashMap::new(),
        local: HashMap::new(),
        members: HashMap::new(),
        types: HashMap::new(),
        by_id: HashMap::new(),
    };
    for (position, node) in index.nodes.iter().enumerate() {
        symbols.by_id.insert(node.id.clone(), position);
        match node.kind {
            NodeKind::Module => continue,
            NodeKind::Method
            | NodeKind::Constructor
            | NodeKind::Getter
            | NodeKind::Setter
            | NodeKind::Property => {
                if let Some(parent) = &node.parent {
                    symbols
                        .members
                        .entry((parent.clone(), node.name.clone()))
                        .or_insert_with(|| node.id.clone());
                }
                continue;
            }
            _ => {}
        }
        symbols
            .local
            .entry((node.file, node.name.clone()))
            .or_insert_with(|| node.id.clone());
        if node.modifiers.exported {
            symbols
                .exported
                .entry((node.file, node.name.clone()))
                .or_insert_with(|| node.id.clone());
        }
        if matches!(
            node.kind,
            NodeKind::Class | NodeKind::Interface | NodeKind::TypeAlias | NodeKind::Enum
        ) {
            symbols
                .types
                .entry(node.name.clone())
                .or_default()
                .push(node.id.clone());
        }
    }
    symbols
}

fn file_index(files: &HashMap<String, u32>, from: &str, specifier: &str) -> Option<u32> {
    if !specifier.starts_with('.') {
        return None;
    }
    let joined = normalize(&format!("{}/{}", directory_of(from), specifier));
    let base = strip_extension(&joined);
    for candidate in [
        format!("{base}.ts"),
        format!("{base}.tsx"),
        format!("{base}.js"),
        format!("{base}.jsx"),
        format!("{base}.mts"),
        format!("{base}.cts"),
        format!("{base}.mjs"),
        format!("{base}.cjs"),
        format!("{base}/index.ts"),
        format!("{base}/index.tsx"),
        format!("{base}/index.js"),
    ] {
        if let Some(found) = files.get(&candidate) {
            return Some(*found);
        }
    }
    None
}

pub fn resolve(index: &Index) -> Resolution {
    let symbols = build_symbols(index);
    let by_path: HashMap<String, u32> = index
        .files
        .iter()
        .enumerate()
        .map(|(position, path)| (path.clone(), position as u32))
        .collect();

    let mut edges = Vec::new();
    let mut imported: HashMap<(u32, String), String> = HashMap::new();
    let mut modules: HashMap<(u32, String), String> = HashMap::new();
    let runtime = externals::sorted_runtime_globals();

    for fact in index.imports {
        let from = &index.files[fact.file as usize];
        let Some(target_file) = file_index(&by_path, from, &fact.specifier) else {
            for name in &fact.names {
                modules.insert((fact.file, name.local.clone()), fact.specifier.clone());
            }
            continue;
        };
        edges.push(IndexEdge {
            source: from.clone(),
            target: index.files[target_file as usize].clone(),
            kind: EdgeKind::Imports,
        });
        for name in &fact.names {
            let wanted = name.imported.clone().unwrap_or_else(|| name.local.clone());
            if let Some(target) = symbols
                .exported
                .get(&(target_file, wanted.clone()))
                .or_else(|| symbols.local.get(&(target_file, wanted)))
            {
                imported.insert((fact.file, name.local.clone()), target.clone());
            }
        }
    }

    let mut unresolved_calls = 0;
    let mut package_calls = 0;
    let mut runtime_calls = 0;
    let mut no_caller = 0;
    let mut external_nodes: HashMap<String, IndexNode> = HashMap::new();
    let mut unresolved_names: HashMap<String, u32> = HashMap::new();

    for fact in index.type_references {
        let root = root_binding(&fact.name);
        let target = imported
            .get(&(fact.file, root.to_string()))
            .cloned()
            .or_else(|| symbols.local.get(&(fact.file, root.to_string())).cloned())
            .or_else(|| {
                symbols
                    .types
                    .get(root)
                    .filter(|found| found.len() == 1)
                    .map(|found| found[0].clone())
            })
            .or_else(|| {
                modules.get(&(fact.file, root.to_string())).map(|specifier| {
                    let id = external_id("package", specifier, &fact.name);
                    external_nodes
                        .entry(id.clone())
                        .or_insert_with(|| external_node(&id, &fact.name, specifier));
                    id
                })
            })
            .or_else(|| {
                runtime.binary_search(&root).ok().map(|_| {
                    let id = external_id("runtime", root, &fact.name);
                    external_nodes
                        .entry(id.clone())
                        .or_insert_with(|| external_node(&id, &fact.name, root));
                    id
                })
            });
        match target {
            Some(target) => edges.push(IndexEdge {
                source: fact.source.clone(),
                target,
                kind: fact.kind,
            }),
            None => {
                *unresolved_names
                    .entry(format!("<type> {}", fact.name))
                    .or_insert(0) += 1;
            }
        }
    }

    for fact in index.calls {
        let Some(caller) = &fact.caller else {
            no_caller += 1;
            continue;
        };
        let target = match fact.receiver.as_deref() {
            Some(receiver) if receiver == "this" || receiver.starts_with("this.") => {
                owning_type(&symbols, index.nodes, caller)
                    .and_then(|owner| symbols.members.get(&(owner, fact.callee.clone())).cloned())
            }
            Some(receiver) => imported
                .get(&(fact.file, receiver.to_string()))
                .and_then(|module| symbols.members.get(&(module.clone(), fact.callee.clone())))
                .cloned()
                .or_else(|| {
                    symbols
                        .local
                        .get(&(fact.file, receiver.to_string()))
                        .and_then(|owner| symbols.members.get(&(owner.clone(), fact.callee.clone())))
                        .cloned()
                }),
            None => imported
                .get(&(fact.file, fact.callee.clone()))
                .cloned()
                .or_else(|| symbols.local.get(&(fact.file, fact.callee.clone())).cloned()),
        };
        match target {
            Some(target) => edges.push(IndexEdge {
                source: caller.clone(),
                target,
                kind: if fact.constructs {
                    EdgeKind::Instantiates
                } else {
                    EdgeKind::Calls
                },
            }),
            None => {
                let root = fact
                    .receiver
                    .as_deref()
                    .map(root_binding)
                    .unwrap_or(fact.callee.as_str());
                let member = match fact.receiver.as_deref() {
                    Some(receiver) => member_path(receiver, &fact.callee),
                    None => fact.callee.clone(),
                };
                if let Some(specifier) = modules.get(&(fact.file, root.to_string())) {
                    let id = external_id("package", specifier, &member);
                    external_nodes
                        .entry(id.clone())
                        .or_insert_with(|| external_node(&id, &member, specifier));
                    edges.push(IndexEdge {
                        source: caller.clone(),
                        target: id,
                        kind: if fact.constructs { EdgeKind::Instantiates } else { EdgeKind::Calls },
                    });
                    package_calls += 1;
                } else if runtime.binary_search(&root).is_ok() {
                    let id = external_id("runtime", root, &member);
                    external_nodes
                        .entry(id.clone())
                        .or_insert_with(|| external_node(&id, &member, root));
                    edges.push(IndexEdge {
                        source: caller.clone(),
                        target: id,
                        kind: if fact.constructs { EdgeKind::Instantiates } else { EdgeKind::Calls },
                    });
                    runtime_calls += 1;
                } else {
                    let label = match fact.receiver.as_deref() {
                        Some(receiver) => format!("{receiver}.{}", fact.callee),
                        None => fact.callee.clone(),
                    };
                    *unresolved_names.entry(label).or_insert(0) += 1;
                    unresolved_calls += 1;
                }
            }
        }
    }

    let mut external_nodes: Vec<IndexNode> = external_nodes.into_values().collect();
    external_nodes.sort_by(|left, right| left.id.cmp(&right.id));

    Resolution {
        edges,
        external_nodes,
        package_calls,
        runtime_calls,
        unresolved_calls,
        no_caller,
        unresolved_names,
    }
}

fn root_binding(receiver: &str) -> &str {
    let end = receiver.find(['.', '[', '(']).unwrap_or(receiver.len());
    &receiver[..end]
}

fn member_path(receiver: &str, callee: &str) -> String {
    let root = root_binding(receiver);
    if root == receiver {
        format!("{receiver}.{callee}")
    } else {
        format!("{root}.{callee}")
    }
}

fn external_id(space: &str, origin: &str, member: &str) -> String {
    format!("{space}:{origin}:{member}")
}

fn external_node(id: &str, name: &str, origin: &str) -> IndexNode {
    IndexNode {
        id: id.to_string(),
        name: name.to_string(),
        kind: NodeKind::External,
        file: u32::MAX,
        span: Span { line: 0, column: 0, end_line: 0, end_column: 0 },
        parent: None,
        signature: None,
        modifiers: Modifiers::default(),
        decorators: Vec::new(),
        type_annotation: Some(origin.to_string()),
        documentation: None,
        callback_of: None,
        registration_label: None,
    }
}

fn owning_type(symbols: &Symbols, nodes: &[IndexNode], caller: &str) -> Option<String> {
    let mut current = caller.to_string();
    for _ in 0..16 {
        let position = *symbols.by_id.get(&current)?;
        let node = &nodes[position];
        if matches!(node.kind, NodeKind::Class | NodeKind::Interface) {
            return Some(node.id.clone());
        }
        current = node.parent.clone()?;
    }
    None
}
