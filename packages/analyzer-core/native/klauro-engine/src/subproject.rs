use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use serde::Serialize;

use crate::entry_exit::EntryPoint;
use crate::model::*;
use crate::paths::{basename, contains, directory_of, display_name, file_of};
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
    pub composition: &'static str,
    pub crossing_imports: u32,
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
    ("pom.xml", "modules"),
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
                    .filter(|node| node.name == "project")
                    .find_map(|project| {
                        children
                            .get(project.id.as_str())?
                            .iter()
                            .find(|node| node.name == *key)
                    })
            })
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
            let value = entry
                .type_annotation
                .clone()
                .unwrap_or_else(|| entry.name.clone());
            patterns.push((path.clone(), value));
        }
    }
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
    let mut children: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
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

    let patterns = workspace_patterns(files, &children);
    let mut declared: Vec<Declared> = Vec::new();
    let mut claimed: HashSet<String> = HashSet::default();

    let unit_named: HashMap<&str, &Deployable> = deployables.iter().map(|unit| (unit.id.as_str(), unit)).collect();
    let shared = |unit: &Deployable| unit.consumers >= SHARED_BY;
    let tops_what_is_shared = |unit: &Deployable| {
        shared(unit)
            && unit.bundled_into.as_deref().and_then(|above| unit_named.get(above)).is_some_and(|above| !shared(above))
    };
    let chain_of = |unit| bundled_chain(unit, &unit_named);
    let mut beneath: HashMap<&str, usize> = HashMap::default();
    for unit in deployables {
        for held in chain_of(unit) {
            *beneath.entry(held.id.as_str()).or_default() += 1;
        }
    }
    let mut leading: HashMap<&str, (&Deployable, usize)> = HashMap::default();
    for unit in deployables.iter().filter(|unit| shared(unit)) {
        let chain = chain_of(unit);
        let Some(depth) = chain.iter().position(|held| tops_what_is_shared(held)) else { continue };
        let top = chain[depth];
        let covers = beneath.get(unit.id.as_str()).copied().unwrap_or(0) * FUNNEL_SHARE_DENOMINATOR
            >= beneath.get(top.id.as_str()).copied().unwrap_or(0) * FUNNEL_SHARE_NUMERATOR;
        if !covers {
            continue;
        }
        let best = leading.entry(top.id.as_str()).or_insert((top, 0));
        if depth > best.1 {
            *best = (unit, depth);
        }
    }
    let leading: HashMap<&str, &Deployable> = leading.into_iter().map(|(top, (unit, _))| (top, unit)).collect();
    let heads: HashSet<&str> = leading.values().map(|unit| unit.id.as_str()).collect();
    for unit in deployables.iter().filter(|unit| {
        unit.bundled_into.is_some() && unit.category == "library" && unit.runs.is_none() && !heads.contains(unit.id.as_str())
    }) {
        claimed.insert(unit.root.clone());
    }

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
        claimed.insert(root.clone());
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

    for unit in deployables.iter().filter(|unit| {
        !unit.root.is_empty() && unit.declarations.iter().any(|held| held.kind == "apple-application")
    }) {
        if !claimed.insert(unit.root.clone()) {
            continue;
        }
        declared.push(Declared {
            name: unit.name.clone(),
            root: unit.root.clone(),
            declared_by: "ship-declaration",
            at: unit.declarations.first().map(|held| held.at.clone()).unwrap_or_default(),
        });
    }

    if declared.is_empty() {
        declared = cohesive_roots(files, edges);
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

const SHARED_BY: u32 = 2;

fn bundled_chain<'d>(unit: &'d Deployable, named: &HashMap<&str, &'d Deployable>) -> Vec<&'d Deployable> {
    let mut chain = vec![unit];
    let mut current = unit;
    for _ in 0..32 {
        let Some(above) = current.bundled_into.as_deref().and_then(|above| named.get(above).copied()) else { break };
        chain.push(above);
        current = above;
    }
    chain
}
const FUNNEL_SHARE_NUMERATOR: usize = 9;
const FUNNEL_SHARE_DENOMINATOR: usize = 10;

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

const COHESION_FLOOR: f32 = 0.8;
const COHESION_MINIMUM_FILES: usize = 3;

fn cohesive_roots(files: &[String], edges: &[IndexEdge]) -> Vec<Declared> {
    let mut candidates: HashMap<&str, usize> = HashMap::default();
    for path in files {
        let directory = directory_of(path);
        if directory.is_empty() {
            continue;
        }
        let top = directory.split('/').next().unwrap_or(directory);
        *candidates.entry(top).or_insert(0) += 1;
    }
    candidates.retain(|_, count| *count >= COHESION_MINIMUM_FILES);
    if candidates.len() < 2 {
        return Vec::new();
    }

    let mut within: HashMap<&str, u32> = HashMap::default();
    let mut crossing: HashMap<&str, u32> = HashMap::default();
    let top_of = |path: &str| -> Option<&str> {
        let top = path.split('/').next()?;
        candidates.get_key_value(top).map(|(key, _)| *key)
    };
    for edge in edges {
        if edge.kind != EdgeKind::Imports {
            continue;
        }
        match (top_of(&edge.source), top_of(&edge.target)) {
            (Some(from), Some(to)) if from == to => *within.entry(from).or_insert(0) += 1,
            (Some(from), _) => *crossing.entry(from).or_insert(0) += 1,
            _ => {}
        }
    }

    let mut cohesive: Vec<Declared> = candidates
        .keys()
        .filter(|top| {
            let inside = within.get(*top).copied().unwrap_or(0) as f32;
            let across = crossing.get(*top).copied().unwrap_or(0) as f32;
            inside + across > 0.0 && inside / (inside + across) >= COHESION_FLOOR
        })
        .map(|top| Declared {
            name: (*top).to_string(),
            root: (*top).to_string(),
            declared_by: "import-cohesion",
            at: (*top).to_string(),
        })
        .collect();
    if cohesive.len() < 2 {
        return Vec::new();
    }
    cohesive.sort_by(|left, right| left.root.cmp(&right.root));
    cohesive
}

fn manifest_name(children: &HashMap<&str, Vec<&IndexNode>>, manifest: &str) -> Option<String> {
    let document = children.get(manifest)?;
    let named = document
        .iter()
        .find(|node| node.name == "name")
        .or_else(|| {
            document
                .iter()
                .filter(|node| node.name == "project")
                .find_map(|project| {
                    children
                        .get(project.id.as_str())?
                        .iter()
                        .find(|node| node.name == "artifactId")
                })
        })
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




fn partition(
    declared: Vec<Declared>,
    files: &[String],
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    entry_points: &[EntryPoint],
    code: &[bool],
    deployables: &[Deployable],
) -> Partition {
    let residue = declared.len();
    let mut declared = declared;
    declared.push(Declared {
        name: "repository".to_string(),
        root: String::new(),
        declared_by: "repository-residue",
        at: String::new(),
    });

    let mut order: Vec<usize> = (0..declared.len()).collect();
    order.sort_by_key(|at| std::cmp::Reverse(declared[*at].root.len()));

    let declared_at: HashMap<&str, usize> =
        declared.iter().enumerate().map(|(at, found)| (found.root.as_str(), at)).collect();
    let unit_of: HashMap<&str, &Deployable> =
        deployables.iter().map(|unit| (unit.id.as_str(), unit)).collect();
    let mut bundled: Vec<&Deployable> = deployables
        .iter()
        .filter(|unit| unit.bundled_into.is_some() && !unit.root.is_empty() && !declared_at.contains_key(unit.root.as_str()))
        .collect();
    bundled.sort_by_key(|unit| std::cmp::Reverse(unit.root.len()));
    let carried_to = |unit: &Deployable| -> Option<usize> {
        let mut current = unit;
        for _ in 0..32 {
            let above = unit_of.get(current.bundled_into.as_deref()?).copied()?;
            if let Some(at) = declared_at.get(above.root.as_str()).filter(|_| !above.root.is_empty()) {
                return Some(*at);
            }
            current = above;
        }
        None
    };
    let nearest = |path: &str| -> Option<usize> {
        order
            .iter()
            .copied()
            .find(|at| contains(&declared[*at].root, path))
    };
    let owner = |path: &str| -> Option<usize> {
        let found = nearest(path)?;
        let inner = bundled.iter().find(|unit| contains(&unit.root, path));
        match inner {
            Some(unit) if unit.root.len() > declared[found].root.len() => carried_to(unit).or(Some(found)),
            _ => Some(found),
        }
    };

    let mut sub_projects: Vec<SubProject> = declared
        .iter()
        .map(|found| SubProject {
            id: format!(
                "subproject:{}",
                if found.root.is_empty() {
                    found.name.as_str()
                } else {
                    found.root.as_str()
                }
            ),
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

    let mut imports: HashMap<&str, Vec<&str>> = HashMap::default();
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
        let mut found: HashMap<&str, Vec<usize>> = HashMap::default();
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
        if !code.get(node.file as usize).copied().unwrap_or(false) || !node.kind.is_declaration() {
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
                _ => {
                    sub_projects[residue].declarations += 1;
                    unpartitioned += 1;
                }
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
                    .any(|path| !project.root.is_empty() && contains(&project.root, path));
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

    let mut assignment: Vec<(String, String)> = assignment
        .into_iter()
        .map(|(path, at)| (path, sub_projects[at].id.clone()))
        .collect();

    if sub_projects[residue].declarations == 0 {
        let empty = sub_projects.remove(residue).id;
        assignment.retain(|(_, id)| *id != empty);
    }

    sub_projects.sort_by(|left, right| left.id.cmp(&right.id));
    let qualified = sub_projects.len() as u32;
    let promoted = sub_projects.len() >= PROMOTION_THRESHOLD;
    let crossing: u32 = sub_projects.iter().map(|project| project.imports_crossing).sum();
    let bound_together = sub_projects
        .iter()
        .any(|project| project.declared_by == "workspace-member");
    let sub_cas_nodes = SubCasNodes {
        promoted,
        reason: match sub_projects.len() {
            0 => "no-declared-project",
            1 => "one-project-below-threshold",
            _ => "declared-projects-at-threshold",
        },
        qualified,
        composition: match (promoted, bound_together || crossing > 0) {
            (false, _) => "single",
            (true, true) => "monorepo",
            (true, false) => "container",
        },
        crossing_imports: crossing,
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
