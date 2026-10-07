use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use serde::Serialize;

use crate::catalog_descriptor::{self, Descriptor};
use crate::entry_exit::EntryPoint;
use crate::model::*;
use crate::paths::{basename, contains, directory_of, display_name, file_of};
use crate::scope::{Declares, Deployable};

pub mod identity;

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
    pub status: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ships_in: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub consumed_by: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<String>,
    #[serde(skip)]
    pub imported_by: Vec<String>,
    #[serde(skip)]
    pub published: bool,
    #[serde(skip)]
    pub test_files: u32,
    #[serde(skip)]
    pub code_files: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    pub display_name: String,
    pub role: &'static str,
    pub role_basis: String,
    pub summary: String,
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
    #[serde(skip)]
    pub imports_between: Vec<(String, String, u32)>,
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
    "build.zig.zon",
    "cargo.toml",
    "composer.json",
    "deno.json",
    "deno.jsonc",
    "dune-project",
    "go.mod",
    "mix.exs",
    "package.json",
    "package.swift",
    "package.yaml",
    "pom.xml",
    "pubspec.yaml",
    "pyproject.toml",
    "setup.py",
];




fn is_module_manifest(path: &str) -> bool {
    let name = basename(path).to_ascii_lowercase();
    MODULE_MANIFESTS.binary_search(&name.as_str()).is_ok()
        || name.ends_with(".csproj")
        || name.ends_with(".fsproj")
        || name.ends_with(".cabal")
        || name.ends_with(".gemspec")
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

    let descriptors = catalog_descriptor::all(files, &children);
    for descriptor in &descriptors {
        if claimed.insert(descriptor.root.clone()) {
            declared.push(Declared {
                name: descriptor.name.clone(),
                root: descriptor.root.clone(),
                declared_by: "catalog-descriptor",
                at: descriptor.at.clone(),
            });
        }
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

    let mut derived = partition(declared, files, nodes, edges, entry_points, code, deployables);
    for project in derived.sub_projects.iter_mut().filter(|project| project.declared_by != "repository-residue") {
        project.published = manifests.iter().any(|(root, manifest)| *root == project.root && publishes_a_package(&children, manifest));
        if project.published && project.status == "module" {
            project.status = "library";
        }
    }
    describe(&mut derived.sub_projects, descriptors);
    declared_consumers(&mut derived.sub_projects, &manifests, &children);
    let shells = platform_shells(&derived.sub_projects, &manifests, &children);
    fold_into_units(&mut derived, shells);
    derived
}

fn describe(sub_projects: &mut [SubProject], descriptors: Vec<Descriptor>) {
    for descriptor in descriptors {
        if let Some(project) = sub_projects.iter_mut().find(|project| project.root == descriptor.root) {
            project.owner = descriptor.owner;
            project.system = descriptor.system;
            project.depends_on = descriptor.depends_on;
        }
    }
}

fn publishes_a_package(children: &HashMap<&str, Vec<&IndexNode>>, manifest: &str) -> bool {
    let Some(document) = children.get(manifest) else { return false };
    let has = |name: &str| document.iter().any(|node| node.name == name);
    match basename(manifest).to_ascii_lowercase().as_str() {
        "pyproject.toml" => {
            has("build-system")
                && document
                    .iter()
                    .filter(|node| node.name == "project")
                    .any(|project| children.get(project.id.as_str()).is_some_and(|inner| inner.iter().any(|node| node.name == "name")))
        }
        "package.json" => has("name") && has("version") && (has("main") || has("exports") || has("module")) && !has("bin") && !has("private"),
        _ => false,
    }
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
    scalar(named)
}

pub fn scalar(node: &IndexNode) -> Option<String> {
    node.type_annotation
        .as_deref()
        .map(|value| value.trim().trim_matches(['"', '\'']).to_string())
        .filter(|value| !value.is_empty())
}




fn is_run_by_what_carries_it(member: &Deployable) -> bool {
    member.declarations.iter().any(|declared| match declared.declares {
        Declares::Ship => true,
        Declares::Run => declared.kind != "cargo-bin",
        Declares::Identity => false,
    })
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

    let enclosed_project = |path: &str| -> Option<usize> {
        let mut directory = directory_of(path);
        while !directory.is_empty() {
            let inside: Vec<usize> = (0..residue).filter(|at| contains(directory, &declared[*at].root)).collect();
            match inside.as_slice() {
                [] => {}
                [only] => return Some(*only),
                _ => return None,
            }
            directory = directory_of(directory);
        }
        None
    };
    let owner = |path: &str| -> Option<usize> {
        let found = order.iter().copied().find(|at| contains(&declared[*at].root, path))?;
        match found == residue {
            true => enclosed_project(path).or(Some(found)),
            false => Some(found),
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
            status: "module",
            ships_in: Vec::new(),
            consumed_by: Vec::new(),
            members: Vec::new(),
            imported_by: Vec::new(),
            published: false,
            test_files: 0,
            code_files: 0,
            owner: None,
            system: None,
            depends_on: Vec::new(),
            display_name: found.name.clone(),
            role: "",
            role_basis: String::new(),
            summary: String::new(),
        })
        .collect();

    for (file, path) in files.iter().enumerate() {
        if let Some(at) = owner(path) {
            sub_projects[at].files += 1;
            if code.get(file).copied().unwrap_or(false) {
                sub_projects[at].code_files += 1;
                if crate::paths::is_test(path) {
                    sub_projects[at].test_files += 1;
                }
            }
        }
    }
    let mut between: HashMap<(usize, usize), u32> = HashMap::default();

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
                    *between.entry((from, to)).or_default() += 1;
                }
                if let Some(to) = to.filter(|_| !crate::paths::is_test(&edge.source)) {
                    let consumer = sub_projects[from].id.clone();
                    if !sub_projects[to].imported_by.contains(&consumer) {
                        sub_projects[to].imported_by.push(consumer.clone());
                    }
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
            if matches!(entry.kind, "lifecycle" | "cli" | "http" | "rpc" | "graphql" | "ui") {
                sub_projects[at].runnable = true;
            }
        }
    }

    let roots: Vec<String> = sub_projects.iter().map(|project| project.root.clone()).collect();
    let deepest_holding = |path: &str| -> Option<usize> {
        roots
            .iter()
            .enumerate()
            .filter(|(_, root)| !root.is_empty() && contains(root, path))
            .max_by_key(|(_, root)| root.len())
            .map(|(at, _)| at)
    };
    let unit_of: HashMap<&str, &Deployable> = deployables.iter().map(|unit| (unit.id.as_str(), unit)).collect();
    for unit in deployables.iter().filter(|unit| unit.shipped) {
        let mut run: HashSet<usize> = HashSet::default();
        for (at, project) in sub_projects.iter().enumerate() {
            let own_root = unit.root == project.root
                && (!project.root.is_empty() || project.declared_by == "repository-root");
            if own_root {
                run.insert(at);
            }
        }
        let mut named: HashSet<usize> = HashSet::default();
        for path in &unit.ships {
            if let Some(at) = deepest_holding(path) {
                named.insert(at);
            }
        }
        match unit.members.is_empty() {
            true => run.extend(named.iter().copied()),
            false => {
                for member in unit.members.iter().filter_map(|member| unit_of.get(member.as_str())) {
                    let Some(at) = deepest_holding(&member.root) else { continue };
                    match is_run_by_what_carries_it(member) {
                        true => run.insert(at),
                        false => named.insert(at),
                    };
                }
            }
        }
        if run.is_empty() {
            run = std::mem::take(&mut named);
        }
        let runners: Vec<String> = {
            let mut ids: Vec<String> = run.iter().map(|at| sub_projects[*at].id.clone()).collect();
            ids.sort();
            ids
        };
        for at in run.iter().copied().chain(named.iter().copied()) {
            let carried = !run.contains(&at);
            let project = &mut sub_projects[at];
            project.ship_backed |= !carried;
            if !project.ships_in.contains(&unit.id) {
                project.ships_in.push(unit.id.clone());
            }
            if carried {
                for runner in &runners {
                    if *runner != project.id && !project.consumed_by.contains(runner) {
                        project.consumed_by.push(runner.clone());
                    }
                }
            }
        }
    }
    for project in sub_projects.iter_mut() {
        project.consumed_by.sort();
        project.ships_in.sort();
        project.status = match (project.ship_backed, project.runnable, !project.consumed_by.is_empty()) {
            (true, _, _) => "deployable",
            (false, true, _) => "executable",
            (false, false, true) => "library",
            (false, false, false) => "module",
        };
    }

    let mut assignment: Vec<(String, String)> = assignment
        .into_iter()
        .map(|(path, at)| (path, sub_projects[at].id.clone()))
        .collect();
    let imports_between: Vec<(String, String, u32)> = between
        .into_iter()
        .map(|((from, to), count)| (sub_projects[from].id.clone(), sub_projects[to].id.clone(), count))
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
        imports_between,
        sub_projects,
        sub_cas_nodes,
        assigned_declarations: assigned,
        shared_declarations: shared,
        unpartitioned_declarations: unpartitioned,
    }
}

const MADE_OF_TESTS: f64 = 0.7;

fn is_made_of_tests(project: &SubProject) -> bool {
    project.code_files > 0 && project.test_files as f64 / project.code_files as f64 >= MADE_OF_TESTS
}

fn unit_of(folded: &HashMap<String, String>, id: &str) -> String {
    let mut current = id.to_string();
    let mut seen: HashSet<String> = HashSet::default();
    while let Some(next) = folded.get(&current) {
        if !seen.insert(current.clone()) {
            break;
        }
        current = next.clone();
    }
    current
}

fn fold(folded: &mut HashMap<String, String>, from: String, into: String) -> bool {
    if from == into || unit_of(folded, &into) == from || folded.contains_key(&from) {
        return false;
    }
    folded.insert(from, into);
    true
}

fn tested_part(project: &SubProject, between: &[(String, String, u32)], by_id: &HashMap<&str, &SubProject>) -> Option<String> {
    let holds_its_tests = |held: &SubProject| !held.published || contains(&held.root, &project.root);
    let mut targets: Vec<(&str, u32)> = between
        .iter()
        .filter(|(from, to, _)| *from == project.id && by_id.get(to.as_str()).is_some_and(|held| !is_made_of_tests(held) && holds_its_tests(held)))
        .map(|(_, to, count)| (to.as_str(), *count))
        .collect();
    if targets.is_empty() {
        targets = by_id
            .values()
            .filter(|held| !is_made_of_tests(held) && holds_its_tests(held) && held.imported_by.contains(&project.id))
            .map(|held| (held.id.as_str(), 0))
            .collect();
    }
    targets.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(right.0)));
    targets.first().map(|(to, _)| to.to_string())
}

fn ships_within(project: &SubProject, host: &SubProject) -> bool {
    project.ships_in.iter().all(|unit| host.ships_in.contains(unit))
}

pub fn fold_into_units(partition: &mut Partition, shells: Vec<(String, String)>) {
    let mut folded: HashMap<String, String> = HashMap::default();
    for (from, into) in shells {
        fold(&mut folded, from, into);
    }
    {
        let by_id: HashMap<&str, &SubProject> = partition.sub_projects.iter().map(|project| (project.id.as_str(), project)).collect();
        for project in partition.sub_projects.iter().filter(|project| !project.root.is_empty() && is_made_of_tests(project)) {
            if let Some(target) = tested_part(project, &partition.imports_between, &by_id) {
                fold(&mut folded, project.id.clone(), target);
            }
        }
        loop {
            let mut found = None;
            for project in &partition.sub_projects {
                if project.root.is_empty() || project.published || folded.contains_key(&project.id) || is_made_of_tests(project) {
                    continue;
                }
                let mut consumers: Vec<String> = project
                    .imported_by
                    .iter()
                    .filter(|consumer| by_id.get(consumer.as_str()).is_some_and(|held| !is_made_of_tests(held)))
                    .map(|consumer| unit_of(&folded, consumer))
                    .filter(|consumer| *consumer != project.id)
                    .collect();
                consumers.sort();
                consumers.dedup();
                let [host] = consumers.as_slice() else { continue };
                let Some(held) = by_id.get(host.as_str()) else { continue };
                if ships_within(project, held) && unit_of(&folded, host) != project.id {
                    found = Some((project.id.clone(), host.clone()));
                    break;
                }
            }
            let Some((from, to)) = found else { break };
            if !fold(&mut folded, from, to) {
                break;
            }
        }
    }
    if folded.is_empty() {
        return;
    }
    let units: HashMap<String, String> = folded
        .keys()
        .map(|id| (id.clone(), unit_of(&folded, id)))
        .filter(|(id, unit)| id != unit)
        .collect();
    let mut absorbed: Vec<SubProject> = Vec::new();
    let mut kept: Vec<SubProject> = Vec::new();
    for project in partition.sub_projects.drain(..) {
        match units.contains_key(&project.id) {
            true => absorbed.push(project),
            false => kept.push(project),
        }
    }
    for member in absorbed {
        let host_id = &units[&member.id];
        let Some(host) = kept.iter_mut().find(|project| project.id == *host_id) else { continue };
        host.files += member.files;
        host.test_files += member.test_files;
        host.code_files += member.code_files;
        host.declarations += member.declarations;
        host.entry_points += member.entry_points;
        host.imports_within += member.imports_within;
        host.runnable |= member.runnable;
        host.ship_backed |= member.ship_backed;
        for unit in member.ships_in {
            if !host.ships_in.contains(&unit) {
                host.ships_in.push(unit);
            }
        }
        host.members.push(member.root);
        host.members.extend(member.members);
    }
    for project in kept.iter_mut() {
        let own = project.id.clone();
        let mut consumers: Vec<String> = project
            .consumed_by
            .iter()
            .map(|consumer| units.get(consumer).cloned().unwrap_or_else(|| consumer.clone()))
            .filter(|consumer| *consumer != own)
            .collect();
        consumers.sort();
        consumers.dedup();
        project.consumed_by = consumers;
        project.members.sort();
        project.ships_in.sort();
    }
    for (_, id) in partition.assignment.iter_mut() {
        if let Some(unit) = units.get(id.as_str()) {
            *id = unit.clone();
        }
    }
    let mut between: HashMap<(String, String), u32> = HashMap::default();
    for (from, to, count) in partition.imports_between.drain(..) {
        let from = units.get(&from).cloned().unwrap_or(from);
        let to = units.get(&to).cloned().unwrap_or(to);
        if from != to {
            *between.entry((from, to)).or_default() += count;
        }
    }
    partition.imports_between = between.into_iter().map(|((from, to), count)| (from, to, count)).collect();
    partition.sub_projects = kept;
    partition.sub_cas_nodes.qualified = partition.sub_projects.len() as u32;
    partition.sub_cas_nodes.promoted = partition.sub_projects.len() >= PROMOTION_THRESHOLD;
}

static DEPENDENCY_SECTIONS: &[&str] = &["dependencies", "optionalDependencies", "peerDependencies"];

fn descendants<'a>(children: &HashMap<&'a str, Vec<&'a IndexNode>>, id: &str) -> Vec<&'a IndexNode> {
    let mut found = Vec::new();
    let mut pending: Vec<&IndexNode> = children.get(id).cloned().unwrap_or_default();
    while let Some(node) = pending.pop() {
        found.push(node);
        if let Some(inner) = children.get(node.id.as_str()) {
            pending.extend(inner.iter().copied());
        }
    }
    found
}

fn depended_names<'a>(children: &HashMap<&'a str, Vec<&'a IndexNode>>, manifest: &str) -> Vec<String> {
    let Some(document) = children.get(manifest) else { return Vec::new() };
    document
        .iter()
        .filter(|node| DEPENDENCY_SECTIONS.contains(&node.name.as_str()))
        .flat_map(|section| children.get(section.id.as_str()).cloned().unwrap_or_default())
        .map(|dependency| dependency.name.clone())
        .collect()
}

fn referenced_projects<'a>(children: &HashMap<&'a str, Vec<&'a IndexNode>>, manifest: &str) -> Vec<String> {
    let folder = directory_of(manifest);
    descendants(children, manifest)
        .into_iter()
        .filter(|node| node.name == "ProjectReference")
        .filter_map(|reference| children.get(reference.id.as_str())?.iter().find(|attribute| attribute.name == "Include").and_then(|attribute| scalar(attribute)))
        .map(|written| directory_of(&crate::paths::join(folder, &written.replace('\\', "/"))).to_string())
        .collect()
}

fn declared_consumers(sub_projects: &mut [SubProject], manifests: &[(String, String)], children: &HashMap<&str, Vec<&IndexNode>>) {
    let by_name: HashMap<String, usize> = sub_projects
        .iter()
        .enumerate()
        .filter(|(_, project)| !project.root.is_empty())
        .map(|(at, project)| (project.name.clone(), at))
        .collect();
    let by_root: HashMap<String, usize> = sub_projects.iter().enumerate().map(|(at, project)| (project.root.clone(), at)).collect();
    let mut found: Vec<(usize, String)> = Vec::new();
    for (consumer, project) in sub_projects.iter().enumerate() {
        for (_, manifest) in manifests.iter().filter(|(root, _)| *root == project.root) {
            for name in depended_names(children, manifest) {
                if let Some(at) = by_name.get(&name).filter(|at| **at != consumer) {
                    found.push((*at, sub_projects[consumer].id.clone()));
                }
            }
            for root in referenced_projects(children, manifest) {
                if let Some(at) = by_root.get(&root).filter(|at| **at != consumer) {
                    found.push((*at, sub_projects[consumer].id.clone()));
                }
            }
        }
    }
    for (at, consumer) in found {
        let project = &mut sub_projects[at];
        if !project.imported_by.contains(&consumer) {
            project.imported_by.push(consumer.clone());
        }
        if !project.consumed_by.contains(&consumer) {
            project.consumed_by.push(consumer);
        }
    }
}

static PLATFORM_SHELLS: &str = include_str!("../data/platform_shells.tsv");

fn shell_folders(framework: &str) -> Vec<&'static str> {
    PLATFORM_SHELLS
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .filter(|(named, _)| *named == framework)
        .flat_map(|(_, folders)| folders.split(','))
        .collect()
}

fn platform_shells(sub_projects: &[SubProject], manifests: &[(String, String)], children: &HashMap<&str, Vec<&IndexNode>>) -> Vec<(String, String)> {
    let mut found = Vec::new();
    for outer in sub_projects.iter().filter(|project| !project.root.is_empty()) {
        let folders: Vec<&str> = manifests
            .iter()
            .filter(|(root, _)| *root == outer.root)
            .flat_map(|(_, manifest)| depended_names(children, manifest))
            .flat_map(|framework| shell_folders(&framework))
            .collect();
        if folders.is_empty() {
            continue;
        }
        for inner in sub_projects.iter().filter(|project| project.id != outer.id) {
            let held = folders.iter().any(|folder| {
                let shell = format!("{}/{folder}", outer.root);
                inner.root == shell || inner.root.starts_with(&format!("{shell}/"))
            });
            if held {
                found.push((inner.id.clone(), outer.id.clone()));
            }
        }
    }
    found
}

#[cfg(test)]
mod folding {
    use super::*;

    #[test]
    fn a_cycle_of_folds_ends_instead_of_looping() {
        let mut folded: HashMap<String, String> = HashMap::default();
        assert!(fold(&mut folded, "a".to_string(), "b".to_string()));
        assert!(!fold(&mut folded, "b".to_string(), "a".to_string()));
        folded.insert("b".to_string(), "a".to_string());
        let unit = unit_of(&folded, "a");
        assert!(unit == "a" || unit == "b");
    }
}
