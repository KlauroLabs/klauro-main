mod discovery;
mod language_tables;
mod entry_exit;
mod externals;
mod graph;
mod icelot;
mod model;
mod resolve;
mod source_rewrite;
mod typescript;

use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use rayon::prelude::*;
use serde::Serialize;

use model::FileFacts;

#[derive(Serialize)]
struct Index {
    root: String,
    files: Vec<String>,
    nodes: Vec<model::IndexNode>,
    edges: Vec<model::IndexEdge>,
    imports: Vec<model::ImportFact>,
    exports: Vec<model::ExportFact>,
    calls: Vec<model::CallFact>,
    type_references: Vec<model::TypeReferenceFact>,
    metrics: Vec<model::UnitMetricsEntry>,
    entry_points: Vec<entry_exit::EntryPoint>,
    exit_points: Vec<entry_exit::ExitPoint>,
    icelot: Vec<icelot::Icelot>,
    graph: Option<graph::GraphFacts>,
    skipped_directories: Vec<String>,
    nested_repositories: Vec<String>,
}

fn extract(path: &str, absolute: &std::path::Path, file: u32) -> Option<FileFacts> {
    let mut parser = typescript::parser_for(path)?;
    let mut source = std::fs::read(absolute).ok()?;
    source_rewrite::grammar_limitations(&mut source);
    let tree = parser.parse(&source, None)?;
    if std::env::var("KLAURO_REPORT_PARSE_ERRORS").is_ok()
        && let Some((line, kind)) = typescript::first_error(tree.root_node())
    {
        let text = String::from_utf8_lossy(&source);
        let snippet = text.lines().nth(line as usize - 1).unwrap_or("").trim();
        eprintln!("{path}:{line} [{kind}] {}", &snippet[..snippet.len().min(90)]);
    }
    let lines = source.iter().filter(|byte| **byte == b'\n').count() as u32 + 1;
    Some(typescript::Extractor::new(&source, file, path).run(&tree, path, lines))
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
        .filter_map(|(file, entry)| extract(&entry.path, &entry.absolute, file as u32))
        .collect();
    let parsed = parse_started.elapsed();

    let mut index = Index {
        root: root.to_string_lossy().to_string(),
        files: found.files.iter().map(|file| file.path.clone()).collect(),
        nodes: Vec::new(),
        edges: Vec::new(),
        imports: Vec::new(),
        exports: Vec::new(),
        calls: Vec::new(),
        type_references: Vec::new(),
        metrics: Vec::new(),
        entry_points: Vec::new(),
        exit_points: Vec::new(),
        icelot: Vec::new(),
        graph: None,
        skipped_directories: found.skipped_directories,
        nested_repositories: found.nested_repositories,
    };
    let mut parse_errors = 0;
    let report_errors = std::env::var("KLAURO_REPORT_PARSE_ERRORS").is_ok();
    for file in facts {
        if report_errors && file.parse_errors > 0 {
            eprintln!("parse errors {} in {}", file.parse_errors, index.files[file.nodes[0].file as usize]);
        }
        index.nodes.extend(file.nodes);
        index.edges.extend(file.edges);
        index.imports.extend(file.imports);
        index.exports.extend(file.exports);
        index.calls.extend(file.calls);
        index.type_references.extend(file.type_references);
        index.metrics.extend(file.metrics);
        parse_errors += file.parse_errors;
    }

    let resolve_started = Instant::now();
    let resolution = resolve::resolve(&resolve::Index {
        files: &index.files,
        nodes: &index.nodes,
        imports: &index.imports,
        calls: &index.calls,
        type_references: &index.type_references,
    });
    let resolved = resolve_started.elapsed();
    let resolved_edges = resolution.edges.len();
    index.edges.extend(resolution.edges);
    index.nodes.extend(resolution.external_nodes);

    let derive_started = Instant::now();
    let derived = entry_exit::derive(&index.nodes, &index.calls, &index.files, &resolution.modules);
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

    eprintln!(
        "resolve {:?} | resolved edges {} | package calls {} | runtime calls {} | unresolved {} | no caller {}",
        resolved, resolved_edges, resolution.package_calls, resolution.runtime_calls, resolution.unresolved_calls, resolution.no_caller
    );
    if std::env::var("KLAURO_REPORT_UNRESOLVED").is_ok() {
        let mut ranked: Vec<(String, u32)> = resolution.unresolved_names.into_iter().collect();
        ranked.sort_by(|left, right| right.1.cmp(&left.1));
        for (name, count) in ranked.iter().take(40) {
            eprintln!("  unresolved {count:6} {name}");
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

    let serialized = serde_json::to_vec(&index).unwrap();
    std::io::stdout().write_all(&serialized).unwrap();
}
