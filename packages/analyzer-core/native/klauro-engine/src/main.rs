mod alias;
mod addresses;
mod architecture;
mod arms;
mod builtins;
mod capabilities;
mod audit;
mod author;
mod comprehend;
mod composition;
mod parent;
mod conform;
mod convention;
mod coverage;
mod bundler;
mod budget;
mod dead;
mod dependencies;
mod discovery;
mod dockerfile;
mod language_tables;
mod elements;
mod entities;
mod entry_exit;
mod generated;
mod fixes;
mod history;
mod jev;
mod gomod;
mod generic;
mod externals;
mod facts_cache;
mod stable_ids;
mod graph;
mod health;
mod language;
mod icelot;
mod model;
mod mounts;
mod names;
mod paths;
mod reach;
mod published;
mod resolve;
mod roles;
mod route;
mod rust_use;
mod layers;
mod memory;
mod design_patterns;
mod patterns;
mod practices;
mod principles;
mod schema_files;
mod scope;
mod screens;
mod sdk;
mod shared;
mod service_catalog;
mod services;
mod tables;
mod source_rewrite;
mod steps;
mod dataset;
mod rails_routes;
mod structured;
mod subproject;
mod unshipped;
mod typescript;
mod verify;
mod visibility;
mod vendored;
mod wire;

use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use rayon::prelude::*;
use serde::Serialize;

use model::FileFacts;

#[derive(Serialize)]
pub struct IndexedFile {
    pub path: String,
    kind: discovery::FileKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<&'static str>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    extracted: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    oversize: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    generated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    namespace: Option<String>,
}

#[derive(Serialize)]
struct Index {
    root: String,
    files: Vec<IndexedFile>,
    nodes: Vec<model::IndexNode>,
    edges: Vec<model::IndexEdge>,
    imports: Vec<model::ImportFact>,
    exports: Vec<model::ExportFact>,
    calls: Vec<model::CallFact>,
    type_references: Vec<model::TypeReferenceFact>,
    metrics: Vec<model::UnitMetricsEntry>,
    registrations: Vec<model::RegistrationFact>,
    #[serde(skip)]
    kept: Vec<model::Kept>,
    #[serde(skip)]
    forwards: Vec<model::Forward>,
    #[serde(skip)]
    bundler_builds: Vec<model::BundlerBuild>,
    settings: Vec<model::SettingRead>,
    locals: Vec<model::LocalBinding>,
    entry_points: Vec<entry_exit::EntryPoint>,
    exit_points: Vec<entry_exit::ExitPoint>,
    icelot: Vec<icelot::Icelot>,
    graph: Option<graph::GraphFacts>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    dead: Vec<dead::Dead>,
    dependencies: Option<dependencies::Dependencies>,
    services: Vec<services::Service>,
    layering: Vec<layers::Layering>,
    #[serde(skip_serializing_if = "Option::is_none")]
    patterns: Option<patterns::Patterns>,
    #[serde(skip_serializing_if = "Option::is_none")]
    principles: Option<principles::Principles>,
    roles: Option<roles::Roles>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verification: Option<verify::Verification>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conformance: Option<conform::Conformance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    history: Option<history::History>,
    #[serde(skip_serializing_if = "Option::is_none")]
    health: Option<health::Health>,
    #[serde(skip_serializing_if = "Option::is_none")]
    comprehension: Option<comprehend::Comprehension>,
    architecture: Option<architecture::Architecture>,
    scope: Option<scope::Scope>,
    partition: Option<subproject::Partition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    composition: Option<composition::Composition>,
    skipped_directories: Vec<String>,
    nested_repositories: Vec<String>,
}

enum Read {
    Facts(Box<FileFacts>),
    Generated,
    Binary,
    Unreadable,
}

fn is_binary(source: &[u8]) -> bool {
    let window = source.len().min(8000);
    if window == 0 {
        return false;
    }
    let nuls = source[..window].iter().filter(|byte| **byte == 0).count();
    nuls * 100 > window
}

fn extract(
    path: &str,
    absolute: &std::path::Path,
    file: u32,
    language_id: Option<&str>,
    remembered: &facts_cache::Remembered,
) -> (Read, Option<facts_cache::Entry>) {
    let Ok(mut source) = std::fs::read(absolute) else {
        return (Read::Unreadable, None);
    };
    if is_binary(&source) {
        return (Read::Binary, None);
    }
    if generated::is_generated(&source) {
        return (Read::Generated, None);
    }
    let key = remembered.key(path, language_id, &source);
    if let Some(facts) = remembered.recall(path, key, file) {
        return (Read::Facts(Box::new(facts)), None);
    }
    match read(path, &mut source, file, language_id) {
        Some(mut facts) => {
            stable_ids::stabilize(&mut facts);
            let entry = facts_cache::Remembered::entry(key, file, &facts);
            (Read::Facts(Box::new(facts)), entry)
        }
        None => (Read::Unreadable, None),
    }
}

use crate::model::{IndexNode, Modifiers, NodeKind, Span};

fn close_graph(index: &mut Index) {
    let declared: rustc_hash::FxHashSet<&str> =
        index.nodes.iter().map(|node| node.id.as_str()).collect();
    let known: rustc_hash::FxHashMap<&str, u32> = index
        .files
        .iter()
        .enumerate()
        .map(|(at, file)| (file.path.as_str(), at as u32))
        .collect();
    let mut standing: Vec<(String, u32)> = index
        .edges
        .iter()
        .flat_map(|edge| [edge.source.as_str(), edge.target.as_str()])
        .filter(|held| !declared.contains(held))
        .filter_map(|held| known.get(held).map(|file| (held.to_string(), *file)))
        .collect();
    standing.sort();
    standing.dedup();
    for (path, file) in standing {
        index.nodes.push(IndexNode {
            id: path.clone(),
            name: paths::basename(&path).to_string(),
            kind: NodeKind::Module,
            file,
            span: Span { line: 1, column: 1, end_line: 1, end_column: 1 },
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
}

fn read(
    path: &str,
    source: &mut Vec<u8>,
    file: u32,
    language_id: Option<&str>,
) -> Option<FileFacts> {
    let lines = |source: &[u8]| source.iter().filter(|byte| **byte == b'\n').count() as u32 + 1;
    if let Some(mut parser) = typescript::parser_for(path)
        .or_else(|| typescript::parser_for_language(language_id?))
    {
        if language_id.is_some_and(typescript::wraps_script) {
            source_rewrite::component_script(source);
        }
        source_rewrite::grammar_limitations(source);
        let tree = parser.parse(&source, None)?;
        report_first_error(path, source, &tree);
        let mut facts = typescript::Extractor::new(source, file, path).run(&tree, path, lines(source));
        facts.tables.extend(tables::declared(source, path, file));
        if bundler::is_config(path) {
            facts.nodes.extend(bundler::declared_aliases(&tree, source, file, path));
        }
        facts.bundler_builds.extend(bundler::declared_builds(&tree, source, file));
        return Some(facts);
    }
    if dockerfile::is_dockerfile(path) {
        let text = std::str::from_utf8(source).ok()?;
        return Some(dockerfile::extract(text, file, path));
    }
    if coverage::is_report(path) {
        let text = std::str::from_utf8(source).ok()?;
        return Some(coverage::extract(text, file, path));
    }
    if gomod::is_go_module(path) {
        let text = std::str::from_utf8(source).ok()?;
        return Some(gomod::extract(text, file, path));
    }
    if path.to_ascii_lowercase().ends_with(".razor") {
        let component = source_rewrite::razor_component(source, path)?;
        let (language, spec) = language::language_for("csharp")?;
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&language).ok()?;
        let tree = parser.parse(&component.source, None)?;
        let mut facts = generic::Extractor::new(&component.source, file, path, spec).run(&tree, path, lines(source));
        routed_as_a_page(&mut facts, &component);
        taken_by_hand(&mut facts, &component);
        return Some(facts);
    }
    let declared = language_id.or_else(|| language_of(path));
    if let Some(id) = declared
        && let Some((mut parser, spec)) = structured::parser_for(id)
    {
        let tree = parser.parse(&source, None)?;
        let mut facts = structured::Extractor::new(source, file, path, spec).run(&tree, path, lines(source));
        facts.tables.extend(tables::declared(source, path, file));
        return Some(facts);
    }
    let (language, spec) = language::language_for(declared?)?;
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&language).ok()?;
    let tree = parser.parse(&source, None)?;
    let mut facts = generic::Extractor::new(source, file, path, spec).run(&tree, path, lines(source));
    facts.tables.extend(tables::declared(source, path, file));
    Some(facts)
}

static LOADS_A_PAGE: &[&str] = &[source_rewrite::RENDERS];

fn taken_by_hand(facts: &mut FileFacts, component: &source_rewrite::Component) {
    let Some(owner) = facts
        .nodes
        .iter()
        .find(|node| node.kind.is_type() && node.name == component.named)
        .map(|node| node.id.clone())
    else {
        return;
    };
    for node in facts.nodes.iter_mut() {
        if node.parent.as_deref() == Some(owner.as_str())
            && node.kind.is_unit()
            && node.callback_of.is_none()
            && component.handlers.iter().any(|named| *named == node.name)
        {
            node.callback_of = Some("dispatch:ui".to_string());
            node.registration_label = Some(format!("{}.{}", component.named, node.name));
        }
    }
}

fn routed_as_a_page(facts: &mut FileFacts, component: &source_rewrite::Component) {
    let Some(owner) = facts
        .nodes
        .iter()
        .find(|node| node.kind.is_type() && node.name == component.named)
        .map(|node| node.id.clone())
    else {
        return;
    };
    let Some(loads) = LOADS_A_PAGE.iter().find_map(|named| {
        facts.nodes.iter().position(|node| node.parent.as_deref() == Some(owner.as_str()) && node.name == *named)
    }) else {
        return;
    };
    for route in &component.routes {
        facts.nodes[loads].decorators.push(model::Decorator {
            name: "HttpGet".to_string(),
            arguments: vec![model::DecoratorArgument { value: route.clone(), literal: true }],
        });
    }
}

fn language_of(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    let basename = lower.rsplit('/').next().unwrap_or(&lower);
    let by_extension = [
        (".json", "json"),
        (".jsonc", "json"),
        (".json5", "json"),
        (".toml", "toml"),
        (".yaml", "yaml"),
        (".yml", "yaml"),
        (".ini", "ini"),
        (".properties", "ini"),
        (".editorconfig", "ini"),
    ];
    if let Some((_, id)) = by_extension
        .iter()
        .find(|(extension, _)| basename.ends_with(extension))
    {
        return Some(id);
    }
    basename.starts_with(".env").then_some("ini")
}

fn report_first_error(path: &str, source: &[u8], tree: &tree_sitter::Tree) {
    if std::env::var("KLAURO_REPORT_PARSE_ERRORS").is_ok()
        && let Some((line, kind)) = typescript::first_error(tree.root_node())
    {
        let text = String::from_utf8_lossy(source);
        let snippet = text.lines().nth(line as usize - 1).unwrap_or("").trim();
        eprintln!("{path}:{line} [{kind}] {}", &snippet[..snippet.len().min(90)]);
    }
}

const ROOM_TO_DESCEND: usize = 256 << 20;

fn main() {
    rayon::ThreadPoolBuilder::new()
        .num_threads(budget::pool_size())
        .stack_size(ROOM_TO_DESCEND)
        .build_global()
        .ok();
    let held = std::thread::Builder::new()
        .stack_size(ROOM_TO_DESCEND)
        .spawn(read_it)
        .expect("a thread to read on");
    if held.join().is_err() {
        std::process::exit(1);
    }
}

fn read_it() {
    let root = std::env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let started = Instant::now();
    let found = discovery::discover(&root);
    let discovered = started.elapsed();

    let parse_started = Instant::now();
    let remembered = facts_cache::open(&root);
    let mut fresh: Vec<(String, facts_cache::Entry)> = Vec::new();
    let reads: Vec<(u32, Read)> = found
        .files
        .par_iter()
        .enumerate()
        .filter(|(_, entry)| route::readable(entry))
        .map(|(file, entry)| {
            let began = Instant::now();
            let (read, kept) = extract(&entry.path, &entry.absolute, file as u32, entry.language, &remembered);
            (file as u32, read, kept, began.elapsed())
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|(file, read, kept, took)| {
            if std::env::var("KLAURO_TIME_FILES").is_ok() && took.as_millis() > 200 {
                eprintln!("    slow file {:?} {}", took, found.files[file as usize].path);
            }
            if let Some(kept) = kept {
                fresh.push((found.files[file as usize].path.clone(), kept));
            }
            (file, read)
        })
        .collect();
    let recomputed = fresh.len();
    let present: rustc_hash::FxHashSet<&str> = found.files.iter().map(|file| file.path.as_str()).collect();
    remembered.keep(fresh, &present);
    let mut generated_files = rustc_hash::FxHashSet::default();
    let mut facts = Vec::with_capacity(reads.len());
    for (file, read) in reads {
        match read {
            Read::Facts(found) => facts.push(*found),
            Read::Generated | Read::Binary => {
                generated_files.insert(file);
            }
            Read::Unreadable => {}
        }
    }
    let parsed = parse_started.elapsed();
    eprintln!("  extraction read afresh {recomputed} of {} files", facts.len());

    let mut index = Index {
        root: root.to_string_lossy().to_string(),
        files: found
            .files
            .iter()
            .map(|file| IndexedFile {
                path: file.path.clone(),
                kind: file.kind,
                language: file.language,
                extracted: false,
                oversize: !route::readable(file),
                generated: false,
                namespace: None,
            })
            .collect(),
        nodes: Vec::new(),
        edges: Vec::new(),
        imports: Vec::new(),
        exports: Vec::new(),
        calls: Vec::new(),
        type_references: Vec::new(),
        metrics: Vec::new(),
        registrations: Vec::new(),
        kept: Vec::new(),
        forwards: Vec::new(),
        bundler_builds: Vec::new(),
        settings: Vec::new(),
        locals: Vec::new(),
        entry_points: Vec::new(),
        exit_points: Vec::new(),
        icelot: Vec::new(),
        graph: None,
        dead: Vec::new(),
        dependencies: None,
        services: Vec::new(),
        layering: Vec::new(),
        patterns: None,
        principles: None,
        roles: None,
        verification: None,
        conformance: None,
        history: None,
        health: None,
        comprehension: None,
        architecture: None,
        scope: None,
        partition: None,
        composition: None,
        skipped_directories: found.skipped_directories,
        nested_repositories: found.nested_repositories,
    };
    let mut declared_tables: Vec<tables::Table> = Vec::new();
    let mut parse_errors = 0;
    let mut extracted_files = rustc_hash::FxHashSet::default();
    let report_errors = std::env::var("KLAURO_REPORT_PARSE_ERRORS").is_ok();
    for file in facts {
        if report_errors && file.parse_errors > 0 {
            eprintln!("parse errors {} in {}", file.parse_errors, index.files[file.nodes[0].file as usize].path);
        }
        let at = file.nodes[0].file as usize;
        index.files[at].namespace = file.namespace;
        extracted_files.insert(file.nodes[0].file);
        index.nodes.extend(file.nodes);
        index.edges.extend(file.edges);
        index.imports.extend(file.imports);
        index.exports.extend(file.exports);
        index.calls.extend(file.calls);
        index.type_references.extend(file.type_references);
        index.metrics.extend(file.metrics);
        index.registrations.extend(file.registrations);
        index.kept.extend(file.kept);
        index.forwards.extend(file.forwards);
        index.bundler_builds.extend(file.bundler_builds);
        index.settings.extend(file.settings);
        index.locals.extend(file.locals);
        declared_tables.extend(file.tables);
        parse_errors += file.parse_errors;
    }

    let spelled_paths: Vec<&str> = index.files.iter().map(|file| file.path.as_str()).collect();
    declared_tables.extend(tables::created_by_calls(&index.calls, &index.nodes, &index.locals, &spelled_paths));
    let declared_tables = tables::standing(declared_tables, &spelled_paths);
    for (position, file) in index.files.iter_mut().enumerate() {
        file.extracted = extracted_files.contains(&(position as u32));
        file.generated = generated_files.contains(&(position as u32));
    }
    if std::env::var("KLAURO_REPORT_COVERAGE").is_ok() {
        let mut by_language: std::collections::BTreeMap<&str, (u32, u32)> =
            std::collections::BTreeMap::new();
        for file in &index.files {
            if file.kind != discovery::FileKind::Source || file.generated {
                continue;
            }
            let entry = by_language.entry(file.language.unwrap_or("unknown")).or_insert((0, 0));
            entry.0 += 1;
            if file.extracted {
                entry.1 += 1;
            }
        }
        let mut ranked: Vec<(&str, (u32, u32))> = by_language.into_iter().collect();
        ranked.sort_by(|left, right| right.1.0.cmp(&left.1.0));
        for (language, (total, extracted)) in ranked {
            eprintln!("  coverage {language:<16} {extracted:>6} of {total:>6}");
        }
    }

    eprintln!(
        "discover {:?} ({} files) | parse {:?} | nodes {} edges {} calls {} imports {} type refs {} | parse errors {}",
        discovered,
        index.files.len(),
        parsed,
        index.nodes.len(),
        index.edges.len(),
        index.calls.len(),
        index.imports.len(),
        index.type_references.len(),
        parse_errors
    );

    let resolve_started = Instant::now();
    let paths: Vec<String> = index.files.iter().map(|file| file.path.clone()).collect();
    let languages: Vec<&str> = index.files.iter().map(|file| file.language.unwrap_or("")).collect();
    let namespaces: Vec<&str> = index
        .files
        .iter()
        .map(|file| file.namespace.as_deref().unwrap_or(""))
        .collect();
    let mut resolution = resolve::resolve(&resolve::Index {
        files: &paths,
        languages: &languages,
        namespaces: &namespaces,
        nodes: &index.nodes,
        imports: &index.imports,
        calls: &index.calls,
        type_references: &index.type_references,
        locals: &index.locals,
        forwards: &index.forwards,
    });
    let internal_specifiers = std::mem::take(&mut resolution.internal_specifiers);
    let resolved = resolve_started.elapsed();
    let resolved_edges = resolution.edges.len();
    let imported_files = resolution
        .edges
        .iter()
        .filter(|edge| matches!(edge.kind, model::EdgeKind::Imports))
        .count();
    let open_calls = std::mem::take(&mut resolution.open_calls);
    index.edges.extend(std::mem::take(&mut resolution.edges));
    index.nodes.extend(std::mem::take(&mut resolution.external_nodes));
    for node in index.nodes.iter_mut() {
        if let Some(owner) = resolution.method_owners.get(&node.id) {
            node.parent = Some(owner.clone());
        }
    }

    close_graph(&mut index);

    eprintln!(
        "resolve {:?} | edges {} | imported files {} | package {} | runtime {} | indirect {} | dynamic {} | unresolved {} | no caller {}",
        resolved,
        resolved_edges,
        imported_files,
        resolution.package_calls,
        resolution.runtime_calls,
        resolution.indirect_calls,
        resolution.dynamic_calls,
        resolution.unresolved_calls,
        resolution.no_caller
    );

    let derive_started = Instant::now();
    let derived = entry_exit::derive(
        &index.nodes,
        &index.calls,
        &paths,
        &index.registrations,
        &index.type_references,
        &resolution,
        &index.locals,
        &index.imports,
    );
    let mut derived = derived;
    derived.exit_points.extend(entry_exit::kept_by_the_browser(&index.kept, &paths));
    let namespaces: Vec<&str> = index.files.iter().filter_map(|file| file.namespace.as_deref()).collect();
    derived.exit_points.extend(sdk::reached(&index.edges, &index.nodes, &paths, &namespaces));
    derived
        .entry_points
        .extend(convention::conventional(&index.nodes, &paths, &index.exports));
    derived
        .entry_points
        .extend(screens::drawn(&index.nodes, &index.registrations, &index.exports, &index.imports, &index.locals, &paths, &resolution));
    derived.entry_points.retain(|entry| {
        paths.get(entry.file as usize).is_none_or(|path| !path.split('/').any(|segment| segment.starts_with('.') && segment.len() > 1 && segment != ".well-known"))
    });
    derived.entry_points.sort_by(|left, right| left.id.cmp(&right.id));
    entry_exit::guard(&mut derived.entry_points, &index.nodes);
    derived.entry_points.dedup_by(|left, right| left.id == right.id);
    let derived = derived;
    let derived_elapsed = derive_started.elapsed();
    let served = derived.entry_points.iter().filter(|entry| entry.kind != "test").count();
    eprintln!(
        "entry and exit {:?} | entry points {} | served {} | exit points {}",
        derived_elapsed,
        derived.entry_points.len(),
        served,
        derived.exit_points.len()
    );
    let continued = derived.continued;
    index.entry_points = derived.entry_points;
    index.exit_points = derived.exit_points;

    let icelot_started = Instant::now();
    let external: rustc_hash::FxHashMap<String, ()> = resolution
        .modules
        .iter()
        .map(|((_, name), _)| (name.clone(), ()))
        .collect();
    index.icelot = icelot::derive(
        &index.nodes,
        &index.metrics,
        &index.calls,
        &index.edges,
        &index.exit_points,
        &external,
    );
    let observed = index.icelot.iter().filter(|unit| unit.observed()).count();
    eprintln!(
        "icelot {:?} | units {} | observed {}",
        icelot_started.elapsed(),
        index.icelot.len(),
        observed
    );

    let scope_started = Instant::now();
    let manifests: Vec<bool> = index
        .files
        .iter()
        .map(|file| file.kind != discovery::FileKind::Source || file.language.is_some())
        .collect();
    let code: Vec<bool> = index
        .files
        .iter()
        .map(|file| {
            file.kind == discovery::FileKind::Source
                && !matches!(
                    file.language,
                    Some("configuration")
                        | Some("json")
                        | Some("toml")
                        | Some("ini")
                        | Some("css")
                        | Some("html")
                        | Some("xml")
                        | Some("markdown")
                )
        })
        .collect();
    let scoped_entries: Vec<entry_exit::EntryPoint> = index
        .entry_points
        .iter()
        .filter(|entry| !paths::is_not_shipped(&paths[entry.file as usize]))
        .cloned()
        .collect();
    let scope = scope::derive(
        &paths,
        &manifests,
        &code,
        &index.nodes,
        &index.edges,
        &scoped_entries,
        &index.calls,
        &index.bundler_builds,
        &index.imports,
    );
    eprintln!(
        "scope {:?} | projects {} | library {} runnable {} shipped {} | assigned {} shared {} unscoped {}",
        scope_started.elapsed(),
        scope.deployables.len(),
        scope.deployables.iter().filter(|unit| unit.category == "library").count(),
        scope.deployables.iter().filter(|unit| unit.category == "runnable").count(),
        scope.deployables.iter().filter(|unit| unit.category == "shipped").count(),
        scope.assigned_nodes,
        scope.shared_nodes,
        scope.unassigned_nodes
    );
    let classify_started = Instant::now();
    let (build_scripts, census) =
        unshipped::classify(&mut index.entry_points, &paths, &index.nodes, &index.edges, &scope, &continued);
    let build_script_ids: rustc_hash::FxHashSet<String> = build_scripts.into_iter().map(|entry| entry.id).collect();
    index.entry_points.retain(|entry| !build_script_ids.contains(&entry.id));
    eprintln!(
        "unshipped {:?} | tagged {} | build scripts {} | continuations {} (reached through their starter {}, starter unreached {}, orphaned {})",
        classify_started.elapsed(),
        census.tagged,
        build_script_ids.len(),
        census.continuations,
        census.continuations_held,
        census.continuations_holder_unreached,
        census.continuations_orphaned
    );
    index.scope = Some(scope);

    let published_started = Instant::now();
    let published = published::published(
        &paths,
        &index.nodes,
        index.scope.as_ref().expect("scope precedes what it publishes"),
    );
    if !published.is_empty() {
        eprintln!(
            "published {:?} | surfaces {}",
            published_started.elapsed(),
            published.len()
        );
        index.entry_points.extend(published);
        index.entry_points.sort_by(|left, right| left.id.cmp(&right.id));
        index.entry_points.dedup_by(|left, right| left.id == right.id);
    }

    let partition_started = Instant::now();
    let partitioned_entries: Vec<entry_exit::EntryPoint> =
        index.entry_points.iter().filter(|entry| entry.unshipped.is_none()).cloned().collect();
    let partition = subproject::derive(
        &paths,
        &index.nodes,
        &index.edges,
        &partitioned_entries,
        &index.nested_repositories,
        &code,
        index.scope.as_ref().map(|scope| scope.deployables.as_slice()).unwrap_or(&[]),
    );
    let project_of: rustc_hash::FxHashMap<&str, &str> = partition
        .assignment
        .iter()
        .map(|(path, id)| (path.as_str(), id.as_str()))
        .collect();
    for node in index.nodes.iter_mut() {
        let path = node.id.split(':').next().unwrap_or("");
        if let Some(project) = project_of.get(path) {
            node.project = Some((*project).to_string());
        }
    }
    eprintln!(
        "partition {:?} | sub-projects {} | promoted {} | assigned {} shared {} unpartitioned {}",
        partition_started.elapsed(),
        partition.sub_projects.len(),
        partition.sub_cas_nodes.promoted,
        partition.assigned_declarations,
        partition.shared_declarations,
        partition.unpartitioned_declarations
    );
    index.partition = Some(partition);

    let dependencies_started = Instant::now();
    let assignment = index
        .partition
        .as_ref()
        .map(|partition| partition.assignment.as_slice())
        .unwrap_or(&[]);
    let own: rustc_hash::FxHashSet<&str> = index
        .scope
        .iter()
        .flat_map(|scope| scope.deployables.iter())
        .filter(|unit| {
            unit.declarations.iter().any(|declared| declared.kind == "package-identity")
        })
        .map(|unit| unit.name.as_str())
        .collect();
    let manifested = dependencies::manifested(&paths, &index.nodes, &index.calls);
    let found = dependencies::derive(
        &index.imports,
        &manifested,
        &internal_specifiers,
        &own,
        &paths,
        &languages,
        &index.entry_points,
        &index.exit_points,
        &dependencies::file_project(assignment),
    );
    let mut found = found;
    let leading = index
        .files
        .iter()
        .filter_map(|file| file.language)
        .fold(rustc_hash::FxHashMap::default(), |mut counted, language| {
            *counted.entry(language).or_insert(0u32) += 1;
            counted
        })
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(language, _)| language)
        .unwrap_or("");
    let interpreted = dependencies::interpret(&mut found, leading);
    eprintln!(
        "dependencies {:?} | packages {} | imported {} | declared {} | classified {} unclassified {} | interpreted {}",
        dependencies_started.elapsed(),
        found.dependencies.len(),
        found.imported,
        found.declared,
        found.classified,
        found.unclassified,
        interpreted
    );
    let built_with: Vec<&str> = found
        .dependencies
        .iter()
        .filter(|held| held.role == "framework" && (held.imports > 0 || held.declared))
        .map(|held| held.name.as_str())
        .collect();
    if !built_with.is_empty() {
        eprintln!(
            "built with | {}",
            built_with.iter().map(|named| format!("framework:{named}")).collect::<Vec<_>>().join(" ")
        );
    }
    index.dependencies = Some(found);


    let roles_started = Instant::now();
    let declared: Vec<bool> = index
        .files
        .iter()
        .map(|file| matches!(file.kind, discovery::FileKind::Source))
        .collect();
    let found = roles::derive(
        &index.nodes,
        &index.edges,
        &index.type_references,
        &index.entry_points,
        &declared,
    );
    eprintln!(
        "roles {:?} | {} across {} kinds",
        roles_started.elapsed(),
        found.roles.len(),
        found.by_role.len()
    );
    index.roles = Some(found);

    let architecture_started = Instant::now();
    if let (Some(partition), Some(roles), Some(dependencies)) = (
        index.partition.as_ref(),
        index.roles.as_ref(),
        index.dependencies.as_ref(),
    ) {
        let shaped = architecture::derive(
            partition,
            &index.entry_points,
            roles,
            dependencies,
            &paths,
            &dependencies::file_project(&partition.assignment),
        );
        eprintln!(
            "architecture {:?} | {} | serving {} | routes {}",
            architecture_started.elapsed(),
            shaped.shape,
            shaped.serving_projects,
            shaped.routes
        );
        index.architecture = Some(shaped);
    }

    let kept = entry_exit::kept_by_a_model(
        &index.calls,
        &paths,
        &index.nodes,
        index.roles.as_ref().expect("roles precede what a model keeps"),
    );
    let kept_in_stores = entry_exit::kept_by_a_store(
        &index.calls,
        &paths,
        &index.nodes,
        &index.edges,
        &index.type_references,
        &index.locals,
    );
    if !kept_in_stores.is_empty() {
        eprintln!("kept by a store | exits {}", kept_in_stores.len());
    }
    let kept: Vec<entry_exit::ExitPoint> = kept.into_iter().chain(kept_in_stores).collect();
    if !kept.is_empty() {
        eprintln!("kept by a model | exits {}", kept.len());
        index.exit_points.extend(kept);
        index.exit_points.sort_by(|left, right| left.id.cmp(&right.id));
        index.exit_points.dedup_by(|left, right| left.id == right.id);
    }
    addresses::fold(&mut index.exit_points, &index.calls, &index.locals, &index.nodes);
    let asked_before = index.exit_points.len();
    addresses::through_wrappers(&mut index.exit_points, &index.calls, &index.nodes, &paths);
    if index.exit_points.len() > asked_before {
        index.exit_points.sort_by(|left, right| left.id.cmp(&right.id));
        index.exit_points.dedup_by(|left, right| left.id == right.id);
    }

    let patterns_started = Instant::now();
    let pattern_paths: Vec<&str> = index.files.iter().map(|file| file.path.as_str()).collect();
    let declared_packages: Vec<&str> = index
        .dependencies
        .as_ref()
        .map(|found| found.dependencies.iter().map(|dependency| dependency.name.as_str()).collect())
        .unwrap_or_default();
    let pattern_graph = shared::Graph::new(
        &index.nodes,
        &index.edges,
        &index.type_references,
        index.roles.as_ref().expect("roles precede the patterns"),
        &pattern_paths,
    );
    let derived = patterns::derive(&patterns::Sources {
        graph: &pattern_graph,
        nodes: &index.nodes,
        edges: &index.edges,
        calls: &index.calls,
        type_references: &index.type_references,
        locals: &index.locals,
        entry_points: &index.entry_points,
        exit_points: &index.exit_points,
        roles: index.roles.as_ref().expect("roles precede the patterns"),
        paths: &pattern_paths,
        imports: &index.imports,
        declared: &declared_packages,
        serving_projects: index.architecture.as_ref().map(|architecture| architecture.serving_projects).unwrap_or(0),
    });
    drop(pattern_paths);
    drop(declared_packages);
    eprintln!(
        "patterns {:?} | found {} | messages {} | dispatched {} | topics {}",
        patterns_started.elapsed(),
        derived.patterns.found.len(),
        derived.patterns.messages.len(),
        derived.dispatched.len(),
        derived.patterns.topics.len()
    );
    if std::env::var("KLAURO_REPORT_PATTERNS").is_ok() {
        for found in &derived.patterns.found {
            eprintln!("  pattern {} | {} | {}", found.pattern, found.count, found.evidence);
        }
    }
    let delivered = patterns::subscribed(&derived.patterns.messages, &index.calls, &pattern_graph);
    let handled: rustc_hash::FxHashSet<(String, &'static str)> =
        index.entry_points.iter().map(|entry| (entry.handler.clone(), entry.kind)).collect();
    index.entry_points.extend(delivered.into_iter().filter(|entry| !handled.contains(&(entry.handler.clone(), entry.kind))));
    let dispatched = derived.dispatched;
    index.patterns = Some(derived.patterns);

    let services_started = Instant::now();
    let service_paths: Vec<&str> = index.files.iter().map(|file| file.path.as_str()).collect();
    let not_ours: Vec<bool> = index.files.iter().map(|file| file.generated || file.oversize).collect();
    let found_services = services::derive(&services::Sources {
        root: &root,
        paths: &service_paths,
        not_ours: &not_ours,
        dependencies: index.dependencies.as_ref(),
        imports: &index.imports,
        calls: &index.calls,
        exits: &index.exit_points,
        nodes: &index.nodes,
        settings: &index.settings,
    });
    drop(service_paths);
    let services::Found { services: found_services, serving } = found_services;
    for exit in index.exit_points.iter_mut() {
        exit.service = serving.get(&exit.id).cloned();
    }
    if std::env::var("KLAURO_REPORT_SERVICES").is_ok() {
        for service in &found_services {
            let evidenced: Vec<String> =
                service.evidenced.iter().map(|(how, count)| format!("{how} {count}")).collect();
            eprintln!(
                "  service {} | {} | reached {} | {}",
                service.name,
                service.kind,
                service.reached,
                evidenced.join(", ")
            );
        }
    }
    index.services = found_services;
    eprintln!(
        "services {:?} | {} known | {} unclassified",
        services_started.elapsed(),
        index.services.iter().filter(|service| service.known).count(),
        index.services.iter().filter(|service| !service.known).count(),
    );

    let principles_started = Instant::now();
    let principle_paths: Vec<&str> = index.files.iter().map(|file| file.path.as_str()).collect();
    let principles = principles::derive(&principles::Sources {
        graph: &pattern_graph,
        nodes: &index.nodes,
        edges: &index.edges,
        calls: &index.calls,
        metrics: &index.metrics,
        exit_points: &index.exit_points,
        paths: &principle_paths,
    });
    drop(principle_paths);
    eprintln!(
        "principles {:?} | anti-patterns {}",
        principles_started.elapsed(),
        principles.anti_patterns.len()
    );
    if std::env::var("KLAURO_REPORT_PATTERNS").is_ok() {
        for principle in &principles.solid {
            eprintln!("  principle {} | {} of {}", principle.principle, principle.following, principle.population);
        }
        for anti in &principles.anti_patterns {
            eprintln!("  anti-pattern {} | {}", anti.anti_pattern, anti.count);
        }
    }
    index.principles = Some(principles);

    let layers_started = Instant::now();
    let layering = layers::derive(
        &pattern_graph,
        &index.edges,
        &dispatched,
        index.roles.as_ref().expect("roles precede the layering"),
        &index.entry_points,
        &index.exit_points,
    );
    eprintln!("layers {:?} | projects {}", layers_started.elapsed(), layering.len());
    index.layering = layering;
    drop(pattern_graph);
    index.edges.extend(dispatched);


    let graph_started = Instant::now();
    let mut exits_by_unit: rustc_hash::FxHashMap<String, u32> = rustc_hash::FxHashMap::default();
    for exit in &index.exit_points {
        *exits_by_unit.entry(exit.source.clone()).or_insert(0) += 1;
    }
    let graph = graph::derive(&index.nodes, &index.edges, &index.entry_points, &exits_by_unit);
    eprintln!(
        "graph {:?} | reachable units {} | unreachable units {}",
        graph_started.elapsed(),
        graph.reachable_units,
        graph.unreachable_units
    );
    index.dead = dead::derive(&index.nodes, &paths, &index.edges, &index.entry_points, &index.calls, &graph);
    index.graph = Some(graph);

    if std::env::var("KLAURO_REPORT_UNRESOLVED").is_ok() {
        let mut ranked: Vec<(String, u32)> = resolution.unresolved_names.into_iter().collect();
        ranked.sort_by(|left, right| right.1.cmp(&left.1));
        for (name, count) in ranked.iter().take(40) {
            eprintln!("  unresolved {count:6} {name}");
        }
    }

    let verify_started = Instant::now();
    let verification = verify::derive(
        &index.nodes,
        &index.edges,
        &paths,
        &index.calls,
        &index.metrics,
        &index.entry_points,
        index.graph.as_ref().expect("the graph is derived before verification"),
        &index
            .architecture
            .iter()
            .flat_map(|architecture| architecture.projects.iter())
            .flat_map(|project| project.routes.iter())
            .collect::<Vec<_>>(),
    );
    eprintln!(
        "verify {:?} | cases {} | suites {} | asserting {} | standing in {} | served {} of {} units | tested {} | entries tested {} of {} | routes asked {} | gaps {} | invariants {}",
        verify_started.elapsed(),
        verification.cases.len() as u32 - verification.suites,
        verification.suites,
        verification.asserting,
        verification.standing_in,
        verification.coverage.served,
        verification.coverage.units,
        verification.coverage.served_and_tested,
        verification.coverage.entry_points_tested,
        verification.coverage.entry_points,
        verification.coverage.requested_routes,
        verification.gaps.len(),
        verification.invariants.len()
    );
    index.verification = Some(verification);

    let conform_started = Instant::now();
    let conformance = conform::derive(
        &paths,
        &languages,
        &index.nodes,
        &index.calls,
        &index.entry_points,
        &index.exit_points,
        index.verification.as_ref().expect("verification precedes conformance"),
        index.dependencies.as_ref().expect("dependencies precede conformance"),
    );
    eprintln!(
        "conform {:?} | conventions {} | departures {} | sprawl {}",
        conform_started.elapsed(),
        conformance.conventions.len(),
        conformance.departures,
        conformance.sprawl.len()
    );
    index.conformance = Some(conformance);

    let history_started = Instant::now();
    let history = history::read(&root, &paths);
    if let Some(found) = history.as_ref() {
        eprintln!(
            "history {:?} | commits {} | files touched {} | co-change pairs {}",
            history_started.elapsed(),
            found.commits,
            found.touched,
            found.co_change.len()
        );
    }
    index.history = history;
    let composition_started = Instant::now();
    index.composition = index.partition.as_ref().and_then(|partition| {
        composition::derive(
            &root,
            partition,
            index.history.as_ref(),
            &paths,
            &index.edges,
            &index.entry_points,
            &index.exit_points,
            &index.calls,
            index.scope.as_ref().map(|scope| scope.deployables.as_slice()).unwrap_or(&[]),
        )
    });
    if let Some(found) = index.composition.as_ref() {
        eprintln!(
            "composition {:?} | children {} | seams {} | dependencies {}",
            composition_started.elapsed(),
            found.children.len(),
            found.seams.len(),
            found.dependencies.len()
        );
    }

    let health_started = Instant::now();
    let health = health::derive(
        &index.nodes,
        &paths,
        &index.entry_points,
        index.graph.as_ref().expect("the graph precedes health"),
        index.verification.as_ref().expect("verification precedes health"),
        index.history.as_ref(),
    );
    eprintln!(
        "health {:?} | projects {} | noted {}",
        health_started.elapsed(),
        health.projects.len(),
        health.noted
    );
    index.health = Some(health);

    let comprehend_started = Instant::now();
    let comprehension = comprehend::derive(
        &index.nodes,
        &paths,
        &index.edges,
        &index.entry_points,
        &index.exit_points,
        index.roles.as_ref().expect("roles precede comprehension"),
        &declared_tables,
        &index.calls,
        &index.type_references,
        &index.metrics,
        &index
            .patterns
            .as_ref()
            .map(|found| {
                found.messages.iter().filter(|message| message.kind == "event").map(|message| message.message.as_str()).collect()
            })
            .unwrap_or_default(),
        &open_calls,
        &index.locals,
    );
    if audit::asked() {
        let looked = audit::look(
            root.to_str().unwrap_or_default(),
            &index.files,
            &index.nodes,
            &index.entry_points,
            &index.exit_points,
        );
        eprintln!(
            "audit | asked about {} files | offered {} | malformed {} | written {}{}",
            looked.asked,
            looked.offered,
            looked.malformed,
            looked.written,
            match looked.graded {
                true => "",
                false => " | no grader, nothing kept",
            }
        );
    }
    let mut comprehension = comprehension;
    let mut spoken_languages: std::collections::BTreeMap<&str, u32> =
        std::collections::BTreeMap::new();
    for file in &index.files {
        if let Some(language) = file.language {
            *spoken_languages.entry(language).or_default() += 1;
        }
    }
    let mut languages: Vec<(String, u32)> = spoken_languages
        .into_iter()
        .map(|(language, count)| (language.to_string(), count))
        .collect();
    languages.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    let frameworks: Vec<String> = index
        .dependencies
        .as_ref()
        .map(|found| {
            let mut leading: Vec<&dependencies::Dependency> = found
                .dependencies
                .iter()
                .filter(|dependency| dependency.role != "unknown" && dependency.imports > 0)
                .collect();
            leading.sort_by(|left, right| right.imports.cmp(&left.imports));
            leading.iter().take(10).map(|dependency| dependency.name.clone()).collect()
        })
        .unwrap_or_default();
    let scope = std::env::var("KLAURO_PROJECT_SCOPE").ok().filter(|held| !held.is_empty()).unwrap_or_else(|| {
        std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone()).display().to_string()
    });
    let told = comprehend::Telling {
        scope: &scope,
        shape: index.architecture.as_ref().map(|shaped| shaped.shape).unwrap_or("unknown"),
        serving: index.architecture.as_ref().map(|shaped| shaped.serving_projects).unwrap_or(0),
        routes: index.architecture.as_ref().map(|shaped| shaped.routes).unwrap_or(0),
        shipped: index
            .scope
            .as_ref()
            .map(|scoped| {
                scoped.deployables.iter().filter(|unit| unit.bundled_into.is_none()).count() as u32
            })
            .unwrap_or(0),
        projects: index.partition.as_ref().map(|split| split.sub_projects.len()).unwrap_or(1),
        within: index
            .partition
            .as_ref()
            .map(|split| split.sub_projects.iter().map(|part| part.id.clone()).collect())
            .unwrap_or_default(),
        languages,
        frameworks,
        composition: index.composition.as_ref(),
    };
    let named = comprehend::author(&mut comprehension, &root, &index.nodes, &paths, &told);
    eprintln!(
        "comprehend {:?} | capabilities {} | flows {} | terminal {} | chained {} | entities {} | named {} | asked {}",
        comprehend_started.elapsed(),
        comprehension.capabilities.len(),
        comprehension.flows.len(),
        comprehension.terminal,
        comprehension.chained,
        comprehension.entities.len(),
        named,
        reach::asked()
    );
    if std::env::var("KLAURO_REPORT_ENTITIES").is_ok() {
        for entity in &comprehension.entities {
            eprintln!(
                "  entity {} | written {} | read {} | addressed {} | {}",
                entity.declared_as,
                entity.written_by.len(),
                entity.read_by.len(),
                entity.addressed_by,
                entity.declared_in.as_deref().unwrap_or("")
            );
        }
    }
    if let (Some(composition), Some(summary)) = (index.composition.as_mut(), comprehension.derivation.take()) {
        composition.promoted = summary.promoted;
        composition.not_promoted = summary.not_promoted;
    }
    index.comprehension = Some(comprehension);

    if std::env::var("KLAURO_REPORT_COVERAGE").is_ok() {
        let mut seen = rustc_hash::FxHashSet::with_capacity_and_hasher(index.nodes.len(), Default::default());
        let mut repeated = 0usize;
        let mut first: Option<&str> = None;
        for node in &index.nodes {
            if !seen.insert(node.id.as_str()) {
                repeated += 1;
                first.get_or_insert(node.id.as_str());
            }
        }
        match first {
            Some(id) => eprintln!("  repeated declarations {repeated} first {id}"),
            None => eprintln!("  repeated declarations {repeated}"),
        }
        let mut standing: Option<&str> = None;
        let dangling = index
            .edges
            .iter()
            .flat_map(|edge| [edge.source.as_str(), edge.target.as_str()])
            .filter(|held| !seen.contains(held))
            .inspect(|held| {
                standing.get_or_insert(held);
            })
            .count();
        match standing {
            Some(id) => eprintln!("  unattached edges {dangling} first {id}"),
            None => eprintln!("  unattached edges {dangling}"),
        }
    }

    if let Some(message) = author::failed_for_unanswered() {
        eprintln!("{message}");
        std::process::exit(2);
    }

    let emit_started = Instant::now();
    let strings = std::cell::RefCell::new(wire::Strings::default());
    let body = rmp_serde::to_vec(&wire::Interned::new(&index, &strings)).unwrap();
    let table = rmp_serde::to_vec(&strings.into_inner().into_values()).unwrap();
    let mut out = std::io::stdout().lock();
    out.write_all(&table).unwrap();
    out.write_all(&body).unwrap();
    out.flush().unwrap();
    eprintln!("emit {:?} | {} bytes", emit_started.elapsed(), table.len() + body.len());
}
