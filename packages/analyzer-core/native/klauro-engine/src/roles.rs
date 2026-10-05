use rustc_hash::FxHashMap as HashMap;

use serde::Serialize;

use crate::entry_exit::EntryPoint;
use crate::model::*;

#[derive(Debug, Serialize)]
pub struct Role {
    pub node: String,
    pub role: &'static str,
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Roles {
    pub roles: Vec<Role>,
    pub by_role: Vec<(String, u32)>,
}

static ANNOTATIONS: &[(&str, &str)] = &[
    ("autowired", "provider"),
    ("bean", "provider"),
    ("component", "component"),
    ("configuration", "provider"),
    ("controller", "controller"),
    ("controlleradvice", "middleware"),
    ("directive", "component"),
    ("document", "model"),
    ("embeddable", "model"),
    ("entity", "model"),
    ("filter", "middleware"),
    ("guard", "middleware"),
    ("injectable", "provider"),
    ("interceptor", "middleware"),
    ("middleware", "middleware"),
    ("model", "model"),
    ("module", "provider"),
    ("pipe", "component"),
    ("repository", "repository"),
    ("restcontroller", "controller"),
    ("service", "service"),
    ("table", "model"),
];

static SUFFIXES: &[(&str, &str)] = &[
    ("Controller", "controller"),
    ("Document", "model"),
    ("Entity", "model"),
    ("Handler", "handler"),
    ("Middleware", "middleware"),
    ("Model", "model"),
    ("Repository", "repository"),
    ("Schema", "model"),
    ("Service", "service"),
    ("Store", "repository"),
];

fn module_role(path: &str) -> Option<&'static str> {
    let stem = crate::paths::basename(path).split('.').next().unwrap_or_default().to_ascii_lowercase();
    let stem = stem.trim_end_matches(['s', '_', '-']);
    if stem.ends_with("store") || stem.ends_with("repository") || stem.ends_with("repo") {
        Some("repository")
    } else if stem.ends_with("service") {
        Some("service")
    } else {
        None
    }
}

fn is_a_hook(name: &str) -> bool {
    name.strip_prefix("use").and_then(|rest| rest.chars().next()).is_some_and(|held| held.is_ascii_uppercase())
}

fn annotation_role(name: &str) -> Option<&'static str> {
    let leaf = name.rsplit('.').next().unwrap_or(name).to_ascii_lowercase();
    let trimmed = leaf.trim_end_matches("mapping");
    ANNOTATIONS
        .binary_search_by(|(known, _)| (*known).cmp(trimmed))
        .ok()
        .map(|at| ANNOTATIONS[at].1)
}

fn inherited_role(name: &str) -> Option<&'static str> {
    suffix_role(name, true)
}

fn named_role(name: &str) -> Option<&'static str> {
    suffix_role(name, false)
}

fn suffix_role(name: &str, whole: bool) -> Option<&'static str> {
    let leaf = name.rsplit(['.', ':']).next().unwrap_or(name);
    SUFFIXES
        .iter()
        .filter(|(suffix, _)| leaf.ends_with(suffix) && (whole || leaf.len() > suffix.len()))
        .max_by_key(|(suffix, _)| suffix.len())
        .map(|(_, role)| *role)
}

pub fn derive(
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    type_references: &[TypeReferenceFact],
    entry_points: &[EntryPoint],
    declared: &[bool],
    calls: &[CallFact],
    files: &[String],
) -> Roles {
    let named: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut roles: Vec<Role> = Vec::new();
    let mut inherits: Vec<(String, String, String)> = Vec::new();
    let mut seen: rustc_hash::FxHashSet<(String, &'static str)> =
        rustc_hash::FxHashSet::default();

    let mut record = |node: &IndexNode, role: &'static str, from: String| {
        if seen.insert((node.id.clone(), role)) {
            roles.push(Role {
                node: node.id.clone(),
                role,
                from,
                project: node.project.clone(),
            });
        }
    };

    for node in nodes {
        for decorator in &node.decorators {
            if let Some(role) = annotation_role(&decorator.name) {
                record(node, role, format!("annotation:{}", decorator.name));
            }
        }
    }

    for edge in edges {
        if !matches!(edge.kind, EdgeKind::Extends | EdgeKind::Implements) {
            continue;
        }
        let (Some(source), Some(target)) = (named.get(edge.source.as_str()), named.get(edge.target.as_str()))
        else {
            continue;
        };
        if let Some(role) = inherited_role(&target.name) {
            record(source, role, format!("inherits:{}", target.name));
        }
        inherits.push((source.id.clone(), target.id.clone(), target.name.clone()));
    }

    for fact in type_references {
        if !matches!(fact.kind, EdgeKind::Extends | EdgeKind::Implements) {
            continue;
        }
        let (Some(node), Some(role)) = (
            named.get(fact.source.as_str()),
            inherited_role(&fact.name),
        ) else {
            continue;
        };
        record(node, role, format!("inherits:{}", fact.name));
    }

    for entry in entry_points {
        let Some(node) = named.get(entry.handler.as_str()) else { continue };
        let role = match entry.kind {
            "http" | "rpc" | "graphql" | "ipc" => "handler",
            "ui" => "component",
            "event" | "message" => "listener",
            "schedule" => "scheduled",
            "cli" => "command",
            "test" => "test",
            _ => continue,
        };
        record(node, role, format!("{}:{}", entry.kind, entry.registrar));
    }

    let drawn: rustc_hash::FxHashSet<&str> = calls
        .iter()
        .filter(|call| call.renders)
        .flat_map(|call| [Some(call.callee.as_str()), call.caller.as_deref().and_then(|caller| caller.rsplit(':').next())])
        .flatten()
        .collect();
    for node in nodes.iter().filter(|node| matches!(node.kind, NodeKind::Function | NodeKind::Method)) {
        let Some(path) = files.get(node.file as usize) else { continue };
        let markup = path.ends_with(".tsx") || path.ends_with(".jsx");
        let leaf = node.name.as_str();
        if markup && leaf.starts_with(|held: char| held.is_ascii_uppercase()) && drawn.contains(leaf) {
            record(node, "component", format!("renders:{leaf}"));
        } else if is_a_hook(leaf) && (markup || path.ends_with(".ts")) && !node.id.contains(":callback:") {
            record(node, "service", format!("hook:{leaf}"));
        } else if let Some(role) = module_role(path).filter(|_| node.parent.as_deref() == Some(path.as_str())) {
            record(node, role, format!("module:{path}"));
        }
    }

    for node in nodes {
        if !node.kind.is_type() || !declared.get(node.file as usize).copied().unwrap_or(false) {
            continue;
        }
        if let Some(role) = named_role(&node.name) {
            record(node, role, format!("name:{}", node.name));
        }
    }

    let mut modelled: rustc_hash::FxHashSet<String> = roles
        .iter()
        .filter(|role| role.role == "model")
        .map(|role| role.node.clone())
        .collect();
    loop {
        let carried: Vec<(String, String)> = inherits
            .iter()
            .filter(|(source, target, _)| {
                modelled.contains(target) && !modelled.contains(source)
            })
            .map(|(source, _, from)| (source.clone(), from.clone()))
            .collect();
        if carried.is_empty() {
            break;
        }
        for (source, from) in carried {
            if seen.insert((source.clone(), "model")) {
                roles.push(Role {
                    node: source.clone(),
                    role: "model",
                    from: format!("inherits:{from}"),
                    project: named.get(source.as_str()).and_then(|node| node.project.clone()),
                });
            }
            modelled.insert(source);
        }
    }

    roles.sort_by(|left, right| left.node.cmp(&right.node).then(left.role.cmp(right.role)));

    let mut counts: HashMap<&str, u32> = HashMap::default();
    for role in &roles {
        *counts.entry(role.role).or_insert(0) += 1;
    }
    let mut by_role: Vec<(String, u32)> = counts
        .into_iter()
        .map(|(role, count)| (role.to_string(), count))
        .collect();
    by_role.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));

    Roles { roles, by_role }
}
