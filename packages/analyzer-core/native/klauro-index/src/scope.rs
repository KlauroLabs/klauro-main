use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::entry_exit::EntryPoint;
use crate::model::*;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Declares {
    Identity,
    Run,
    Ship,
}

#[derive(Debug, Serialize)]
pub struct Declaration {
    pub declares: Declares,
    pub kind: &'static str,
    pub at: String,
}

#[derive(Debug, Serialize)]
pub struct Deployable {
    pub id: String,
    pub name: String,
    pub root: String,
    pub declarations: Vec<Declaration>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ships: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runs: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundled_into: Option<String>,
    pub shipped: bool,
    pub units: u32,
    pub entry_points: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reaches: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Scope {
    pub deployables: Vec<Deployable>,
    pub assigned_nodes: u32,
    pub shared_nodes: u32,
    pub unassigned_nodes: u32,
}

struct Candidate {
    name: String,
    root: String,
    declarations: Vec<Declaration>,
    ships: Vec<String>,
    runs: Option<String>,
}

impl Candidate {
    fn strongest(&self) -> Declares {
        self.declarations
            .iter()
            .map(|declaration| declaration.declares)
            .max()
            .unwrap_or(Declares::Identity)
    }
}

fn directory_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(at) => &path[..at],
        None => "",
    }
}

fn normalize(root: &str, relative: &str) -> String {
    let joined = if relative.starts_with('/') || root.is_empty() {
        relative.trim_start_matches('/').to_string()
    } else {
        format!("{root}/{relative}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
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

fn unquote(value: &str) -> &str {
    value.trim().trim_matches(['"', '\''])
}

fn common_ancestor(paths: &[String]) -> String {
    let Some(first) = paths.first() else {
        return String::new();
    };
    let mut shared: Vec<&str> = first.split('/').collect();
    for path in paths.iter().skip(1) {
        let parts: Vec<&str> = path.split('/').collect();
        let keep = shared
            .iter()
            .zip(parts.iter())
            .take_while(|(left, right)| left == right)
            .count();
        shared.truncate(keep);
    }
    if shared.len() == first.split('/').count() && !first.contains('/') {
        return String::new();
    }
    shared.join("/")
}

fn display_name(root: &str) -> String {
    match root.rsplit('/').next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => "root".to_string(),
    }
}

struct Files<'a> {
    paths: Vec<&'a str>,
    children: HashMap<&'a str, Vec<&'a IndexNode>>,
}

impl<'a> Files<'a> {
    fn build(files: &'a [String], nodes: &'a [IndexNode]) -> Self {
        let mut children: HashMap<&str, Vec<&IndexNode>> = HashMap::new();
        for node in nodes {
            if let Some(parent) = node.parent.as_deref() {
                children.entry(parent).or_default().push(node);
            }
        }
        Files {
            paths: files.iter().map(String::as_str).collect(),
            children,
        }
    }

    fn of(&self, path: &str) -> Option<&Vec<&'a IndexNode>> {
        self.children.get(path)
    }

    fn child(&self, parent: &str, name: &str) -> Option<&'a IndexNode> {
        self.children
            .get(parent)?
            .iter()
            .find(|node| node.name == name)
            .copied()
    }
}

static CONTAINER_RUNNERS: &[&str] = &["CMD", "ENTRYPOINT"];

impl<'a> Files<'a> {
    fn holds(&self, path: &str) -> bool {
        if path.is_empty() {
            return true;
        }
        self.paths.iter().any(|known| contains(path, known))
    }
}

fn container(files: &Files, path: &str, context: &str) -> Option<Candidate> {
    let stages = files.of(path)?;
    let root = context.to_string();
    let mut ships = Vec::new();
    let mut runs = None;
    for stage in stages {
        let Some(members) = files.of(&stage.id) else { continue };
        let runner = members
            .iter()
            .find(|member| CONTAINER_RUNNERS.contains(&member.name.as_str()));
        if let Some(runner) = runner {
            runs = runner.type_annotation.clone();
        }
        for member in members {
            if member.type_annotation.as_deref() == Some("COPY")
                || member.type_annotation.as_deref() == Some("ADD")
            {
                let shipped = normalize(&root, &member.name);
                if files.holds(&shipped) {
                    ships.push(shipped);
                }
            }
        }
    }
    runs.as_ref()?;
    ships.sort();
    ships.dedup();
    let context = common_ancestor(&ships);
    Some(Candidate {
        name: display_name(&context),
        root: context,
        declarations: vec![Declaration {
            declares: Declares::Ship,
            kind: "container",
            at: path.to_string(),
        }],
        ships,
        runs,
    })
}

fn compose(files: &Files, path: &str) -> Vec<Candidate> {
    let Some(document) = files.of(path) else {
        return Vec::new();
    };
    let Some(services) = document.iter().find(|node| node.name == "services") else {
        return Vec::new();
    };
    let Some(defined) = files.of(&services.id) else {
        return Vec::new();
    };
    let root = directory_of(path).to_string();
    defined
        .iter()
        .filter_map(|service| {
            let context = files
                .child(&service.id, "build")
                .and_then(|node| {
                    node.type_annotation
                        .clone()
                        .or_else(|| files.child(&node.id, "context")?.type_annotation.clone())
                })
                .map(|context| normalize(&root, unquote(&context)))?;
            Some(Candidate {
                name: service.name.clone(),
                root: context.clone(),
                declarations: vec![Declaration {
                    declares: Declares::Ship,
                    kind: "compose-service",
                    at: format!("{path}:{}", service.span.line),
                }],
                ships: vec![context],
                runs: files
                    .child(&service.id, "command")
                    .and_then(|node| node.type_annotation.clone()),
            })
        })
        .collect()
}

static DEPLOY_MANIFESTS: &[(&str, &str)] = &[
    ("fly.toml", "fly"),
    ("vercel.json", "vercel"),
    ("now.json", "vercel"),
    ("netlify.toml", "netlify"),
    ("serverless.yml", "serverless"),
    ("serverless.yaml", "serverless"),
    ("app.yaml", "app-engine"),
    ("procfile", "procfile"),
    ("render.yaml", "render"),
    ("railway.json", "railway"),
];

fn deploy_manifest(path: &str) -> Option<Candidate> {
    let basename = path.rsplit('/').next()?.to_ascii_lowercase();
    let (_, kind) = DEPLOY_MANIFESTS
        .iter()
        .find(|(name, _)| *name == basename)?;
    let root = directory_of(path).to_string();
    Some(Candidate {
        name: display_name(&root),
        root,
        declarations: vec![Declaration {
            declares: Declares::Ship,
            kind,
            at: path.to_string(),
        }],
        ships: Vec::new(),
        runs: None,
    })
}

fn node_manifest(files: &Files, path: &str) -> Option<Candidate> {
    let document = files.of(path)?;
    let root = directory_of(path).to_string();
    let named = document
        .iter()
        .find(|node| node.name == "name")
        .and_then(|node| node.type_annotation.clone())
        .map(|name| unquote(&name).to_string())
        .unwrap_or_else(|| display_name(&root));

    let mut declarations = Vec::new();
    let mut runs = None;
    if let Some(binaries) = document.iter().find(|node| node.name == "bin") {
        declarations.push(Declaration {
            declares: Declares::Run,
            kind: "package-bin",
            at: format!("{path}:{}", binaries.span.line),
        });
        runs = binaries.type_annotation.clone();
    }
    if let Some(scripts) = document.iter().find(|node| node.name == "scripts")
        && let Some(start) = files.child(&scripts.id, "start")
    {
        declarations.push(Declaration {
            declares: Declares::Run,
            kind: "start-script",
            at: format!("{path}:{}", start.span.line),
        });
        runs = runs.or_else(|| start.type_annotation.clone());
    }
    if document.iter().any(|node| node.name == "workspaces") {
        return None;
    }
    declarations.push(Declaration {
        declares: Declares::Identity,
        kind: "package-identity",
        at: path.to_string(),
    });
    Some(Candidate { name: named, root, declarations, ships: Vec::new(), runs })
}

fn cargo_manifest(files: &Files, path: &str) -> Option<Candidate> {
    let document = files.of(path)?;
    let root = directory_of(path).to_string();
    if document.iter().any(|node| node.name == "workspace")
        && !document.iter().any(|node| node.name == "package")
    {
        return None;
    }
    let named = document
        .iter()
        .find(|node| node.name == "package")
        .and_then(|package| files.child(&package.id, "name"))
        .and_then(|node| node.type_annotation.clone())
        .map(|name| name.trim_matches('"').to_string())
        .unwrap_or_else(|| display_name(&root));

    let mut declarations = Vec::new();
    for binary in document.iter().filter(|node| node.name == "bin") {
        declarations.push(Declaration {
            declares: Declares::Run,
            kind: "cargo-bin",
            at: format!("{path}:{}", binary.span.line),
        });
    }
    declarations.push(Declaration {
        declares: Declares::Identity,
        kind: "package-identity",
        at: path.to_string(),
    });
    Some(Candidate { name: named, root, declarations, ships: Vec::new(), runs: None })
}

static INSTALLER_SUFFIXES: &[&str] = &[".bat", ".cmd", ".iss", ".nsi", ".ps1", ".sh"];

fn installer(files: &Files, path: &str, sources: &HashSet<&str>) -> Option<Candidate> {
    let basename = path.rsplit('/').next()?.to_ascii_lowercase();
    if !basename.starts_with("install") {
        return None;
    }
    if !INSTALLER_SUFFIXES
        .iter()
        .any(|suffix| basename.ends_with(suffix))
    {
        return None;
    }
    let root = directory_of(path).to_string();
    let ships: Vec<String> = files
        .of(path)?
        .iter()
        .filter(|node| node.kind == NodeKind::Function)
        .filter_map(|node| sources.get(node.name.as_str()).map(|found| (*found).to_string()))
        .collect();
    Some(Candidate {
        name: display_name(&root),
        root,
        declarations: vec![Declaration {
            declares: Declares::Ship,
            kind: "installer",
            at: path.to_string(),
        }],
        ships,
        runs: None,
    })
}

static WORKSPACE_MANIFESTS: &[&str] = &[
    "lerna.json",
    "nx.json",
    "pnpm-workspace.yaml",
    "rush.json",
    "turbo.json",
];

fn is_workspace_container(files: &Files, path: &str) -> bool {
    let directory = directory_of(path);
    files.paths.iter().any(|other| {
        directory_of(other) == directory
            && WORKSPACE_MANIFESTS
                .binary_search(&other.rsplit('/').next().unwrap_or(other))
                .is_ok()
    })
}

fn reached_files<'a>(
    owned: impl Iterator<Item = &'a str>,
    imports: &HashMap<&'a str, Vec<&'a str>>,
) -> HashSet<&'a str> {
    let mut seen: HashSet<&str> = owned.collect();
    let mut frontier: Vec<&str> = seen.iter().copied().collect();
    while let Some(current) = frontier.pop() {
        let Some(targets) = imports.get(current) else { continue };
        for target in targets {
            if seen.insert(target) {
                frontier.push(target);
            }
        }
    }
    seen
}

pub fn derive(
    files: &[String],
    kinds: &[bool],
    code: &[bool],
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    entry_points: &[EntryPoint],
) -> Scope {
    let index = Files::build(files, nodes);
    let sources: HashSet<&str> = files.iter().map(String::as_str).collect();
    let mut candidates: Vec<Candidate> = Vec::new();

    for (at, path) in index.paths.iter().enumerate() {
        if !kinds.get(at).copied().unwrap_or(false) {
            continue;
        }
        let basename = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
        if crate::dockerfile::is_dockerfile(path) {
            candidates.extend(container(&index, path, ""));
            continue;
        }
        if basename.contains("compose") && basename.ends_with(".yml")
            || basename.contains("compose") && basename.ends_with(".yaml")
        {
            candidates.extend(compose(&index, path));
            continue;
        }
        if let Some(found) = deploy_manifest(path) {
            candidates.push(found);
            continue;
        }
        if basename == "package.json" {
            if !is_workspace_container(&index, path) {
                candidates.extend(node_manifest(&index, path));
            }
            continue;
        }
        if basename == "cargo.toml" {
            candidates.extend(cargo_manifest(&index, path));
            continue;
        }
        if let Some(found) = installer(&index, path, &sources) {
            candidates.push(found);
        }
    }

    consolidate(candidates, nodes, edges, entry_points, code)
}

fn consolidate(
    mut candidates: Vec<Candidate>,
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    entry_points: &[EntryPoint],
    code: &[bool],
) -> Scope {
    candidates.sort_by(|left, right| {
        right
            .strongest()
            .cmp(&left.strongest())
            .then(left.root.cmp(&right.root))
    });

    let mut deployables: Vec<Deployable> = Vec::new();
    let mut by_root: HashMap<String, usize> = HashMap::new();
    for candidate in candidates {
        let shipped = candidate.strongest() == Declares::Ship;
        if let Some(at) = by_root.get(&candidate.root).copied() {
            let identifies = candidate
                .declarations
                .iter()
                .any(|found| found.kind == "package-identity");
            let unit = &mut deployables[at];
            let unnamed = unit
                .declarations
                .iter()
                .all(|found| found.kind != "package-identity");
            unit.declarations.extend(candidate.declarations);
            unit.ships.extend(candidate.ships);
            unit.runs = unit.runs.take().or(candidate.runs);
            unit.shipped |= shipped;
            if unnamed && identifies {
                unit.name = candidate.name;
            }
            continue;
        }
        by_root.insert(candidate.root.clone(), deployables.len());
        deployables.push(Deployable {
            id: format!("deployable:{}", candidate.root),
            name: candidate.name,
            root: candidate.root,
            shipped,
            declarations: candidate.declarations,
            ships: candidate.ships,
            runs: candidate.runs,
            members: Vec::new(),
            bundled_into: None,
            units: 0,
            entry_points: 0,
            reaches: Vec::new(),
        });
    }
    for unit in deployables.iter_mut() {
        unit.declarations.sort_by(|left, right| {
            right.declares.cmp(&left.declares).then(left.at.cmp(&right.at))
        });
        unit.declarations.dedup_by(|left, right| left.at == right.at && left.kind == right.kind);
        unit.ships.sort();
        unit.ships.dedup();
    }

    let shipped: Vec<(usize, Vec<String>)> = deployables
        .iter()
        .enumerate()
        .filter(|(_, unit)| unit.shipped)
        .map(|(at, unit)| (at, unit.ships.clone()))
        .collect();

    for at in 0..deployables.len() {
        if deployables[at].shipped {
            continue;
        }
        let root = deployables[at].root.clone();
        let bundle = shipped.iter().find(|(other, ships)| {
            *other != at && ships.iter().any(|path| contains(path, &root))
        });
        if let Some((owner, _)) = bundle {
            let owner_id = deployables[*owner].id.clone();
            let member_id = deployables[at].id.clone();
            deployables[at].bundled_into = Some(owner_id);
            deployables[*owner].members.push(member_id);
        }
    }

    let territory = Territory::of(
        deployables
            .iter()
            .enumerate()
            .filter(|(_, unit)| unit.bundled_into.is_none())
            .map(|(at, unit)| (unit.root.clone(), at))
            .collect(),
    );

    let mut imports: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in edges {
        if edge.kind == EdgeKind::Imports {
            imports
                .entry(edge.source.as_str())
                .or_default()
                .push(edge.target.as_str());
        }
    }

    let owned: Vec<HashSet<&str>> = deployables
        .iter()
        .map(|unit| {
            let root = unit.root.as_str();
            reached_files(
                nodes
                    .iter()
                    .filter(|node| node.kind == NodeKind::Module)
                    .map(|node| node.id.as_str())
                    .filter(|path| contains(root, path)),
                &imports,
            )
        })
        .collect();

    let mut reach: HashMap<&str, Vec<usize>> = HashMap::new();
    for (at, unit) in deployables.iter().enumerate() {
        if unit.bundled_into.is_some() {
            continue;
        }
        for path in &owned[at] {
            reach.entry(path).or_default().push(at);
        }
    }

    let mut assigned = 0;
    let mut shared = 0;
    let mut unassigned = 0;
    for node in nodes {
        if !code.get(node.file as usize).copied().unwrap_or(false) {
            continue;
        }
        let path = file_of(node);
        match territory.owner(path) {
            Some(at) => {
                deployables[at].units += 1;
                assigned += 1;
            }
            None => match reach.get(path).map(Vec::as_slice) {
                Some([only]) => {
                    deployables[*only].units += 1;
                    assigned += 1;
                }
                Some(several) if !several.is_empty() => {
                    for at in several {
                        deployables[*at].units += 1;
                    }
                    shared += 1;
                }
                _ => unassigned += 1,
            },
        }
    }
    for entry in entry_points {
        if let Some(at) = territory.owner(file_of_id(&entry.handler)) {
            deployables[at].entry_points += 1;
        }
    }

    deployables.sort_by(|left, right| left.id.cmp(&right.id));
    Scope {
        deployables,
        assigned_nodes: assigned,
        shared_nodes: shared,
        unassigned_nodes: unassigned,
    }
}

fn file_of(node: &IndexNode) -> &str {
    file_of_id(&node.id)
}

fn file_of_id(id: &str) -> &str {
    match id.find(':') {
        Some(at) => &id[..at],
        None => id,
    }
}

fn contains(root: &str, path: &str) -> bool {
    if root.is_empty() {
        return true;
    }
    path.len() > root.len()
        && path.as_bytes()[root.len()] == b'/'
        && path.starts_with(root)
        || path == root
}

struct Territory {
    roots: Vec<(String, usize)>,
}

impl Territory {
    fn of(roots: Vec<(String, usize)>) -> Self {
        let mut roots = roots;
        roots.sort_by(|left, right| right.0.len().cmp(&left.0.len()));
        Territory { roots }
    }

    fn owner(&self, path: &str) -> Option<usize> {
        self.roots
            .iter()
            .find(|(root, _)| contains(root, path))
            .map(|(_, at)| *at)
    }
}
