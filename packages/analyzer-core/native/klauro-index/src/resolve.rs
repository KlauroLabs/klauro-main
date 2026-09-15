use std::collections::HashMap;

use crate::externals;
use crate::model::*;

pub struct Resolution {
    pub edges: Vec<IndexEdge>,
    pub dynamic_calls: u32,
    pub indirect_calls: u32,
    pub modules: HashMap<(u32, String), String>,
    pub local: HashMap<(u32, String), String>,
    pub unique_units: HashMap<String, String>,
    pub call_origins: HashMap<(String, String), String>,
    pub method_owners: HashMap<String, String>,
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
    member_types: HashMap<(String, String), String>,
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
    pub locals: &'a [LocalBinding],
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
        member_types: HashMap::new(),
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
                    if let Some(annotation) = &node.type_annotation {
                        symbols
                            .member_types
                            .entry((parent.clone(), node.name.clone()))
                            .or_insert_with(|| annotation.clone());
                    }
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

    let mut local_types: HashMap<(String, String), String> = HashMap::new();
    let mut local_runtime: HashMap<(String, String), String> = HashMap::new();
    let return_types: HashMap<&str, &str> = index
        .nodes
        .iter()
        .filter_map(|node| {
            node.signature
                .as_ref()
                .and_then(|signature| signature.return_type.as_deref())
                .map(|annotation| (node.name.as_str(), annotation))
        })
        .collect();
    for binding in index.locals {
        let annotation = binding
            .annotation
            .clone()
            .or_else(|| binding.constructed.clone())
            .or_else(|| {
                binding
                    .from_call
                    .as_deref()
                    .and_then(|callee| return_types.get(callee))
                    .map(|annotation| (*annotation).to_string())
            });
        let Some(annotation) = annotation else { continue };
        let scope_key = if binding.unit.is_empty() {
            format!("file:{}", binding.file)
        } else {
            binding.unit.clone()
        };
        if let Some(owner) = resolve_type(&symbols, &imported, binding.file, &annotation) {
            local_types.insert((scope_key, binding.name.clone()), owner);
            continue;
        }
        let name = base_type_name(&annotation);
        if runtime.binary_search(&name).is_ok() {
            local_runtime.insert((scope_key, binding.name.clone()), name.to_string());
        }
    }

    let units = unique_units(index.nodes);
    let unique_members = unique_members(index.nodes);
    let mut method_owners: HashMap<String, String> = HashMap::new();
    for fact in index.type_references {
        if fact.kind != EdgeKind::HasMethod {
            continue;
        }
        let root = root_binding(&fact.name);
        if let Some(owner) = symbols
            .local
            .get(&(fact.file, root.to_string()))
            .cloned()
            .or_else(|| {
                symbols
                    .types
                    .get(root)
                    .filter(|found| found.len() == 1)
                    .map(|found| found[0].clone())
            })
        {
            method_owners.insert(fact.source.clone(), owner);
        }
    }

    let mut field_origins: HashMap<(String, String), String> = HashMap::new();
    for node in index.nodes {
        if node.kind != NodeKind::Property {
            continue;
        }
        let (Some(annotation), Some(parent)) = (&node.type_annotation, &node.parent) else {
            continue;
        };
        let qualified = base_qualified_name(annotation);
        let Some((qualifier, _)) = qualified.split_once('.') else { continue };
        if let Some(specifier) = modules.get(&(node.file, qualifier.to_string())).cloned() {
            field_origins.insert((parent.clone(), node.name.clone()), specifier);
        }
    }
    let mut call_origins: HashMap<(String, String), String> = HashMap::new();

    let mut unresolved_calls = 0;
    let mut package_calls = 0;
    let mut runtime_calls = 0;
    let mut dynamic_calls = 0;
    let mut indirect_calls = 0;
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
            Some(target) if fact.kind == EdgeKind::HasMethod => edges.push(IndexEdge {
                source: target,
                target: fact.source.clone(),
                kind: EdgeKind::HasMethod,
            }),
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
        let self_builtin = match fact.receiver.as_deref() {
            Some(receiver) if receiver.starts_with("this.") || receiver.starts_with("self.") => {
                let field = receiver
                    .split_once('.')
                    .map(|(_, rest)| root_binding(rest).to_string())
                    .unwrap_or_default();
                owning_type(&symbols, index.nodes, &method_owners, caller)
                    .and_then(|owner| symbols.member_types.get(&(owner, field)).cloned())
                    .map(|annotation| base_type_name(&annotation).to_string())
                    .filter(|name| runtime.binary_search(&name.as_str()).is_ok())
            }
            _ => None,
        };
        let target = match fact.receiver.as_deref() {
            None if fact.callee == "super" => owning_type(
                &symbols,
                index.nodes,
                &method_owners,
                caller,
            )
            .and_then(|owner| parent_type(&edges, &owner))
            .and_then(|parent| {
                symbols
                    .members
                    .get(&(parent.clone(), "constructor".to_string()))
                    .cloned()
                    .or(Some(parent))
            }),
            Some(receiver) if receiver == "this" || receiver == "self" => {
                owning_type(&symbols, index.nodes, &method_owners, caller)
                    .and_then(|owner| symbols.members.get(&(owner, fact.callee.clone())).cloned())
            }
            Some(receiver) if receiver.starts_with("this.") || receiver.starts_with("self.") => {
                let field = receiver
                    .split_once('.')
                    .map(|(_, rest)| root_binding(rest).to_string())
                    .unwrap_or_default();
                if let Some(owner) = owning_type(&symbols, index.nodes, &method_owners, caller)
                    && let Some(specifier) = field_origins.get(&(owner, field.clone()))
                {
                    call_origins
                        .insert((caller.clone(), receiver.to_string()), specifier.clone());
                }
                owning_type(&symbols, index.nodes, &method_owners, caller)
                    .and_then(|owner| symbols.member_types.get(&(owner.clone(), field.clone())).cloned()
                        .or_else(|| {
                            symbols
                                .members
                                .get(&(owner, field.clone()))
                                .and_then(|id| symbols.by_id.get(id))
                                .and_then(|position| index.nodes[*position].type_annotation.clone())
                        }))
                    .and_then(|annotation| {
                        resolve_type(&symbols, &imported, fact.file, &annotation)
                    })
                    .and_then(|owner| symbols.members.get(&(owner, fact.callee.clone())).cloned())
            }
            Some(receiver)
                if scoped_type(&local_types, caller, fact.file, root_binding(receiver))
                    .and_then(|owner| symbols.members.get(&(owner, fact.callee.clone())))
                    .is_some() =>
            {
                scoped_type(&local_types, caller, fact.file, root_binding(receiver))
                    .and_then(|owner| symbols.members.get(&(owner, fact.callee.clone())).cloned())
            }
            Some(receiver)
                if parameter_type(&symbols, index.nodes, caller, root_binding(receiver))
                    .and_then(|annotation| {
                        resolve_type(&symbols, &imported, fact.file, &annotation)
                    })
                    .and_then(|owner| symbols.members.get(&(owner, fact.callee.clone())))
                    .is_some() =>
            {
                parameter_type(&symbols, index.nodes, caller, root_binding(receiver))
                    .and_then(|annotation| {
                        resolve_type(&symbols, &imported, fact.file, &annotation)
                    })
                    .and_then(|owner| symbols.members.get(&(owner, fact.callee.clone())).cloned())
            }
            Some(receiver)
                if binding_type(&symbols, index.nodes, &imported, fact.file, root_binding(receiver))
                    .and_then(|owner| symbols.members.get(&(owner, fact.callee.clone())))
                    .is_some() =>
            {
                binding_type(&symbols, index.nodes, &imported, fact.file, root_binding(receiver))
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
                })
                .or_else(|| {
                    if modules.contains_key(&(fact.file, root_binding(receiver).to_string())) {
                        return None;
                    }
                    unique_members.get(&fact.callee).cloned()
                }),
            None => imported
                .get(&(fact.file, fact.callee.clone()))
                .cloned()
                .or_else(|| symbols.local.get(&(fact.file, fact.callee.clone())).cloned())
                .or_else(|| {
                    if modules.contains_key(&(fact.file, fact.callee.clone())) {
                        return None;
                    }
                    units.get(&fact.callee).cloned()
                }),
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
                if fact.receiver.is_none() && fact.callee == "import" {
                    dynamic_calls += 1;
                    continue;
                }
                let root = fact
                    .receiver
                    .as_deref()
                    .map(root_binding)
                    .unwrap_or(fact.callee.as_str());
                if let Some(builtin) = self_builtin
                    .as_ref()
                    .or_else(|| local_runtime.get(&(caller.clone(), root.to_string())))
                    .or_else(|| {
                        local_runtime.get(&(format!("file:{}", fact.file), root.to_string()))
                    })
                    .cloned()
                {
                    let builtin = builtin.as_str();
                    let member = format!("{builtin}.{}", fact.callee);
                    let id = external_id("runtime", builtin, &member);
                    external_nodes
                        .entry(id.clone())
                        .or_insert_with(|| external_node(&id, &member, builtin));
                    edges.push(IndexEdge {
                        source: caller.clone(),
                        target: id,
                        kind: EdgeKind::Calls,
                    });
                    runtime_calls += 1;
                    continue;
                }
                if is_parameter_of(&symbols, index.nodes, caller, root) {
                    indirect_calls += 1;
                    continue;
                }
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
        dynamic_calls,
        indirect_calls,
        call_origins,
        method_owners: method_owners.clone(),
        unique_units: units,
        local: symbols.local,
        modules,
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

fn base_qualified_name(annotation: &str) -> &str {
    let annotation = annotation.trim().trim_start_matches(['&', '*']);
    let end = annotation
        .find(['<', '[', '(', ' ', '|', '?', ';'])
        .unwrap_or(annotation.len());
    annotation[..end].trim()
}

fn base_type_name(annotation: &str) -> &str {
    let annotation = annotation.trim().trim_start_matches(['&', '*']);
    let end = annotation
        .find(['<', '[', '(', ' ', '|', '?', ';'])
        .unwrap_or(annotation.len());
    let name = annotation[..end].trim().trim_end_matches('.');
    if name.is_empty() {
        return name;
    }
    if annotation[end..].starts_with('[') {
        return "Array";
    }
    match name {
        "string" => "String",
        "number" => "Number",
        "boolean" => "Boolean",
        "symbol" => "Symbol",
        "bigint" => "BigInt",
        "object" => "Object",
        other => other,
    }
}

fn resolve_type(
    symbols: &Symbols,
    imported: &HashMap<(u32, String), String>,
    file: u32,
    annotation: &str,
) -> Option<String> {
    let name = base_type_name(annotation);
    if name.is_empty() {
        return None;
    }
    imported
        .get(&(file, name.to_string()))
        .cloned()
        .or_else(|| symbols.local.get(&(file, name.to_string())).cloned())
        .or_else(|| {
            symbols
                .types
                .get(name)
                .filter(|found| found.len() == 1)
                .map(|found| found[0].clone())
        })
}

fn parent_type(edges: &[IndexEdge], owner: &str) -> Option<String> {
    edges
        .iter()
        .find(|edge| edge.kind == EdgeKind::Extends && edge.source == owner)
        .map(|edge| edge.target.clone())
}

fn binding_type(
    symbols: &Symbols,
    nodes: &[IndexNode],
    imported: &HashMap<(u32, String), String>,
    file: u32,
    binding: &str,
) -> Option<String> {
    let id = imported
        .get(&(file, binding.to_string()))
        .or_else(|| symbols.local.get(&(file, binding.to_string())))?;
    let position = *symbols.by_id.get(id)?;
    let annotation = nodes[position].type_annotation.as_deref()?;
    resolve_type(symbols, imported, nodes[position].file, annotation)
}

fn scoped_type(
    types: &HashMap<(String, String), String>,
    caller: &str,
    file: u32,
    binding: &str,
) -> Option<String> {
    types
        .get(&(caller.to_string(), binding.to_string()))
        .or_else(|| types.get(&(format!("file:{file}"), binding.to_string())))
        .cloned()
}

fn is_parameter_of(
    symbols: &Symbols,
    nodes: &[IndexNode],
    caller: &str,
    binding: &str,
) -> bool {
    let Some(position) = symbols.by_id.get(caller) else {
        return false;
    };
    nodes[*position]
        .signature
        .as_ref()
        .is_some_and(|signature| {
            signature
                .parameters
                .iter()
                .any(|parameter| parameter.name == binding)
        })
}

fn parameter_type(
    symbols: &Symbols,
    nodes: &[IndexNode],
    caller: &str,
    binding: &str,
) -> Option<String> {
    let position = *symbols.by_id.get(caller)?;
    nodes[position]
        .signature
        .as_ref()?
        .parameters
        .iter()
        .find(|parameter| parameter.name == binding)
        .and_then(|parameter| parameter.type_annotation.clone())
}

fn unique_members(nodes: &[IndexNode]) -> HashMap<String, String> {
    let mut counts: HashMap<&str, (u32, &str)> = HashMap::new();
    for node in nodes {
        if !matches!(node.kind, NodeKind::Method | NodeKind::Getter | NodeKind::Setter) {
            continue;
        }
        let entry = counts
            .entry(node.name.as_str())
            .or_insert((0, node.id.as_str()));
        entry.0 += 1;
    }
    counts
        .into_iter()
        .filter(|(_, (count, _))| *count == 1)
        .map(|(name, (_, id))| (name.to_string(), id.to_string()))
        .collect()
}

fn unique_units(nodes: &[IndexNode]) -> HashMap<String, String> {
    let mut counts: HashMap<&str, (u32, &str)> = HashMap::new();
    for node in nodes {
        if !matches!(
            node.kind,
            NodeKind::Function | NodeKind::Method | NodeKind::Constructor
        ) {
            continue;
        }
        let entry = counts.entry(node.name.as_str()).or_insert((0, node.id.as_str()));
        entry.0 += 1;
    }
    counts
        .into_iter()
        .filter(|(_, (count, _))| *count == 1)
        .map(|(name, (_, id))| (name.to_string(), id.to_string()))
        .collect()
}

fn owning_type(
    symbols: &Symbols,
    nodes: &[IndexNode],
    owners: &HashMap<String, String>,
    caller: &str,
) -> Option<String> {
    let mut current = caller.to_string();
    for _ in 0..16 {
        if let Some(owner) = owners.get(&current) {
            return Some(owner.clone());
        }
        let position = *symbols.by_id.get(&current)?;
        let node = &nodes[position];
        if matches!(node.kind, NodeKind::Class | NodeKind::Interface) {
            return Some(node.id.clone());
        }
        current = node.parent.clone()?;
    }
    None
}
