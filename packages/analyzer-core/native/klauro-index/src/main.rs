mod architecture;
mod dependencies;
mod discovery;
mod dockerfile;
mod language_tables;
mod entry_exit;
mod generated;
mod generic;
mod externals;
mod graph;
mod language;
mod icelot;
mod model;
mod paths;
mod resolve;
mod roles;
mod route;
mod scope;
mod source_rewrite;
mod structured;
mod subproject;
mod typescript;
mod wire;

use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use rayon::prelude::*;
use serde::Serialize;

use model::FileFacts;

#[derive(Serialize)]
struct IndexedFile {
    path: String,
    kind: discovery::FileKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<&'static str>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    extracted: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    oversize: bool,
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
    locals: Vec<model::LocalBinding>,
    entry_points: Vec<entry_exit::EntryPoint>,
    exit_points: Vec<entry_exit::ExitPoint>,
    icelot: Vec<icelot::Icelot>,
    graph: Option<graph::GraphFacts>,
    dependencies: Option<dependencies::Dependencies>,
    roles: Option<roles::Roles>,
    architecture: Option<architecture::Architecture>,
    scope: Option<scope::Scope>,
    partition: Option<subproject::Partition>,
    skipped_directories: Vec<String>,
    nested_repositories: Vec<String>,
}

fn extract(
    path: &str,
    absolute: &std::path::Path,
    file: u32,
    language_id: Option<&str>,
) -> Option<FileFacts> {
    if let Some(mut parser) = typescript::parser_for(path)
        .or_else(|| typescript::parser_for_language(language_id?))
    {
        let mut source = std::fs::read(absolute).ok()?;
        if generated::is_generated(&source) {
            return None;
        }
        source_rewrite::grammar_limitations(&mut source);
        let tree = parser.parse(&source, None)?;
        report_first_error(path, &source, &tree);
        let lines = source.iter().filter(|byte| **byte == b'\n').count() as u32 + 1;
        return Some(typescript::Extractor::new(&source, file, path).run(&tree, path, lines));
    }
    if dockerfile::is_dockerfile(path) {
        let source = std::fs::read_to_string(absolute).ok()?;
        return Some(dockerfile::extract(&source, file, path));
    }
    let declared = language_id.or_else(|| language_of(path));
    if let Some(id) = declared
        && let Some((mut parser, spec)) = structured::parser_for(id)
    {
        let source = std::fs::read(absolute).ok()?;
        if generated::is_generated(&source) {
            return None;
        }
        let tree = parser.parse(&source, None)?;
        let lines = source.iter().filter(|byte| **byte == b'\n').count() as u32 + 1;
        return Some(structured::Extractor::new(&source, file, path, spec).run(&tree, path, lines));
    }
    let (language, spec) = language::language_for(declared?)?;
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&language).ok()?;
    let source = std::fs::read(absolute).ok()?;
    if generated::is_generated(&source) {
        return None;
    }
    let tree = parser.parse(&source, None)?;
    let lines = source.iter().filter(|byte| **byte == b'\n').count() as u32 + 1;
    Some(generic::Extractor::new(&source, file, path, spec).run(&tree, path, lines))
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

fn main() {
    let root = std::env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let started = Instant::now();
    let found = discovery::discover(&root);
    let discovered = started.elapsed();

    let parse_started = Instant::now();
    let facts: Vec<FileFacts> = found
        .files
        .par_iter()
        .enumerate()
        .filter(|(_, entry)| route::readable(entry))
        .filter_map(|(file, entry)| extract(&entry.path, &entry.absolute, file as u32, entry.language))
        .collect();
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
        locals: Vec::new(),
        entry_points: Vec::new(),
        exit_points: Vec::new(),
        icelot: Vec::new(),
        graph: None,
        dependencies: None,
        roles: None,
        architecture: None,
        scope: None,
        partition: None,
        skipped_directories: found.skipped_directories,
        nested_repositories: found.nested_repositories,
    };
    let mut parse_errors = 0;
    let mut extracted_files = std::collections::HashSet::new();
    let report_errors = std::env::var("KLAURO_REPORT_PARSE_ERRORS").is_ok();
    for file in facts {
        if report_errors && file.parse_errors > 0 {
            eprintln!("parse errors {} in {}", file.parse_errors, index.files[file.nodes[0].file as usize].path);
        }
        extracted_files.insert(file.nodes[0].file);
        index.nodes.extend(file.nodes);
        index.edges.extend(file.edges);
        index.imports.extend(file.imports);
        index.exports.extend(file.exports);
        index.calls.extend(file.calls);
        index.type_references.extend(file.type_references);
        index.metrics.extend(file.metrics);
        index.registrations.extend(file.registrations);
        index.locals.extend(file.locals);
        parse_errors += file.parse_errors;
    }

    for (position, file) in index.files.iter_mut().enumerate() {
        file.extracted = extracted_files.contains(&(position as u32));
    }
    if std::env::var("KLAURO_REPORT_COVERAGE").is_ok() {
        let mut by_language: std::collections::BTreeMap<&str, (u32, u32)> =
            std::collections::BTreeMap::new();
        for file in &index.files {
            if file.kind != discovery::FileKind::Source {
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
    let resolution = resolve::resolve(&resolve::Index {
        files: &paths,
        nodes: &index.nodes,
        imports: &index.imports,
        calls: &index.calls,
        type_references: &index.type_references,
        locals: &index.locals,
    });
    let resolved = resolve_started.elapsed();
    let resolved_edges = resolution.edges.len();
    index.edges.extend(resolution.edges);
    index.nodes.extend(resolution.external_nodes);
    for node in index.nodes.iter_mut() {
        if let Some(owner) = resolution.method_owners.get(&node.id) {
            node.parent = Some(owner.clone());
        }
    }

    eprintln!(
        "resolve {:?} | edges {} | package {} | runtime {} | indirect {} | dynamic {} | unresolved {} | no caller {}",
        resolved,
        resolved_edges,
        resolution.package_calls,
        resolution.runtime_calls,
        resolution.indirect_calls,
        resolution.dynamic_calls,
        resolution.unresolved_calls,
        resolution.no_caller
    );

    let derive_started = Instant::now();
    let derived = entry_exit::derive(&index.nodes, &index.calls, &paths, &resolution.modules, &index.registrations, &resolution.local, &resolution.unique_units, &resolution.call_origins);
    let derived_elapsed = derive_started.elapsed();
    eprintln!(
        "entry and exit {:?} | entry points {} | exit points {}",
        derived_elapsed,
        derived.entry_points.len(),
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
        &index.exit_points,
        &external,
    );
    eprintln!("icelot {:?} | units {}", icelot_started.elapsed(), index.icelot.len());

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
        "scope {:?} | deployables {} | shipped {} | assigned {} shared {} unscoped {}",
        scope_started.elapsed(),
        scope.deployables.len(),
        scope.deployables.iter().filter(|unit| unit.shipped).count(),
        scope.assigned_nodes,
        scope.shared_nodes,
        scope.unassigned_nodes
    );
    index.scope = Some(scope);

    let partition_started = Instant::now();
    let partition = subproject::derive(
        &paths,
        &index.nodes,
        &index.edges,
        &index.entry_points,
        &index.nested_repositories,
        &code,
        &index.scope.as_ref().map(|scope| scope.deployables.as_slice()).unwrap_or(&[]),
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
    let found = dependencies::derive(
        &index.imports,
        &paths,
        &index.entry_points,
        &index.exit_points,
        &dependencies::file_project(assignment),
    );
    eprintln!(
        "dependencies {:?} | packages {} | classified {} unclassified {}",
        dependencies_started.elapsed(),
        found.dependencies.len(),
        found.classified,
        found.unclassified
    );
    index.dependencies = Some(found);

    let roles_started = Instant::now();
    let found = roles::derive(&index.nodes, &index.edges, &index.entry_points);
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

    let emit_started = Instant::now();
    let strings = std::cell::RefCell::new(wire::Strings::default());
    let body = rmp_serde::to_vec(&wire::Interned::new(&index, &strings)).unwrap();
    let mut serialized = rmp_serde::to_vec(&strings.into_inner().into_values()).unwrap();
    serialized.extend_from_slice(&body);
    std::io::stdout().write_all(&serialized).unwrap();
    eprintln!("emit {:?} | {} bytes", emit_started.elapsed(), serialized.len());
}
