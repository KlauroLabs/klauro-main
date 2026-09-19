use std::collections::HashMap;

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
    ("Handler", "handler"),
    ("Middleware", "middleware"),
    ("Repository", "repository"),
    ("Service", "service"),
];

fn annotation_role(name: &str) -> Option<&'static str> {
    let leaf = name.rsplit('.').next().unwrap_or(name).to_ascii_lowercase();
    let trimmed = leaf.trim_end_matches("mapping");
    ANNOTATIONS
        .binary_search_by(|(known, _)| (*known).cmp(trimmed))
        .ok()
        .map(|at| ANNOTATIONS[at].1)
}

fn inherited_role(name: &str) -> Option<&'static str> {
    let leaf = name.rsplit(['.', ':']).next().unwrap_or(name);
    SUFFIXES
        .iter()
        .filter(|(suffix, _)| leaf.ends_with(suffix) && leaf.len() > suffix.len())
        .max_by_key(|(suffix, _)| suffix.len())
        .map(|(_, role)| *role)
}

pub fn derive(
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    entry_points: &[EntryPoint],
    declared: &[bool],
) -> Roles {
    let named: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut roles: Vec<Role> = Vec::new();
    let mut seen: std::collections::HashSet<(String, &'static str)> =
        std::collections::HashSet::new();

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
    }

    for entry in entry_points {
        let Some(node) = named.get(entry.handler.as_str()) else { continue };
        let role = match entry.kind {
            "http" | "rpc" | "graphql" => "handler",
            "event" | "message" => "listener",
            "schedule" => "scheduled",
            "cli" => "command",
            "test" => "test",
            _ => continue,
        };
        record(node, role, format!("{}:{}", entry.kind, entry.registrar));
    }

    for node in nodes {
        if !node.kind.is_type() || !declared.get(node.file as usize).copied().unwrap_or(false) {
            continue;
        }
        if let Some(role) = inherited_role(&node.name) {
            record(node, role, format!("name:{}", node.name));
        }
    }

    roles.sort_by(|left, right| left.node.cmp(&right.node).then(left.role.cmp(right.role)));

    let mut counts: HashMap<&str, u32> = HashMap::new();
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
