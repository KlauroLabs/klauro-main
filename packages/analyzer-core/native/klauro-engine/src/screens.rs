use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::entry_exit::EntryPoint;
use crate::model::*;
use crate::paths::is_test;
use crate::resolve::Resolution;

pub const ROUTED_SCREEN: &str = "screen_routed";
pub const MOUNTED_SCREEN: &str = "screen_mounted";
pub const DEFAULT_SCREEN: &str = "screen_default_export";
pub const LOADED_SCREEN: &str = "screen_loaded";

const IMPORT_MARK: &str = "import:";
const LOADER_LINES: u32 = 6;

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
    imports: &[ImportFact],
    locals: &[LocalBinding],
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
    let mut default_named: HashMap<u32, &str> = HashMap::default();
    let mut hinted: HashMap<(u32, u32), &str> = HashMap::default();
    for registration in registrations {
        match registration.registrar.as_str() {
            DEFAULT_SCREEN => {
                default_named.entry(registration.file).or_insert(registration.handler.as_str());
            }
            LOADED_SCREEN => {
                hinted.insert((registration.file, registration.line), registration.handler.as_str());
            }
            _ => {}
        }
    }
    let mut modules: HashMap<u32, &IndexNode> = HashMap::default();
    for node in nodes.iter().filter(|node| node.kind == NodeKind::Module) {
        modules.entry(node.file).or_insert(node);
    }

    let mut loaded_within: HashMap<u32, Vec<(u32, &str)>> = HashMap::default();
    for fact in imports.iter().filter(|fact| fact.names.is_empty()) {
        loaded_within.entry(fact.file).or_default().push((fact.line, fact.specifier.as_str()));
    }
    let mut paths_named: HashMap<&str, Option<&str>> = HashMap::default();
    for local in locals.iter().filter(|local| local.unit.is_empty() && local.name.contains('.')) {
        let Some(written) = local.written.as_deref().filter(|written| written.starts_with('/')) else { continue };
        paths_named
            .entry(local.name.as_str())
            .and_modify(|held| {
                if *held != Some(written) {
                    *held = None;
                }
            })
            .or_insert(Some(written));
    }

    let mut top_level: HashMap<u32, Vec<&IndexNode>> = HashMap::default();
    for node in nodes.iter().filter(|node| (node.kind.is_unit() || node.kind == NodeKind::Class) && node.name.chars().next().is_some_and(char::is_uppercase)) {
        if node.parent.as_deref().is_some_and(|parent| files.get(node.file as usize).is_some_and(|path| parent == path)) {
            top_level.entry(node.file).or_default().push(node);
        }
    }

    let in_file = |file: u32, name: &str| node_in_file(&by_id, &resolution.local, file, name);
    let unit_of_file = |file: u32, export: Option<&str>| -> Option<&IndexNode> {
        if let Some(export) = export
            && let Some(found) = in_file(file, export)
        {
            return Some(found);
        }
        if let Some(named) = default_named.get(&file)
            && let Some(found) = in_file(file, named)
        {
            return Some(found);
        }
        if let Some(named) = default_export.get(&file).filter(|named| **named != "default")
            && let Some(found) = in_file(file, named)
        {
            return Some(found);
        }
        let path = files[file as usize].as_str();
        let stem = crate::paths::basename(path);
        let stem = stem.split('.').next().unwrap_or(stem);
        let folder = folder_of(path).rsplit('/').next().unwrap_or_default();
        let named_like_its_place = [stem, folder]
            .into_iter()
            .filter(|held| !held.is_empty() && *held != "index")
            .find_map(|held| in_file(file, held).filter(|found| found.kind.is_declaration()));
        if named_like_its_place.is_some() {
            return named_like_its_place;
        }
        let spoken_alike = |held: &str| -> String {
            held.chars().filter(|letter| !matches!(letter, '_' | '-')).flat_map(char::to_lowercase).collect()
        };
        let place = spoken_alike(if stem == "index" { folder } else { stem });
        let declared = top_level.get(&file).map(Vec::as_slice).unwrap_or(&[]);
        let named_alike = declared.iter().copied().find(|held| spoken_alike(&held.name) == place);
        if named_alike.is_some() {
            return named_alike;
        }
        let exported: Vec<&&IndexNode> = declared.iter().filter(|held| held.modifiers.exported).collect();
        if let [only] = exported.as_slice() {
            return Some(**only);
        }
        if let [only] = declared {
            return Some(*only);
        }
        modules.get(&file).copied()
    };
    let followed_through_its_loader = |found: &'_ IndexNode| -> Option<&IndexNode> {
        if !found.kind.is_unit() || found.span.end_line.saturating_sub(found.span.line) > LOADER_LINES {
            return None;
        }
        let (line, specifier) = *loaded_within
            .get(&found.file)?
            .iter()
            .find(|(line, _)| *line >= found.span.line && *line <= found.span.end_line)?;
        let reached = *resolution.reached.get(&(found.file, specifier.to_string()))?;
        let wanted = hinted.get(&(found.file, line)).copied();
        unit_of_file(reached, wanted).filter(|held| held.kind != NodeKind::Module)
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
        let handler = followed_through_its_loader(handler).unwrap_or(handler);
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
        let label = match paths_named.get(registration.label.as_str()) {
            Some(Some(path)) => match path.len() > 1 {
                true => path.trim_end_matches('/').to_string(),
                false => path.to_string(),
            },
            _ => registration.label.clone(),
        };
        found.push(EntryPoint {
            id: format!("entry:{}:screen:{}", handler.id, label),
            kind: "ui",
            name: label.clone(),
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
