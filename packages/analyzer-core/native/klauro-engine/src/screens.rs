use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::entry_exit::EntryPoint;
use crate::model::*;
use crate::paths::is_test;
use crate::resolve::Resolution;

pub const ROUTED_SCREEN: &str = "screen_routed";
pub const MOUNTED_SCREEN: &str = "screen_mounted";

const IMPORT_MARK: &str = "import:";

pub fn imported_handler(specifier: &str, export: Option<&str>) -> String {
    match export {
        Some(export) => format!("{IMPORT_MARK}{specifier}#{export}"),
        None => format!("{IMPORT_MARK}{specifier}"),
    }
}

pub fn split_imported(handler: &str) -> (&str, Option<&str>) {
    let held = handler.strip_prefix(IMPORT_MARK).unwrap_or(handler);
    match held.split_once('#') {
        Some((specifier, export)) => (specifier, Some(export)),
        None => (held, None),
    }
}

fn folder_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(folder, _)| folder).unwrap_or("")
}

fn beneath(path: &str, folder: &str) -> bool {
    folder.is_empty() || path == folder || path.starts_with(&format!("{folder}/"))
}

fn node_in_file<'n>(
    nodes: &HashMap<&str, &'n IndexNode>,
    local: &HashMap<(u32, String), String>,
    file: u32,
    name: &str,
) -> Option<&'n IndexNode> {
    let id = local.get(&(file, name.to_string()))?;
    nodes.get(id.as_str()).copied()
}

pub fn drawn(
    nodes: &[IndexNode],
    registrations: &[RegistrationFact],
    exports: &[ExportFact],
    files: &[String],
    resolution: &Resolution,
) -> Vec<EntryPoint> {
    if !registrations.iter().any(|held| held.registrar == ROUTED_SCREEN || held.registrar == MOUNTED_SCREEN) {
        return Vec::new();
    }
    let by_id: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut default_export: HashMap<u32, &str> = HashMap::default();
    for export in exports.iter().filter(|held| held.default_export && held.reexport_from.is_none()) {
        default_export.entry(export.file).or_insert(export.name.as_str());
    }
    let mut modules: HashMap<u32, &IndexNode> = HashMap::default();
    for node in nodes.iter().filter(|node| node.kind == NodeKind::Module) {
        modules.entry(node.file).or_insert(node);
    }

    let in_file = |file: u32, name: &str| node_in_file(&by_id, &resolution.local, file, name);
    let unit_of_file = |file: u32, export: Option<&str>| -> Option<&IndexNode> {
        if let Some(export) = export
            && let Some(found) = in_file(file, export)
        {
            return Some(found);
        }
        if let Some(named) = default_export.get(&file).filter(|named| **named != "default")
            && let Some(found) = in_file(file, named)
        {
            return Some(found);
        }
        let stem = crate::paths::basename(&files[file as usize]);
        let stem = stem.split('.').next().unwrap_or(stem);
        if let Some(found) = in_file(file, stem).filter(|found| found.kind.is_declaration()) {
            return Some(found);
        }
        modules.get(&file).copied()
    };
    let resolve = |registration: &RegistrationFact| -> Option<&IndexNode> {
        let file = registration.file;
        if registration.handler.starts_with(IMPORT_MARK) {
            let (specifier, export) = split_imported(&registration.handler);
            let reached = *resolution.reached.get(&(file, specifier.to_string()))?;
            return unit_of_file(reached, export);
        }
        let name = registration.handler.as_str();
        if let Some(found) = resolution
            .imported
            .get(&(file, name.to_string()))
            .and_then(|id| by_id.get(id.as_str()).copied())
        {
            return Some(found);
        }
        if let Some(through) = resolution.through.get(&(file, name.to_string()))
            && let Some(target) = files.iter().position(|path| path == through)
            && let Some(found) = unit_of_file(target as u32, None).filter(|found| found.kind != NodeKind::Module)
        {
            return Some(found);
        }
        in_file(file, name)
    };

    let routed_beneath: Vec<&str> = registrations
        .iter()
        .filter(|held| held.registrar == ROUTED_SCREEN && !is_test(&files[held.file as usize]))
        .map(|held| folder_of(files[held.file as usize].as_str()))
        .collect();

    let mut seen: HashSet<(String, String)> = HashSet::default();
    let mut found = Vec::new();
    let mut ordered: Vec<&RegistrationFact> = registrations
        .iter()
        .filter(|held| held.registrar == ROUTED_SCREEN || held.registrar == MOUNTED_SCREEN)
        .collect();
    ordered.sort_by_key(|held| held.registrar != ROUTED_SCREEN);
    let mut routed_handlers: HashSet<String> = HashSet::default();
    for registration in ordered {
        let path = files[registration.file as usize].as_str();
        if is_test(path) {
            continue;
        }
        let mounting = registration.registrar == MOUNTED_SCREEN;
        if mounting {
            let home = folder_of(path);
            if routed_beneath.iter().any(|folder| beneath(folder, home) || beneath(home, folder)) {
                continue;
            }
        }
        let Some(handler) = resolve(registration) else { continue };
        if handler.kind == NodeKind::Module && handler.name == path {
            continue;
        }
        if mounting && routed_handlers.contains(&handler.id) {
            continue;
        }
        if !seen.insert((handler.id.clone(), registration.label.clone())) {
            continue;
        }
        if !mounting {
            routed_handlers.insert(handler.id.clone());
        }
        found.push(EntryPoint {
            id: format!("entry:{}:screen:{}", handler.id, registration.label),
            kind: "ui",
            name: registration.label.clone(),
            method: None,
            path: None,
            handler: handler.id.clone(),
            file: handler.file,
            line: handler.span.line,
            guards: Vec::new(),
            registrar: registration.registrar.clone(),
            unshipped: None,
        });
    }
    found
}
