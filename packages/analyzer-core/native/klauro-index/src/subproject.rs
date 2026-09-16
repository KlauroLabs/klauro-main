use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::entry_exit::EntryPoint;
use crate::model::*;
use crate::scope::Deployable;

#[derive(Debug, Serialize)]
pub struct SubProject {
    pub id: String,
    pub name: String,
    pub root: String,
    pub declared_by: &'static str,
    pub at: String,
    pub files: u32,
    pub declarations: u32,
    pub entry_points: u32,
    pub imports_within: u32,
    pub imports_crossing: u32,
    pub ship_backed: bool,
    pub runnable: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ships_in: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub consumed_by: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct SubCasNodes {
    pub promoted: bool,
    pub reason: &'static str,
    pub qualified: u32,
}

#[derive(Debug, Serialize)]
pub struct Partition {
    pub sub_projects: Vec<SubProject>,
    #[serde(skip)]
    pub assignment: Vec<(String, String)>,
    pub sub_cas_nodes: SubCasNodes,
    pub assigned_declarations: u32,
    pub shared_declarations: u32,
    pub unpartitioned_declarations: u32,
}

struct Declared {
    root: String,
    name: String,
    declared_by: &'static str,
    at: String,
}

const PROMOTION_THRESHOLD: usize = 2;

static WORKSPACE_KEYS: &[(&str, &str)] = &[
    ("pnpm-workspace.yaml", "packages"),
    ("package.json", "workspaces"),
    ("cargo.toml", "members"),
    ("go.work", "use"),
];

static MODULE_MANIFESTS: &[&str] = &[
    "build.gradle",
    "build.gradle.kts",
    "build.sbt",
    "cargo.toml",
    "go.mod",
    "package.json",
    "pom.xml",
    "pyproject.toml",
    "setup.py",
];

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn directory_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(at) => &path[..at],
        None => "",
    }
}

fn display_name(root: &str) -> String {
    match root.rsplit('/').next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => "root".to_string(),
    }
}

fn is_module_manifest(path: &str) -> bool {
    let name = basename(path).to_ascii_lowercase();
    MODULE_MANIFESTS.binary_search(&name.as_str()).is_ok()
        || name.ends_with(".csproj")
        || name.ends_with(".fsproj")
}

fn matches_pattern(pattern: &str, root: &str) -> bool {
    let pattern = pattern.trim_end_matches('/');
    if pattern == "." || pattern.is_empty() {
        return root.is_empty();
    }
    match pattern.strip_suffix("/*") {
        Some(prefix) => directory_of(root) == prefix && !root.is_empty(),
        None => match pattern.strip_suffix("/**") {
            Some(prefix) => root == prefix || root.starts_with(&format!("{prefix}/")),
            None => root == pattern,
        },
    }
}

fn workspace_patterns<'a>(
    nodes: &'a [IndexNode],
    files: &[String],
    children: &HashMap<&'a str, Vec<&'a IndexNode>>,
) -> Vec<(String, String)> {
    let mut patterns = Vec::new();
    for path in files {
        let name = basename(path).to_ascii_lowercase();
        let Some((_, key)) = WORKSPACE_KEYS.iter().find(|(file, _)| *file == name) else {
            continue;
        };
        let Some(document) = children.get(path.as_str()) else { continue };
        let holder = document
            .iter()
            .find(|node| node.name == *key)
            .or_else(|| {
                document
                    .iter()
                    .filter(|node| node.name == "workspace")
                    .find_map(|workspace| {
                        children
                            .get(workspace.id.as_str())?
                            .iter()
                            .find(|node| node.name == *key)
                    })
            });
        let Some(holder) = holder else { continue };
        let Some(entries) = children.get(holder.id.as_str()) else { continue };
        for entry in entries {
            patterns.push((path.clone(), entry.name.clone()));
        }
    }
    let _ = nodes;
    patterns
}

pub fn derive(
    files: &[String],
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    entry_points: &[EntryPoint],
    nested: &[String],
    code: &[bool],
    deployables: &[Deployable],
) -> Partition {
    let mut children: HashMap<&str, Vec<&IndexNode>> = HashMap::new();
    for node in nodes {
        if let Some(parent) = node.parent.as_deref() {
            children.entry(parent).or_default().push(node);
        }
    }

    let manifests: Vec<(String, String)> = files
        .iter()
        .filter(|path| is_module_manifest(path))
        .map(|path| (directory_of(path).to_string(), path.clone()))
        .collect();

    let patterns = workspace_patterns(nodes, files, &children);
    let mut declared: Vec<Declared> = Vec::new();
    let mut claimed: HashSet<String> = HashSet::new();

    for (at, pattern) in &patterns {
        for (root, manifest) in &manifests {
            if claimed.contains(root) || !matches_pattern(pattern, root) {
                continue;
            }
            claimed.insert(root.clone());
            declared.push(Declared {
                name: manifest_name(&children, manifest).unwrap_or_else(|| display_name(root)),
                root: root.clone(),
                declared_by: "workspace-member",
                at: at.clone(),
            });
        }
    }

    for root in nested {
        if claimed.insert(root.clone()) {
            declared.push(Declared {
                name: display_name(root),
                root: root.clone(),
                declared_by: "repository",
                at: format!("{root}/.git"),
            });
        }
    }

    for (root, manifest) in &manifests {
        if claimed.contains(root) || declares_workspace(&children, manifest) {
            continue;
        }
        claimed.insert(root.clone());
        declared.push(Declared {
            name: manifest_name(&children, manifest).unwrap_or_else(|| display_name(root)),
            root: root.clone(),
            declared_by: "module-manifest",
            at: manifest.clone(),
        });
    }

    if declared.is_empty() {
        declared.push(Declared {
            name: "root".to_string(),
            root: String::new(),
            declared_by: "repository-root",
            at: String::new(),
        });
    }

    partition(declared, files, nodes, edges, entry_points, code, deployables)
}

fn declares_workspace(children: &HashMap<&str, Vec<&IndexNode>>, manifest: &str) -> bool {
    let name = basename(manifest).to_ascii_lowercase();
    let Some((_, key)) = WORKSPACE_KEYS.iter().find(|(file, _)| *file == name) else {
        return false;
    };
    let Some(document) = children.get(manifest) else {
        return false;
    };
    document.iter().any(|node| node.name == *key)
        || document
            .iter()
            .filter(|node| node.name == "workspace")
            .any(|workspace| {
                children
                    .get(workspace.id.as_str())
                    .is_some_and(|nested| nested.iter().any(|node| node.name == *key))
            })
}

fn manifest_name(children: &HashMap<&str, Vec<&IndexNode>>, manifest: &str) -> Option<String> {
    let document = children.get(manifest)?;
    let named = document
        .iter()
        .find(|node| node.name == "name")
        .or_else(|| {
            document
                .iter()
                .filter(|node| node.name == "package")
                .find_map(|package| {
                    children
                        .get(package.id.as_str())?
                        .iter()
                        .find(|node| node.name == "name")
                })
        })?;
    named
        .type_annotation
        .as_deref()
        .map(|value| value.trim().trim_matches(['"', '\'']).to_string())
        .filter(|value| !value.is_empty())
}

fn contains(root: &str, path: &str) -> bool {
    if root.is_empty() {
        return true;
    }
    path == root
        || (path.len() > root.len()
            && path.as_bytes()[root.len()] == b'/'
            && path.starts_with(root))
}

fn file_of(id: &str) -> &str {
    match id.find(':') {
        Some(at) => &id[..at],
        None => id,
    }
}

fn is_declaration(kind: NodeKind) -> bool {
    matches!(
        kind,
        NodeKind::Function
            | NodeKind::Method
            | NodeKind::Constructor
            | NodeKind::Getter
            | NodeKind::Setter
            | NodeKind::Class
            | NodeKind::Interface
            | NodeKind::Enum
            | NodeKind::TypeAlias
    )
}

fn partition(
    declared: Vec<Declared>,
    files: &[String],
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    entry_points: &[EntryPoint],
    code: &[bool],
    deployables: &[Deployable],
) -> Partition {
    let mut order: Vec<usize> = (0..declared.len()).collect();
    order.sort_by_key(|at| std::cmp::Reverse(declared[*at].root.len()));

    let owner = |path: &str| -> Option<usize> {
        order
            .iter()
            .copied()
            .find(|at| contains(&declared[*at].root, path))
    };

    let mut sub_projects: Vec<SubProject> = declared
        .iter()
        .map(|found| SubProject {
            id: format!("subproject:{}", found.root),
            name: found.name.clone(),
            root: found.root.clone(),
            declared_by: found.declared_by,
            at: found.at.clone(),
            files: 0,
            declarations: 0,
            entry_points: 0,
            imports_within: 0,
            imports_crossing: 0,
            ship_backed: false,
            runnable: false,
            ships_in: Vec::new(),
            consumed_by: Vec::new(),
        })
        .collect();

    for path in files {
        if let Some(at) = owner(path) {
            sub_projects[at].files += 1;
        }
    }

    let mut imports: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in edges {
        if edge.kind != EdgeKind::Imports {
            continue;
        }
        imports
            .entry(edge.source.as_str())
            .or_default()
            .push(edge.target.as_str());
        match (owner(&edge.source), owner(&edge.target)) {
            (Some(from), Some(to)) if from == to => sub_projects[from].imports_within += 1,
            (Some(from), to) => {
                sub_projects[from].imports_crossing += 1;
                if let Some(to) = to {
                    let consumer = sub_projects[from].id.clone();
                    let consumed = &mut sub_projects[to].consumed_by;
                    if !consumed.contains(&consumer) {
                        consumed.push(consumer);
                    }
                }
            }
            _ => {}
        }
    }

    let reach: HashMap<&str, Vec<usize>> = {
        let mut found: HashMap<&str, Vec<usize>> = HashMap::new();
        for (at, project) in sub_projects.iter().enumerate() {
            let mut seen: HashSet<&str> = files
                .iter()
                .map(String::as_str)
                .filter(|path| contains(&project.root, path))
                .collect();
            let mut frontier: Vec<&str> = seen.iter().copied().collect();
            while let Some(current) = frontier.pop() {
                let Some(targets) = imports.get(current) else { continue };
                for target in targets {
                    if seen.insert(target) {
                        frontier.push(target);
                    }
                }
            }
            for path in seen {
                found.entry(path).or_default().push(at);
            }
        }
        found
    };

    let mut assignment: Vec<(String, usize)> = Vec::new();
    for path in files {
        if let Some(at) = owner(path) {
            assignment.push((path.clone(), at));
            continue;
        }
        if let Some([only]) = reach.get(path.as_str()).map(Vec::as_slice) {
            assignment.push((path.clone(), *only));
        }
    }

    let mut assigned = 0;
    let mut shared = 0;
    let mut unpartitioned = 0;
    for node in nodes {
        if !code.get(node.file as usize).copied().unwrap_or(false) || !is_declaration(node.kind) {
            continue;
        }
        let path = file_of(&node.id);
        match owner(path) {
            Some(at) => {
                sub_projects[at].declarations += 1;
                assigned += 1;
            }
            None => match reach.get(path).map(Vec::as_slice) {
                Some([only]) => {
                    sub_projects[*only].declarations += 1;
                    assigned += 1;
                }
                Some(several) if !several.is_empty() => {
                    for at in several {
                        sub_projects[*at].declarations += 1;
                    }
                    shared += 1;
                }
                _ => unpartitioned += 1,
            },
        }
    }
    for entry in entry_points {
        if let Some(at) = owner(file_of(&entry.handler)) {
            sub_projects[at].entry_points += 1;
            if matches!(entry.kind, "lifecycle" | "cli" | "http" | "rpc" | "graphql") {
                sub_projects[at].runnable = true;
            }
        }
    }

    for unit in deployables {
        for project in sub_projects.iter_mut() {
            let covered = unit.root == project.root
                || unit
                    .ships
                    .iter()
                    .any(|path| !path.is_empty() && contains(path, &project.root));
            if unit.shipped && covered {
                project.ship_backed = true;
                if !project.ships_in.contains(&unit.id) {
                    project.ships_in.push(unit.id.clone());
                }
            }
        }
    }
    for project in sub_projects.iter_mut() {
        project.consumed_by.sort();
        project.ships_in.sort();
    }

    let assignment: Vec<(String, String)> = assignment
        .into_iter()
        .map(|(path, at)| (path, sub_projects[at].id.clone()))
        .collect();

    sub_projects.sort_by(|left, right| left.id.cmp(&right.id));
    let qualified = sub_projects.len() as u32;
    let sub_cas_nodes = SubCasNodes {
        promoted: sub_projects.len() >= PROMOTION_THRESHOLD,
        reason: match sub_projects.len() {
            0 => "no-declared-project",
            1 => "one-project-below-threshold",
            _ => "declared-projects-at-threshold",
        },
        qualified,
    };
    Partition {
        assignment,
        sub_projects,
        sub_cas_nodes,
        assigned_declarations: assigned,
        shared_declarations: shared,
        unpartitioned_declarations: unpartitioned,
    }
}
