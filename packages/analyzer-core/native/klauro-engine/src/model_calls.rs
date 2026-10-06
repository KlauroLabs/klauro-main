use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::entry_exit::ExitPoint;
use crate::libraries::named_by;
use crate::model::{CallFact, ImportFact, LocalBinding};
use crate::names;

static TABLE: &str = include_str!("../data/model_calls.tsv");

pub const ACTION: &str = "model-call";

struct Library {
    package: &'static str,
    factories: Vec<&'static str>,
    statics: Vec<&'static str>,
    instances: Vec<&'static str>,
}

fn libraries() -> &'static [Library] {
    static HELD: std::sync::OnceLock<Vec<Library>> = std::sync::OnceLock::new();
    HELD.get_or_init(|| {
        let mut held: Vec<Library> = Vec::new();
        for line in TABLE.lines() {
            let mut columns = line.split('\t');
            let (Some(package), Some(role), Some(names)) = (columns.next(), columns.next(), columns.next()) else { continue };
            let at = match held.iter().position(|library| library.package == package) {
                Some(at) => at,
                None => {
                    held.push(Library { package, factories: Vec::new(), statics: Vec::new(), instances: Vec::new() });
                    held.len() - 1
                }
            };
            let spoken: Vec<&'static str> = names.split(',').filter(|name| !name.is_empty()).collect();
            match role {
                "factory" => held[at].factories = spoken,
                "static" => held[at].statics = spoken,
                "instance" => held[at].instances = spoken,
                _ => {}
            }
        }
        held
    })
}

fn imported_by_file<'a>(imports: &'a [ImportFact]) -> HashMap<u32, Vec<&'a Library>> {
    let mut held: HashMap<u32, Vec<&'a Library>> = HashMap::default();
    for import in imports {
        for library in libraries().iter().filter(|library| named_by(&import.specifier, library.package)) {
            let present = held.entry(import.file).or_default();
            if !present.iter().any(|known| known.package == library.package) {
                present.push(library);
            }
        }
    }
    held
}

pub fn kept_by_a_model_variable(
    calls: &[CallFact],
    files: &[String],
    locals: &[LocalBinding],
    imports: &[ImportFact],
    existing: &[ExitPoint],
) -> Vec<ExitPoint> {
    let by_file = imported_by_file(imports);
    if by_file.is_empty() {
        return Vec::new();
    }
    let mut models: HashMap<(u32, &str), &Library> = HashMap::default();
    for local in locals {
        let Some(libraries) = by_file.get(&local.file) else { continue };
        let Some(called) = local.from_call.as_deref() else { continue };
        let factory = names::leaf(called).to_ascii_lowercase();
        if let Some(library) = libraries.iter().find(|library| library.factories.contains(&factory.as_str())) {
            models.insert((local.file, local.name.as_str()), library);
        }
    }
    let mut instances: HashMap<(u32, &str), &Library> = HashMap::default();
    for local in locals {
        let Some(constructed) = local.constructed.as_deref() else { continue };
        if let Some(library) = models.get(&(local.file, names::root(constructed))) {
            instances.insert((local.file, local.name.as_str()), library);
        }
    }
    if models.is_empty() {
        return Vec::new();
    }
    let mut seen: HashSet<String> = HashSet::default();
    let reached: HashSet<(u32, u32, &str)> = existing.iter().map(|exit| (exit.file, exit.line, exit.name.as_str())).collect();
    let mut found = Vec::new();
    for (position, call) in calls.iter().enumerate() {
        let Some(receiver) = call.receiver.as_deref() else { continue };
        if files.get(call.file as usize).is_none_or(|path| crate::paths::is_test(path)) {
            continue;
        }
        let named = names::root(receiver);
        let operation = names::leaf(&call.callee);
        let lowered = operation.to_ascii_lowercase();
        let on_the_model = receiver == named
            && models.get(&(call.file, named)).is_some_and(|library| library.statics.contains(&lowered.as_str()));
        let on_an_instance = receiver == named
            && instances.get(&(call.file, named)).is_some_and(|library| library.instances.contains(&lowered.as_str()));
        if !on_the_model && !on_an_instance {
            continue;
        }
        let Some(source) = call.caller.clone() else { continue };
        let spelled = format!("{named}.{operation}");
        if reached.contains(&(call.file, call.line, spelled.as_str())) {
            continue;
        }
        let id = format!("exit:{}:{}:model", files[call.file as usize], position);
        if !seen.insert(id.clone()) {
            continue;
        }
        found.push(ExitPoint {
            id,
            kind: "database",
            name: spelled,
            source,
            target: named.to_string(),
            operation: operation.to_string(),
            file: call.file,
            line: call.line,
            awaited: call.context.awaited,
            addressed: None,
            service: None,
            method: None,
            origin: None,
            action: Some(ACTION),
        });
    }
    found
}
