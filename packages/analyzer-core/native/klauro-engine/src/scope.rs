use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use serde::Serialize;

use crate::entry_exit::EntryPoint;
use crate::model::*;
use crate::paths::{contains, directory_of, display_name, file_of, join};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Declares {
    Identity,
    Run,
    Ship,
}

impl Declares {
    fn category(self) -> &'static str {
        match self {
            Declares::Identity => "library",
            Declares::Run => "runnable",
            Declares::Ship => "shipped",
        }
    }
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
    pub category: &'static str,
    pub declarations: Vec<Declaration>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ships: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runs: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundled_into: Option<String>,
    #[serde(skip)]
    pub offered_to_others: bool,
    #[serde(skip)]
    pub consumers: u32,
    #[serde(skip)]
    pub shipped: bool,
    pub units: u32,
    pub entry_points: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub entered_at: Vec<String>,
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


struct Files<'a> {
    paths: Vec<&'a str>,
    children: HashMap<&'a str, Vec<&'a IndexNode>>,
}

impl<'a> Files<'a> {
    fn build(files: &'a [String], nodes: &'a [IndexNode]) -> Self {
        let mut children: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
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

    fn descendants(&self, path: &str) -> Vec<&'a IndexNode> {
        let mut found = Vec::new();
        let mut pending = vec![path];
        while let Some(at) = pending.pop() {
            for node in self.children.get(at).into_iter().flatten() {
                found.push(*node);
                pending.push(node.id.as_str());
            }
        }
        found
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
                let shipped = join(&root, &member.name);
                if files.holds(&shipped) {
                    ships.push(shipped);
                }
            }
        }
    }
    runs.as_ref()?;
    ships.sort();
    ships.dedup();
    let home = match ships.is_empty() {
        true => directory_of(path).to_string(),
        false => common_ancestor(&ships),
    };
    Some(Candidate {
        name: display_name(&home),
        root: home,
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
                .map(|context| join(&root, unquote(&context)))?;
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

static MODULE_MANIFESTS: &[&str] = &[
    "build.gradle",
    "build.gradle.kts",
    "build.sbt",
    "cmakelists.txt",
    "composer.json",
    "go.mod",
    "mix.exs",
    "package.swift",
    "pom.xml",
    "project.toml",
    "pyproject.toml",
    "setup.py",
];

static A_REGISTRY_ASKS_FOR: &[(&str, &[&[&str]])] =
    &[("Cargo.toml", &[&["description"], &["license", "license-file"]])];

fn ready_to_be_published(files: &Files, manifest: &str) -> bool {
    let within: Vec<&IndexNode> = files
        .descendants(manifest)
        .into_iter()
        .filter(|node| {
            node.parent
                .as_deref()
                .is_none_or(|parent| parent == manifest || crate::stable_ids::names(parent, "section", "package"))
        })
        .collect();
    fn said(node: &IndexNode) -> &str {
        node.type_annotation.as_deref().unwrap_or_default().trim()
    }
    let kept_back = within.iter().any(|node| match node.name.as_str() {
        "publish" => matches!(said(node), "false" | "[]"),
        "private" => said(node) == "true",
        _ => false,
    });
    if kept_back {
        return false;
    }
    let carries = |key: &str| {
        within.iter().any(|node| {
            node.name == key || node.name.strip_prefix(key).is_some_and(|rest| rest.starts_with('.'))
        })
    };
    let basename = manifest.rsplit('/').next().unwrap_or(manifest);
    A_REGISTRY_ASKS_FOR
        .iter()
        .find(|(named, _)| *named == basename)
        .is_none_or(|(_, asked)| asked.iter().all(|any_of| any_of.iter().any(|key| carries(key))))
}

fn names_a_package(files: &Files, path: &str, basename: &str) -> bool {
    if basename != "project.toml" {
        return true;
    }
    files
        .of(path)
        .is_some_and(|document| document.iter().any(|node| node.name == "name"))
}

fn beside(root: &str, held: &str) -> String {
    let mut parts: Vec<&str> = match root.is_empty() {
        true => Vec::new(),
        false => root.split('/').collect(),
    };
    for step in held.split('/') {
        match step {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            held => parts.push(held),
        }
    }
    parts.join("/")
}

fn built_into(files: &Files, manifest: &str, root: &str) -> Vec<String> {
    let mut held = Vec::new();
    for node in files.descendants(manifest).into_iter().filter(|node| node.name == "ProjectReference") {
        let Some(included) = files.child(&node.id, "Include").and_then(|found| found.type_annotation.as_deref()) else {
            continue;
        };
        let included = included.trim_matches('"').replace('\\', "/");
        let project = directory_of(&included);
        if !project.is_empty() {
            held.push(beside(directory_of(manifest), project));
        }
    }
    for node in files.descendants(manifest) {
        let Some(path) = files.child(&node.id, "path") else { continue };
        let Some(value) = path.type_annotation.as_deref() else { continue };
        let value = value.trim_matches('"');
        if value.is_empty() {
            continue;
        }
        held.push(beside(root, value));
    }
    held.sort();
    held.dedup();
    held
}

static GRADLE_PUBLISHING: &[&str] = &["mavenPublishing", "publishing"];
static PACKED_FOR_OTHERS: &[&str] = &["GeneratePackageOnBuild", "IsPackable", "PackageId"];

fn packed_for_others(files: &Files, manifest: &str) -> bool {
    files.descendants(manifest).iter().any(|node| {
        PACKED_FOR_OTHERS.contains(&node.name.as_str())
            && node.type_annotation.as_deref().is_none_or(|said| !said.trim().eq_ignore_ascii_case("false"))
    })
}

fn gradle_publishes(calls: &[CallFact], file: u32) -> bool {
    calls.iter().any(|call| call.file == file && GRADLE_PUBLISHING.contains(&call.callee.as_str()))
        || applies_plugin(calls, file, "publish")
        || applies_plugin(calls, file, "maven-publish")
}

fn gradle_key(path: &str) -> String {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| segment.chars().filter(|held| *held != '-' && *held != '_').collect::<String>().to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join("/")
}

fn gradle_build_root<'a>(files: &Files, manifest: &'a str) -> &'a str {
    let mut directory = directory_of(manifest);
    loop {
        let settles = ["settings.gradle", "settings.gradle.kts"].iter().any(|named| {
            let held = match directory.is_empty() {
                true => named.to_string(),
                false => format!("{directory}/{named}"),
            };
            files.holds(&held)
        });
        if settles {
            return directory;
        }
        match directory.rfind('/') {
            Some(at) => directory = &directory[..at],
            None if !directory.is_empty() => directory = "",
            None => return directory,
        }
    }
}

fn gradle_projects(files: &Files, manifest: &str, file: u32, calls: &[CallFact]) -> Vec<String> {
    if !manifest.rsplit('/').next().is_some_and(|named| named.starts_with("build.gradle")) {
        return Vec::new();
    }
    let build_root = gradle_build_root(files, manifest);
    let mut held = Vec::new();
    for call in calls.iter().filter(|call| call.file == file) {
        for literal in &call.literals {
            let written = literal.trim().trim_start_matches('(').trim_end_matches(')').trim();
            let relative = match written.strip_prefix("projects.") {
                Some(accessor) => Some(accessor.replace('.', "/")),
                None if call.callee == "project" => {
                    let named = unquote(written);
                    named.strip_prefix(':').map(|path| path.replace(':', "/"))
                }
                None => None,
            };
            let Some(relative) = relative else { continue };
            let joined = match build_root.is_empty() {
                true => relative,
                false => format!("{build_root}/{relative}"),
            };
            held.push(gradle_key(&joined));
        }
    }
    held.sort();
    held.dedup();
    held
}

fn module_manifest(files: &Files, path: &str, runnable: &HashSet<&str>) -> Option<Candidate> {
    let basename = path.rsplit('/').next()?.to_ascii_lowercase();
    let known = MODULE_MANIFESTS.binary_search(&basename.as_str()).is_ok()
        || basename.ends_with(".csproj")
        || basename.ends_with(".fsproj")
        || basename.ends_with(".cabal")
        || basename.ends_with(".gemspec");
    if !known || !names_a_package(files, path, &basename) {
        return None;
    }
    let root = directory_of(path).to_string();
    let mut declarations = vec![Declaration {
        declares: Declares::Identity,
        kind: "package-identity",
        at: path.to_string(),
    }];
    if runnable.contains(root.as_str()) {
        declarations.push(Declaration {
            declares: Declares::Run,
            kind: "runnable-module",
            at: path.to_string(),
        });
    }
    Some(Candidate {
        name: display_name(&root),
        root,
        declarations,
        ships: Vec::new(),
        runs: None,
    })
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

static LAUNCHER: &str = "android.intent.category.LAUNCHER";
static EXECUTABLE_SDKS: &[&str] =
    &["Aspire.AppHost.Sdk", "Microsoft.NET.Sdk.Web", "Microsoft.NET.Sdk.Worker"];
static EXECUTABLE_OUTPUTS: &[&str] = &["Exe", "WinExe"];
static EXECUTABLE_PLUGINS: &[&str] = &["application", "com.android.application"];
static APPLICATION_BLOCKS: &[&str] = &["application", "nativeDistributions"];

fn plugin_named(value: &str) -> &str {
    unquote(value.trim().trim_start_matches('(').trim_end_matches(')').trim())
}

fn applies_plugin(calls: &[CallFact], file: u32, suffix: &str) -> bool {
    calls.iter().any(|call| {
        call.file == file
            && call.callee == "id"
            && call.literals.iter().any(|value| {
                let plugin = plugin_named(value);
                plugin == suffix || plugin.ends_with(&format!(".{suffix}")) || plugin.ends_with(&format!("-{suffix}"))
            })
    })
}
static PACKAGED_ARTIFACTS: &[&str] = &["ear", "war"];

fn build_target(files: &Files, path: &str, calls: &[CallFact], file: u32) -> Option<&'static str> {
    if crate::paths::is_test(path) {
        return None;
    }
    let basename = path.rsplit('/').next()?.to_ascii_lowercase();
    if basename == "androidmanifest.xml" {
        return files
            .descendants(path)
            .iter()
            .any(|node| node.type_annotation.as_deref().is_some_and(|text| text.contains(LAUNCHER)))
            .then_some("android-application");
    }
    if basename.ends_with(".csproj") || basename.ends_with(".fsproj") {
        let document = files.descendants(path);
        let sdk = document.iter().any(|node| {
            node.type_annotation
                .as_deref()
                .is_some_and(|text| EXECUTABLE_SDKS.iter().any(|sdk| text.contains(sdk)))
        });
        let output = document.iter().any(|node| {
            node.name == "OutputType"
                && node
                    .type_annotation
                    .as_deref()
                    .is_some_and(|text| EXECUTABLE_OUTPUTS.iter().any(|kind| text.contains(kind)))
        });
        return (sdk || output).then_some("dotnet-executable");
    }
    if basename.starts_with("build.gradle") {
        let plugin = calls.iter().any(|call| {
            call.file == file
                && call.callee == "id"
                && call.literals.iter().any(|value| EXECUTABLE_PLUGINS.contains(&plugin_named(value)))
        });
        let block = calls
            .iter()
            .any(|call| call.file == file && APPLICATION_BLOCKS.contains(&call.callee.as_str()));
        return (plugin || block || applies_plugin(calls, file, "application")).then_some("gradle-application");
    }
    if basename == "pom.xml" {
        let document = files.descendants(path);
        return document
            .iter()
            .any(|node| {
                node.name == "packaging"
                    && node.type_annotation.as_deref().is_some_and(|text| {
                        PACKAGED_ARTIFACTS.contains(&text.trim())
                    })
            })
            .then_some("maven-artifact");
    }
    None
}

static INSTALLER_SUFFIXES: &[&str] = &[".bat", ".cmd", ".iss", ".nsi", ".ps1", ".sh"];

fn installer(
    files: &Files,
    path: &str,
    calls: &[CallFact],
    file: u32,
) -> Option<Candidate> {
    let basename = path.rsplit('/').next()?.to_ascii_lowercase();
    if !basename.starts_with("install") || crate::paths::is_continuous_integration(path) {
        return None;
    }
    if !INSTALLER_SUFFIXES
        .iter()
        .any(|suffix| basename.ends_with(suffix))
    {
        return None;
    }
    let root = directory_of(path).to_string();
    let mut ships: Vec<String> = calls
        .iter()
        .filter(|call| call.file == file)
        .flat_map(|call| call.literals.iter())
        .map(|literal| join(&root, literal))
        .filter(|candidate| files.holds(candidate) && !candidate.is_empty())
        .collect();
    ships.sort();
    ships.dedup();
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

fn apple_application(files: &Files, path: &str, runnable: &HashSet<&str>) -> Option<Candidate> {
    let bundle = directory_of(path);
    if crate::paths::is_test(path) || !runnable.contains(bundle) {
        return None;
    }
    let mut root = None;
    let mut climbing = Some(bundle);
    while let Some(directory) = climbing {
        let project = files.paths.iter().any(|other| {
            let within = match directory.is_empty() {
                true => Some(&other[..]),
                false => other.strip_prefix(directory).and_then(|rest| rest.strip_prefix('/')),
            };
            within
                .and_then(|rest| rest.split('/').next())
                .is_some_and(|first| first.ends_with(".xcodeproj"))
        });
        if project {
            root = Some(directory);
            break;
        }
        climbing = match directory.rfind('/') {
            Some(at) => Some(&directory[..at]),
            None if !directory.is_empty() => Some(""),
            None => None,
        };
    }
    let root = root?;
    Some(Candidate {
        name: display_name(root),
        root: root.to_string(),
        declarations: vec![Declaration {
            declares: Declares::Ship,
            kind: "apple-application",
            at: path.to_string(),
        }],
        ships: Vec::new(),
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

fn runnable_roots<'a>(files: &'a [String], entry_points: &[EntryPoint]) -> HashSet<&'a str> {
    let lifecycle: HashSet<&str> = entry_points
        .iter()
        .filter(|entry| entry.kind == "lifecycle" || entry.kind == "http")
        .map(|entry| file_of(&entry.handler))
        .collect();
    let mut roots = HashSet::default();
    for path in files {
        if !lifecycle.contains(path.as_str()) {
            continue;
        }
        let mut directory = directory_of(path);
        roots.insert(directory);
        while let Some(at) = directory.rfind('/') {
            directory = &directory[..at];
            roots.insert(directory);
        }
    }
    roots
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
    calls: &[CallFact],
) -> Scope {
    let index = Files::build(files, nodes);
    let runnable = runnable_roots(files, entry_points);
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
        if basename == "info.plist" {
            candidates.extend(apple_application(&index, path, &runnable));
            continue;
        }
        if let Some(found) = installer(&index, path, calls, at as u32) {
            candidates.push(found);
            continue;
        }
        if let Some(mut found) = module_manifest(&index, path, &runnable) {
            if basename.starts_with("build.gradle") && applies_plugin(calls, at as u32, "library") {
                found.declarations.retain(|held| held.declares != Declares::Run);
            }
            if let Some(kind) = build_target(&index, path, calls, at as u32) {
                found.declarations.push(Declaration {
                    declares: Declares::Ship,
                    kind,
                    at: path.to_string(),
                });
            }
            candidates.push(found);
            continue;
        }
        if let Some(kind) = build_target(&index, path, calls, at as u32) {
            let root = directory_of(path);
            let root = root
                .strip_suffix("/src/main")
                .or_else(|| root.strip_suffix("/src/androidMain"))
                .unwrap_or(root)
                .to_string();
            candidates.push(Candidate {
                name: display_name(&root),
                root,
                declarations: vec![Declaration {
                    declares: Declares::Ship,
                    kind,
                    at: path.to_string(),
                }],
                ships: Vec::new(),
                runs: None,
            });
        }
    }

    separate_containers(&mut candidates);
    consolidate(candidates, &index, nodes, edges, entry_points, code, calls)
}

fn separate_containers(candidates: &mut [Candidate]) {
    let containers: Vec<usize> = candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| {
            candidate.declarations.iter().any(|declared| declared.kind == "container")
        })
        .map(|(at, _)| at)
        .collect();
    if containers.len() < 2 {
        return;
    }
    let mut shared: HashMap<String, u32> = HashMap::default();
    for at in &containers {
        for path in &candidates[*at].ships {
            *shared.entry(path.clone()).or_insert(0) += 1;
        }
    }
    for at in containers {
        let alone: Vec<String> = candidates[at]
            .ships
            .iter()
            .filter(|path| shared.get(*path).copied().unwrap_or(0) == 1)
            .cloned()
            .collect();
        if alone.is_empty() {
            continue;
        }
        candidates[at].root = common_ancestor(&alone);
        candidates[at].name = display_name(&candidates[at].root);
    }
}

fn consolidate(
    mut candidates: Vec<Candidate>,
    index: &Files,
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    entry_points: &[EntryPoint],
    code: &[bool],
    calls: &[CallFact],
) -> Scope {
    candidates.sort_by(|left, right| {
        right
            .strongest()
            .cmp(&left.strongest())
            .then(left.root.cmp(&right.root))
    });

    let mut deployables: Vec<Deployable> = Vec::new();
    let mut by_root: HashMap<String, usize> = HashMap::default();
    for candidate in candidates {
        let declares = candidate.strongest();
        let shipped = declares == Declares::Ship;
        let named = candidate
            .declarations
            .iter()
            .any(|found| found.kind == "compose-service");
        let identity = match named {
            true => format!("{}\u{1}{}", candidate.root, candidate.name),
            false => candidate.root.clone(),
        };
        if let Some(at) = by_root.get(&identity).copied() {
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
            if declares.category() != "library" && unit.category == "library" {
                unit.category = declares.category();
            }
            if shipped {
                unit.category = "shipped";
            }
            if unnamed && identifies {
                unit.name = candidate.name;
            }
            continue;
        }
        by_root.insert(identity, deployables.len());
        deployables.push(Deployable {
            id: format!(
                "deployable:{}",
                if candidate.root.is_empty() || named {
                    candidate.name.as_str()
                } else {
                    candidate.root.as_str()
                }
            ),
            name: candidate.name,
            root: candidate.root,
            category: declares.category(),
            shipped,
            declarations: candidate.declarations,
            ships: candidate.ships,
            runs: candidate.runs,
            members: Vec::new(),
            bundled_into: None,
            offered_to_others: false,
            consumers: 0,
            units: 0,
            entry_points: 0,
            entered_at: Vec::new(),
            reaches: Vec::new(),
        });
    }
    let file_at: HashMap<&str, u32> =
        index.paths.iter().enumerate().map(|(at, path)| (*path, at as u32)).collect();
    for unit in deployables.iter_mut() {
        unit.declarations.sort_by(|left, right| {
            right.declares.cmp(&left.declares).then(left.at.cmp(&right.at))
        });
        unit.declarations.dedup_by(|left, right| left.at == right.at && left.kind == right.kind);
        unit.ships.sort();
        unit.ships.dedup();
        unit.offered_to_others = unit
            .declarations
            .iter()
            .filter(|found| found.kind == "package-identity")
            .any(|found| match found.at.rsplit('/').next().is_some_and(|named| named.starts_with("build.gradle")) {
                true => file_at.get(found.at.as_str()).is_some_and(|file| gradle_publishes(calls, *file)),
                false if found.at.ends_with(".csproj") || found.at.ends_with(".fsproj") => packed_for_others(index, &found.at),
                false => ready_to_be_published(index, &found.at),
            });
    }

    let shipped: Vec<(usize, Vec<String>)> = deployables
        .iter()
        .enumerate()
        .filter(|(_, unit)| unit.shipped)
        .map(|(at, unit)| (at, unit.ships.clone()))
        .collect();

    for at in 0..deployables.len() {
        let root = deployables[at].root.clone();
        if root.is_empty() {
            continue;
        }
        let bundle = shipped.iter().find(|(other, ships)| {
            *other != at
                && !contains(&root, &deployables[*other].root)
                && ships.iter().any(|path| contains(&root, path))
        });
        if let Some((owner, _)) = bundle {
            let owner_id = deployables[*owner].id.clone();
            let member_id = deployables[at].id.clone();
            deployables[at].bundled_into = Some(owner_id);
            deployables[*owner].members.push(member_id);
        }
    }

    let declared_at: Vec<Vec<String>> = deployables
        .iter()
        .map(|unit| {
            let mut held: Vec<String> = unit.declarations.iter().map(|at| at.at.clone()).collect();
            for named in ["Cargo.toml", "package.json", "pyproject.toml", "go.mod"] {
                held.push(match unit.root.is_empty() {
                    true => named.to_string(),
                    false => format!("{}/{named}", unit.root),
                });
            }
            held.sort();
            held.dedup();
            held
        })
        .collect();
    let where_of: HashMap<&str, usize> =
        deployables.iter().enumerate().map(|(at, unit)| (unit.root.as_str(), at)).collect();
    let gradle_of: HashMap<String, usize> =
        deployables.iter().enumerate().map(|(at, unit)| (gradle_key(&unit.root), at)).collect();
    let mut carried: Vec<(usize, usize)> = Vec::new();
    for at in 0..deployables.len() {
        let root = deployables[at].root.clone();
        for manifest in declared_at[at].iter() {
            let projects = file_at
                .get(manifest.as_str())
                .map(|file| gradle_projects(index, manifest, *file, calls))
                .unwrap_or_default();
            let named = built_into(index, manifest, &root)
                .into_iter()
                .filter_map(|held| where_of.get(held.as_str()).copied())
                .chain(projects.iter().filter_map(|key| gradle_of.get(key).copied()));
            for other in named {
                if other == at || deployables[other].shipped || deployables[other].runs.is_some() {
                    continue;
                }
                carried.push((other, at));
            }
        }
    }
    let mut consumed_by: HashMap<usize, Vec<usize>> = HashMap::default();
    for (member, owner) in carried {
        let named = deployables[owner].root.rsplit('/').next().unwrap_or_default();
        if crate::paths::is_test(&format!("{}/", deployables[owner].root)) || named.ends_with("Tests") || named.ends_with("Test") {
            continue;
        }
        consumed_by.entry(member).or_default().push(owner);
    }
    for at in 0..deployables.len() {
        let mut seen: HashSet<usize> = HashSet::from_iter([at]);
        let mut pending = vec![at];
        let mut tops: HashSet<usize> = HashSet::default();
        while let Some(current) = pending.pop() {
            match consumed_by.get(&current) {
                Some(owners) => {
                    for owner in owners {
                        if seen.insert(*owner) {
                            pending.push(*owner);
                        }
                    }
                }
                None if current != at => {
                    tops.insert(current);
                }
                None => {}
            }
        }
        deployables[at].consumers = tops.len() as u32;
    }
    for (member, owners) in consumed_by.iter() {
        let Some(best) = owners.iter().copied().max_by_key(|owner| (deployables[*owner].consumers, std::cmp::Reverse(*owner))) else {
            continue;
        };
        if deployables[*member].bundled_into.is_some() {
            continue;
        }
        let owner_id = deployables[best].id.clone();
        let member_id = deployables[*member].id.clone();
        deployables[*member].bundled_into = Some(owner_id);
        deployables[best].members.push(member_id);
    }
    let territory = Territory::of(
        deployables
            .iter()
            .enumerate()
            .filter(|(_, unit)| unit.bundled_into.is_none())
            .map(|(at, unit)| (unit.root.clone(), at))
            .collect(),
    );

    let mut imports: HashMap<&str, Vec<&str>> = HashMap::default();
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

    let mut reach: HashMap<&str, Vec<usize>> = HashMap::default();
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
        if !code.get(node.file as usize).copied().unwrap_or(false) || !node.kind.is_declaration() {
            continue;
        }
        let path = file_of(&node.id);
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
        if let Some(at) = territory.owner(file_of(&entry.handler)) {
            deployables[at].entry_points += 1;
            let held = file_of(&entry.handler).to_string();
            if !deployables[at].entered_at.contains(&held) {
                deployables[at].entered_at.push(held);
            }
        }
    }
    for unit in deployables.iter_mut() {
        unit.entered_at.sort();
    }

    deployables.sort_by(|left, right| left.id.cmp(&right.id));
    Scope {
        deployables,
        assigned_nodes: assigned,
        shared_nodes: shared,
        unassigned_nodes: unassigned,
    }
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

#[cfg(test)]
mod ready {
    #[test]
    fn what_a_registry_asks_for_is_named_by_the_manifest_it_reads() {
        for (named, asked) in super::A_REGISTRY_ASKS_FOR {
            assert!(named.contains('.'), "{named}");
            assert!(asked.iter().all(|any_of| !any_of.is_empty()));
        }
    }
}
