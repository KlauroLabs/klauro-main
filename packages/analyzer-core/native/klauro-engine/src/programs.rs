use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::entry_exit::{EntryPoint, Unshipped};
use crate::model::{CallFact, EdgeKind, ExportFact, IndexEdge, IndexNode, NodeKind};
use crate::paths;

static PROGRAMS: &str = include_str!("../data/programs.tsv");
const PROGRAM: &str = ":program";
const STARTS_THE_PACKAGE: &str = "package-script:start";
const REGISTERED_APPLICATION: &str = "registered-application";
static COMMAND_BREAKS: &[&str] = &["&&", "||", ";", "|"];

fn rows() -> impl Iterator<Item = [&'static str; 3]> {
    PROGRAMS.lines().filter_map(|line| line.splitn(3, '\t').collect::<Vec<_>>().try_into().ok())
}

fn listed(how: &str, value: &str) -> bool {
    rows().any(|[_, listed_how, listed_value]| listed_how == how && listed_value == value)
}

fn run_by_its_format(path: &str, language: Option<&str>) -> Option<&'static str> {
    let name = paths::basename(path).to_ascii_lowercase();
    let stem = name.split('.').next().unwrap_or_default();
    let extension = name.rsplit_once('.').map(|(_, extension)| extension).unwrap_or_default();
    rows().find_map(|[tool, how, value]| {
        let matched = match how {
            "language" => language == Some(value),
            "name" => name == value,
            "stem" => stem == value,
            "extension" => extension == value,
            _ => false,
        };
        matched.then_some(tool)
    })
}

fn program_of(segment: &str) -> Option<&str> {
    let mut tokens = segment.split_whitespace().skip_while(|token| token.split_once('=').is_some_and(|(named, _)| !named.is_empty() && !named.contains('/')));
    let mut first = tokens.next()?;
    while listed("launcher", first) {
        first = tokens.next()?;
    }
    if !listed("runner", paths::basename(first)) {
        return Some(first);
    }
    let mut after_a_flag = false;
    for token in tokens {
        if token.starts_with('-') {
            after_a_flag = !token.contains('=');
            continue;
        }
        if !after_a_flag {
            return Some(token);
        }
        after_a_flag = false;
    }
    None
}

fn starts_with_shebang(path: &Path) -> bool {
    let mut opening = [0u8; 3];
    std::fs::File::open(path).and_then(|mut file| file.read_exact(&mut opening)).is_ok() && matches!(&opening, b"#!/" | b"#! ")
}

fn normalized(directory: &str, token: &str) -> String {
    let token = token.trim_matches(['"', '\'']).trim_start_matches("./");
    let mut segments: Vec<&str> = directory.split('/').filter(|segment| !segment.is_empty()).collect();
    for segment in token.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            named => segments.push(named),
        }
    }
    segments.join("/")
}

fn run_by_a_package_script<'a>(nodes: &'a [IndexNode], paths: &[String], held: &HashMap<&str, u32>) -> Vec<(u32, &'a str)> {
    let mut found = Vec::new();
    for node in nodes.iter().filter(|node| node.parent.as_deref().is_some_and(|parent| parent.ends_with(":section:scripts"))) {
        let Some(manifest) = paths.get(node.file as usize).filter(|path| paths::basename(path) == "package.json") else { continue };
        let Some(command) = node.type_annotation.as_deref() else { continue };
        let directory = paths::directory_of(manifest);
        let mut spoken = command.trim_matches('"').to_string();
        for divider in COMMAND_BREAKS {
            spoken = spoken.replace(divider, "\n");
        }
        for program in spoken.lines().filter_map(program_of) {
            if let Some(file) = held.get(normalized(directory, program).as_str()) {
                found.push((*file, node.name.as_str()));
            }
        }
    }
    found
}

pub struct Sources<'a> {
    pub root: &'a Path,
    pub paths: &'a [String],
    pub languages: &'a [Option<&'a str>],
    pub nodes: &'a [IndexNode],
    pub calls: &'a [CallFact],
    pub exports: &'a [ExportFact],
    pub edges: &'a [IndexEdge],
    pub known: &'a [EntryPoint],
}

fn ends_the_process(call: &CallFact) -> bool {
    let spoken = [
        Some(call.callee.clone()),
        call.receiver.as_deref().map(|receiver| format!("{receiver}.{}", call.callee)),
        call.receiver.as_deref().map(|receiver| format!("{receiver}::{}", call.callee)),
    ];
    spoken.into_iter().flatten().any(|named| listed("exit", &named))
}

fn stands_alone_and_ends_the_process(sources: &Sources) -> HashSet<u32> {
    let exporting: HashSet<u32> = sources.exports.iter().map(|export| export.file).collect();
    let imported: HashSet<&str> = sources.edges.iter().filter(|edge| edge.kind == EdgeKind::Imports).map(|edge| edge.target.as_str()).collect();
    sources
        .calls
        .iter()
        .filter(|call| call.caller.is_none() && ends_the_process(call))
        .map(|call| call.file)
        .filter(|file| !exporting.contains(file) && sources.paths.get(*file as usize).is_some_and(|path| !imported.contains(path.as_str())))
        .collect()
}

pub fn run_as_programs(sources: &Sources) -> Vec<EntryPoint> {
    let Sources { root, paths, languages, nodes, known, .. } = *sources;
    let started: HashSet<u32> = known
        .iter()
        .filter(|entry| matches!(entry.kind, "lifecycle" | "cli"))
        .filter(|entry| entry.kind != "lifecycle" || run_by_its_format(&paths[entry.file as usize], languages.get(entry.file as usize).copied().flatten()).is_none())
        .map(|entry| entry.file)
        .collect();
    let modules: HashMap<u32, &str> = nodes.iter().filter(|node| node.kind == NodeKind::Module).map(|node| (node.file, node.id.as_str())).collect();
    let runnable = |file: u32| {
        let path = paths[file as usize].as_str();
        languages.get(file as usize).copied().flatten().is_some() && paths::is_hand_written_code(path) && !started.contains(&file) && modules.contains_key(&file)
    };
    let held: HashMap<&str, u32> = paths.iter().enumerate().map(|(at, path)| (path.as_str(), at as u32)).collect();
    let alone = stands_alone_and_ends_the_process(sources);
    let mut programs: BTreeMap<u32, String> = BTreeMap::new();
    let mut children: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
    for node in nodes {
        if let Some(parent) = node.parent.as_deref() {
            children.entry(parent).or_default().push(node);
        }
    }
    for registered in crate::subproject::registered_projects(paths, &children) {
        let Some(starts_at) = registered.starts_at else { continue };
        let found = held.get(starts_at.as_str()).copied().or_else(|| {
            ["ts", "js", "mts", "mjs", "tsx", "jsx"].iter().find_map(|extension| held.get(format!("{starts_at}.{extension}").as_str()).copied())
        });
        if let Some(file) = found.filter(|file| runnable(*file)) {
            programs.insert(file, REGISTERED_APPLICATION.to_string());
        }
    }
    for (file, script) in run_by_a_package_script(nodes, paths, &held) {
        if runnable(file) {
            programs.entry(file).or_insert_with(|| format!("package-script:{script}"));
        }
    }
    for (at, path) in paths.iter().enumerate() {
        let file = at as u32;
        if programs.contains_key(&file) || !runnable(file) {
            continue;
        }
        if let Some(tool) = run_by_its_format(path, languages.get(at).copied().flatten()) {
            programs.insert(file, format!("run-by:{tool}"));
        } else if starts_with_shebang(&root.join(path)) {
            programs.insert(file, "shebang".to_string());
        } else if alone.contains(&file) {
            programs.insert(file, "stands-alone".to_string());
        }
    }
    programs
        .into_iter()
        .map(|(file, registrar)| {
            let path = &paths[file as usize];
            let started_as_a_service = registrar == STARTS_THE_PACKAGE || registrar == REGISTERED_APPLICATION || registrar == "stands-alone";
            EntryPoint {
                id: format!("entry:{path}{PROGRAM}"),
                kind: if started_as_a_service { "lifecycle" } else { "cli" },
                name: paths::basename(path).split('.').next().unwrap_or_default().to_string(),
                method: None,
                path: None,
                handler: modules[&file].to_string(),
                file,
                line: 1,
                guards: Vec::new(),
                registrar,
                unshipped: None,
            }
        })
        .collect()
}

fn reads_its_command_line(call: &CallFact) -> bool {
    let spoken = [
        Some(call.callee.clone()),
        call.receiver.clone(),
        call.receiver.as_deref().map(|receiver| format!("{receiver}.{}", call.callee)),
        call.receiver.as_deref().map(|receiver| format!("{receiver}::{}", call.callee)),
    ];
    spoken.into_iter().flatten().any(|named| rows().any(|[_, how, value]| how == "argv" && (named == value || named.starts_with(&format!("{value}.")))))
}

pub fn commanded_programs(entries: &mut [EntryPoint], calls: &[CallFact]) {
    let reading: HashSet<u32> = calls.iter().filter(|call| reads_its_command_line(call)).map(|call| call.file).collect();
    for entry in entries.iter_mut().filter(|entry| entry.kind == "lifecycle" && reading.contains(&entry.file)) {
        entry.kind = "cli";
    }
}

pub fn set_aside_unserved_documents(entries: &mut [EntryPoint], files: &[String], scope: &crate::scope::Scope) {
    if !scope.deployables.iter().any(|unit| matches!(unit.category, "shipped" | "runnable")) {
        return;
    }
    for entry in entries.iter_mut().filter(|entry| entry.registrar == "served_document" && entry.unshipped.is_none()) {
        let path = files[entry.file as usize].as_str();
        let held = scope.deployables.iter().any(|unit| !unit.root.is_empty() && paths::contains(&unit.root, path))
            || scope.deployables.iter().flat_map(|unit| unit.ships.iter()).any(|shipped| !shipped.is_empty() && paths::contains(shipped, path))
            || scope.ships_the_source_of(path);
        if !held {
            entry.unshipped = Some(Unshipped {
                role: "documentation",
                basis: "unserved-document",
                evidence: format!("{path} is a page no deployable serves or ships"),
            });
        }
    }
}

fn program_name(path: &str) -> String {
    paths::basename(path).split('.').next().unwrap_or_default().to_ascii_lowercase().replace('_', "-")
}

fn names_the_program(literal: &str, program: &str) -> bool {
    let literal = literal.trim().trim_start_matches("./");
    if literal.contains(char::is_whitespace) || program_name(literal) != program_name(program) {
        return false;
    }
    let has_extension = paths::basename(literal).contains('.');
    match has_extension {
        true => crate::discovery::language_of(paths::basename(literal)).is_some() && paths::is_hand_written_code(literal),
        false => literal.contains('/') && program.rsplit_once('.').map_or(program, |(bare, _)| bare).ends_with(literal),
    }
}

fn is_a_program(entry: &EntryPoint) -> bool {
    matches!(entry.kind, "lifecycle" | "cli")
}

fn may_be_overruled(entry: &EntryPoint) -> bool {
    entry.unshipped.as_ref().is_none_or(|held| matches!(held.basis, "shipping-evidence" | "development-program"))
}

pub fn set_aside_development_programs(entries: &mut [EntryPoint], files: &[String], calls: &[CallFact], scope: &crate::scope::Scope) {
    let runs_something = scope.deployables.iter().any(|unit| matches!(unit.category, "shipped" | "runnable"));
    if !runs_something {
        return;
    }
    for entry in entries.iter_mut().filter(|entry| entry.id.ends_with(PROGRAM) && entry.unshipped.is_none()) {
        let path = files[entry.file as usize].as_str();
        let run_by_a_package_script = entry.registrar.starts_with("package-script:");
        let runtime = entry.registrar == STARTS_THE_PACKAGE
            || entry.registrar == REGISTERED_APPLICATION
            || scope.runs_file(path)
            || scope.ships_the_build_of(path)
            || (!run_by_a_package_script && scope.ships_file_by_convention(path));
        if runtime {
            continue;
        }
        entry.unshipped = Some(Unshipped {
            role: "tooling",
            basis: "development-program",
            evidence: format!("{path} is run by hand or by a development command ({}), and nothing shipped runs it", entry.registrar),
        });
    }
    let mut stems: HashMap<String, usize> = HashMap::default();
    for entry in entries.iter().filter(|entry| is_a_program(entry)) {
        *stems.entry(program_name(&files[entry.file as usize])).or_default() += 1;
    }
    let mut named_by: HashMap<String, Vec<(&str, u32)>> = HashMap::default();
    for call in calls.iter().filter(|call| files.get(call.file as usize).is_some_and(|path| !paths::is_test(path))) {
        for literal in &call.literals {
            let name = program_name(literal.trim());
            if stems.get(&name) == Some(&1) {
                named_by.entry(name).or_default().push((literal.as_str(), call.file));
            }
        }
    }
    loop {
        let hosting_aside: HashSet<u32> = entries.iter().filter(|entry| is_a_program(entry) && crate::unshipped::is_set_aside(entry.unshipped.as_ref())).map(|entry| entry.file).collect();
        let hosting_live: HashSet<u32> = entries.iter().filter(|entry| is_a_program(entry) && entry.unshipped.is_none()).map(|entry| entry.file).collect();
        let mut started = false;
        for entry in entries.iter_mut().filter(|entry| is_a_program(entry) && entry.unshipped.is_some() && may_be_overruled(entry)) {
            let path = files[entry.file as usize].as_str();
            let by_the_product = scope.ships_the_build_of(path) || named_by.get(&program_name(path)).is_some_and(|from| {
                from.iter().any(|(literal, file)| {
                    *file != entry.file && (!hosting_aside.contains(file) || hosting_live.contains(file)) && names_the_program(literal, path)
                })
            });
            if by_the_product {
                entry.unshipped = None;
                started = true;
            }
        }
        if !started {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_script_path_is_read_relative_to_its_manifest() {
        assert_eq!(normalized("tools/site", "./scripts/build.mjs"), "tools/site/scripts/build.mjs");
        assert_eq!(normalized("apps/web", "../../scripts/sync.sh"), "scripts/sync.sh");
        assert_eq!(normalized("", "\"bench/run.ts\""), "bench/run.ts");
    }

    #[test]
    fn the_program_is_what_a_runner_is_given_never_a_flag_s_value() {
        assert_eq!(program_of("node --import ./loader.mjs scripts/sync.mjs --dry"), Some("scripts/sync.mjs"));
        assert_eq!(program_of("NODE_ENV=production npx tsx bench/run.ts"), Some("bench/run.ts"));
        assert_eq!(program_of("./scripts/release.sh patch"), Some("./scripts/release.sh"));
        assert_eq!(program_of("vite --config app/vite.config.ts"), Some("vite"));
    }

    #[test]
    fn a_program_is_started_by_naming_its_file_never_by_a_word_it_shares() {
        assert!(names_the_program("analysis-worker.cjs", "apps/server/src/analysis-worker.ts"));
        assert!(names_the_program("./bin/immich-admin", "server/bin/immich-admin"));
        assert!(!names_the_program("assets", "lib/tasks/assets.rake"));
        assert!(!names_the_program("images/mastodon.svg", "lib/tasks/mastodon.rake"));
        assert!(!names_the_program("@mastodon/mastodon", "lib/tasks/mastodon.rake"));
    }

    #[test]
    fn a_program_reading_its_command_line_is_a_command() {
        let call = |receiver: Option<&str>, callee: &str| CallFact {
            file: 0,
            caller: None,
            callee: callee.to_string(),
            receiver: receiver.map(str::to_string),
            line: 1,
            column: 0,
            argument_count: 0,
            literals: Vec::new(),
            constructs: false,
            renders: false,
            type_arguments: Vec::new(),
            context: Default::default(),
            passes: Default::default(),
        };
        assert!(reads_its_command_line(&call(Some("std::env"), "args")));
        assert!(reads_its_command_line(&call(Some("process.argv"), "slice")));
        assert!(!reads_its_command_line(&call(Some("process.env"), "get")));
    }

    #[test]
    fn task_runner_files_and_shell_scripts_are_programs_by_their_format() {
        assert_eq!(run_by_its_format("lib/tasks/repo.rake", Some("ruby")), Some("rake"));
        assert_eq!(run_by_its_format("Rakefile", Some("ruby")), Some("rake"));
        assert_eq!(run_by_its_format("gulpfile.js", Some("javascript")), Some("gulp"));
        assert_eq!(run_by_its_format("scripts/release.sh", Some("shell")), Some("shell"));
        assert_eq!(run_by_its_format("app/models/user.rb", Some("ruby")), None);
    }
}
