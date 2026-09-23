mod alias;
mod architecture;
mod builtins;
mod audit;
mod author;
mod comprehend;
mod conform;
mod convention;
mod coverage;
mod bundler;
mod dependencies;
mod discovery;
mod dockerfile;
mod language_tables;
mod entry_exit;
mod generated;
mod history;
mod jev;
mod gomod;
mod generic;
mod externals;
mod graph;
mod health;
mod language;
mod icelot;
mod model;
mod names;
mod paths;
mod reach;
mod published;
mod resolve;
mod roles;
mod route;
mod scope;
mod tables;
mod source_rewrite;
mod structured;
mod subproject;
mod typescript;
mod verify;
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
    locals: Vec<model::LocalBinding>,
    entry_points: Vec<entry_exit::EntryPoint>,
    exit_points: Vec<entry_exit::ExitPoint>,
    icelot: Vec<icelot::Icelot>,
    graph: Option<graph::GraphFacts>,
    dependencies: Option<dependencies::Dependencies>,
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
) -> Read {
    let Ok(mut source) = std::fs::read(absolute) else {
        return Read::Unreadable;
    };
    if is_binary(&source) {
        return Read::Binary;
    }
    if generated::is_generated(&source) {
        return Read::Generated;
    }
    match read(path, &mut source, file, language_id) {
        Some(facts) => Read::Facts(Box::new(facts)),
        None => Read::Unreadable,
    }
}

use crate::model::{IndexNode, Modifiers, NodeKind, Span};

fn close_graph(index: &mut Index) {
    let declared: std::collections::HashSet<&str> =
        index.nodes.iter().map(|node| node.id.as_str()).collect();
    let known: std::collections::HashMap<&str, u32> = index
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
        facts.tables = tables::declared(source, path, file);
        if bundler::is_config(path) {
            facts.nodes.extend(bundler::declared_aliases(&tree, source, file, path));
        }
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
    let declared = language_id.or_else(|| language_of(path));
    if let Some(id) = declared
        && let Some((mut parser, spec)) = structured::parser_for(id)
    {
        let tree = parser.parse(&source, None)?;
        let mut facts = structured::Extractor::new(source, file, path, spec).run(&tree, path, lines(source));
        facts.tables = tables::declared(source, path, file);
        return Some(facts);
    }
    let (language, spec) = language::language_for(declared?)?;
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&language).ok()?;
    let tree = parser.parse(&source, None)?;
    let mut facts = generic::Extractor::new(source, file, path, spec).run(&tree, path, lines(source));
    facts.tables = tables::declared(source, path, file);
    Some(facts)
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
    let reads: Vec<(u32, Read)> = found
        .files
        .par_iter()
        .enumerate()
        .filter(|(_, entry)| route::readable(entry))
        .map(|(file, entry)| {
            (file as u32, extract(&entry.path, &entry.absolute, file as u32, entry.language))
        })
        .collect();
    let mut generated_files = std::collections::HashSet::new();
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
        locals: Vec::new(),
        entry_points: Vec::new(),
        exit_points: Vec::new(),
        icelot: Vec::new(),
        graph: None,
        dependencies: None,
        roles: None,
        verification: None,
        conformance: None,
        history: None,
        health: None,
        comprehension: None,
        architecture: None,
        scope: None,
        partition: None,
        skipped_directories: found.skipped_directories,
        nested_repositories: found.nested_repositories,
    };
    let mut declared_tables: Vec<tables::Table> = Vec::new();
    let mut parse_errors = 0;
    let mut extracted_files = std::collections::HashSet::new();
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
        index.locals.extend(file.locals);
        declared_tables.extend(file.tables);
        parse_errors += file.parse_errors;
    }

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
    });
    let internal_specifiers = std::mem::take(&mut resolution.internal_specifiers);
    let resolved = resolve_started.elapsed();
    let resolved_edges = resolution.edges.len();
    let imported_files = resolution
        .edges
        .iter()
        .filter(|edge| matches!(edge.kind, model::EdgeKind::Imports))
        .count();
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
    );
    let mut derived = derived;
    derived.exit_points.extend(entry_exit::kept_by_the_browser(&index.kept, &paths));
    derived
        .entry_points
        .extend(convention::conventional(&index.nodes, &paths, &index.exports));
    derived.entry_points.sort_by(|left, right| left.id.cmp(&right.id));
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
    index.entry_points = derived.entry_points;
    index.exit_points = derived.exit_points;

    let icelot_started = Instant::now();
    let external: std::collections::HashMap<String, ()> = resolution
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
    let scope = scope::derive(
        &paths,
        &manifests,
        &code,
        &index.nodes,
        &index.edges,
        &index.entry_points,
        &index.calls,
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
    let partition = subproject::derive(
        &paths,
        &index.nodes,
        &index.edges,
        &index.entry_points,
        &index.nested_repositories,
        &code,
        index.scope.as_ref().map(|scope| scope.deployables.as_slice()).unwrap_or(&[]),
    );
    let project_of: std::collections::HashMap<&str, &str> = partition
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
    let own: std::collections::HashSet<&str> = index
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
        .fold(std::collections::HashMap::new(), |mut counted, language| {
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
    if !kept.is_empty() {
        eprintln!("kept by a model | exits {}", kept.len());
        index.exit_points.extend(kept);
        index.exit_points.sort_by(|left, right| left.id.cmp(&right.id));
        index.exit_points.dedup_by(|left, right| left.id == right.id);
    }

    let graph_started = Instant::now();
    let mut exits_by_unit: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
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
    let told = comprehend::Telling {
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
    index.comprehension = Some(comprehension);

    if std::env::var("KLAURO_REPORT_COVERAGE").is_ok() {
        let mut seen = std::collections::HashSet::with_capacity(index.nodes.len());
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

    let emit_started = Instant::now();
    let strings = std::cell::RefCell::new(wire::Strings::default());
    let body = rmp_serde::to_vec(&wire::Interned::new(&index, &strings)).unwrap();
    let mut serialized = rmp_serde::to_vec(&strings.into_inner().into_values()).unwrap();
    serialized.extend_from_slice(&body);
    std::io::stdout().write_all(&serialized).unwrap();
    eprintln!("emit {:?} | {} bytes", emit_started.elapsed(), serialized.len());
}
