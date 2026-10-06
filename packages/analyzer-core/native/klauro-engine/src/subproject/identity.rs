use std::collections::BTreeMap;

use rayon::prelude::*;

use crate::comprehend::{Capability, Product};
use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::paths::{contains, file_of, is_test};
use crate::subproject::{Partition, SubProject};

const SERVING_KINDS: &[&str] = &["http", "rpc", "graphql", "tool", "cli"];
const BACKGROUND_KINDS: &[&str] = &["schedule", "message", "event", "background", "lifecycle"];
const OUTWARD_EXITS: &[&str] = &["api", "network", "message"];
const PERSISTING_EXITS: &[&str] = &["database", "file"];
const SAMPLES_TOLD: usize = 5;
const SET_ASIDE_SHARE: f64 = 0.7;
const DOMINANT: f64 = 0.5;
const RELAYED_PER_SURFACE: usize = 2;
const IPC_SHARE: f64 = 0.25;
const CAPABILITIES_TOLD: usize = 8;

pub struct Facts<'a> {
    pub files: Vec<(&'a str, Option<&'static str>)>,
    pub entry_points: &'a [EntryPoint],
    pub exit_points: &'a [ExitPoint],
    pub products: &'a [Product],
    pub capabilities: &'a [Capability],
    pub repository: &'a str,
    pub scope: &'a str,
}

#[derive(Default)]
struct Tally<'a> {
    entries: BTreeMap<&'static str, usize>,
    samples: BTreeMap<&'static str, Vec<&'a str>>,
    set_aside: usize,
    exits: BTreeMap<&'static str, usize>,
    reaches: BTreeMap<&'static str, Vec<&'a str>>,
    languages: BTreeMap<&'static str, usize>,
    files_seen: usize,
    test_files: usize,
    screen_events: usize,
    shipped_elsewhere: bool,
}

impl Tally<'_> {
    fn entered(&self) -> usize {
        self.entries.values().sum()
    }

    fn of_kinds(&self, kinds: &[&str]) -> usize {
        kinds.iter().map(|kind| self.entries.get(kind).copied().unwrap_or(0)).sum()
    }

    fn exited(&self) -> usize {
        self.exits.values().filter(|count| **count > 0).sum::<usize>()
    }

    fn exits_of(&self, kinds: &[&str]) -> usize {
        kinds.iter().map(|kind| self.exits.get(kind).copied().unwrap_or(0)).sum()
    }

    fn is_made_of_tests(&self) -> bool {
        self.files_seen > 0 && share(self.test_files, self.files_seen) >= SET_ASIDE_SHARE
    }

    fn leading_language(&self) -> Option<&'static str> {
        self.languages.iter().max_by(|left, right| left.1.cmp(right.1).then(right.0.cmp(left.0))).map(|(language, _)| *language)
    }
}

fn share(part: usize, whole: usize) -> f64 {
    match whole {
        0 => 0.0,
        whole => part as f64 / whole as f64,
    }
}

fn role_of(project: &SubProject, tally: &Tally) -> (&'static str, String) {
    let entered = tally.entered();
    if entered > 0 && share(tally.set_aside, entered) >= SET_ASIDE_SHARE {
        return ("tooling", format!("{} of its {entered} entry points are set aside as programs nothing ships", tally.set_aside));
    }
    if tally.is_made_of_tests() {
        return ("tooling", format!("{} of its {} files are tests and nothing in it serves anyone", tally.test_files, tally.files_seen));
    }
    if project.declared_by == "repository-residue" {
        return ("tooling", "it holds the files that sit outside every declared part".to_string());
    }
    let screens = tally.of_kinds(&["ui"]) + tally.screen_events;
    if screens * 2 > entered {
        return ("presentation", format!("{screens} of its {entered} entry points are screens or reactions to what someone does on one"));
    }
    let serving = tally.of_kinds(SERVING_KINDS);
    let commands = tally.of_kinds(&["ipc"]);
    let outward = tally.exits_of(OUTWARD_EXITS);
    let database = tally.exits_of(&["database"]);
    let persisting = tally.exits_of(PERSISTING_EXITS);
    let hosted = !project.consumed_by.is_empty() && !project.ship_backed;
    if commands > 0 && share(commands, commands + serving) >= IPC_SHARE {
        if !hosted {
            return ("ipc-bridge", format!("it exposes {commands} commands to a front end over IPC"));
        }
        if share(persisting, tally.exited()) >= DOMINANT {
            return ("storage", format!("it offers {commands} commands to a part that hosts it and {persisting} of its {} outward calls read or write stored data", tally.exited()));
        }
    }
    if serving > 0 && tally.exited() > 0 && database == 0 && share(outward, tally.exited()) >= DOMINANT && outward >= serving * RELAYED_PER_SURFACE {
        return ("integration", format!("it serves {serving} routes or commands and {outward} of its {} outward calls reach other services, with nothing stored", tally.exited()));
    }
    if serving > 0 && project.ship_backed {
        return ("core", format!("it serves {serving} routes, tools or commands and is shipped"));
    }
    if serving > 0 && project.runnable && !hosted && tally.shipped_elsewhere {
        return ("tooling", format!("it serves {serving} routes or commands when run, but the repository ships other parts and nothing ships or uses this one"));
    }
    if serving > 0 && project.runnable {
        return ("core", format!("it serves {serving} routes, tools or commands and is run"));
    }
    if entered == 0 || tally.of_kinds(&["export"]) == entered {
        if database > 0 && share(database, tally.exited()) >= DOMINANT {
            return ("storage", format!("{database} of its {} outward calls read or write a database", tally.exited()));
        }
        if outward > 0 && share(outward, tally.exited()) >= DOMINANT {
            return ("integration", format!("{outward} of its {} outward calls reach other services", tally.exited()));
        }
    }
    if database > 0 && share(database, tally.exited()) >= DOMINANT {
        return ("storage", format!("{database} of its {} outward calls read or write a database", tally.exited()));
    }
    let background = tally.of_kinds(BACKGROUND_KINDS);
    if (project.ship_backed || project.runnable) && background > 0 {
        let wraps = project.imports_crossing > project.imports_within;
        return match wraps {
            true => ("core", format!("it is run or shipped and mostly calls into the parts it hosts ({} crossing imports against {} within)", project.imports_crossing, project.imports_within)),
            false => ("worker", format!("it is run or shipped with {background} start-up, scheduled or event entry points and serves nothing directly")),
        };
    }
    if !project.consumed_by.is_empty() || tally.of_kinds(&["export"]) > 0 {
        return ("library", format!("it exports code that {} other parts consume", project.consumed_by.len()));
    }
    ("tooling", "nothing ships it, runs it or imports it".to_string())
}

fn role_noun(role: &str) -> &'static str {
    match role {
        "presentation" => "user interface",
        "ipc-bridge" => "desktop backend",
        "core" => "service",
        "storage" => "data layer",
        "integration" => "integration layer",
        "worker" => "background program",
        "library" => "library",
        _ => "tooling",
    }
}

fn kind_noun(kind: &str, count: usize) -> String {
    let (one, many) = match kind {
        "http" => ("route", "routes"),
        "tool" => ("tool", "tools"),
        "cli" => ("command", "commands"),
        "ui" => ("screen", "screens"),
        "ipc" => ("IPC command", "IPC commands"),
        "schedule" => ("scheduled job", "scheduled jobs"),
        "message" => ("message handler", "message handlers"),
        "rpc" => ("RPC method", "RPC methods"),
        "graphql" => ("GraphQL operation", "GraphQL operations"),
        _ => return String::new(),
    };
    format!("{count} {}", if count == 1 { one } else { many })
}

fn surfaces_told(tally: &Tally) -> Vec<String> {
    let mut told: Vec<(&&str, &usize)> = tally.entries.iter().filter(|(kind, _)| !matches!(**kind, "event" | "lifecycle" | "export" | "test")).collect();
    told.sort_by(|left, right| right.1.cmp(left.1).then(left.0.cmp(right.0)));
    told.into_iter().map(|(kind, count)| kind_noun(kind, *count)).filter(|said| !said.is_empty()).take(3).collect()
}

fn plain_name(project: &SubProject, repository: &str) -> String {
    let package = project.name.rsplit('/').next().unwrap_or(&project.name);
    let root = crate::paths::display_name(&project.root);
    let base = match package.eq_ignore_ascii_case(repository) || package.is_empty() || project.root.is_empty() && project.declared_by == "repository-residue" {
        true if project.root.is_empty() => repository.to_string(),
        true => root,
        false => package.to_string(),
    };
    let words: Vec<String> = base.split(|held: char| !held.is_alphanumeric()).filter(|word| !word.is_empty()).map(str::to_ascii_lowercase).collect();
    let mut named: Vec<String> = words
        .iter()
        .map(|word| match word.len() <= 3 && word.chars().all(|held| held.is_ascii_alphabetic() && !"aeiouy".contains(held)) {
            true => word.to_ascii_uppercase(),
            false => word.clone(),
        })
        .collect();
    if let Some(first) = named.first_mut() {
        *first = capitalised(first);
    }
    named.join(" ")
}

fn capitalised(word: &str) -> String {
    let mut letters = word.chars();
    match letters.next() {
        Some(head) => head.to_uppercase().chain(letters).collect(),
        None => String::new(),
    }
}

fn plain_summary(role: &str, tally: &Tally, project: &SubProject) -> String {
    let language = tally.leading_language().map(|language| format!("{} ", capitalised(language))).unwrap_or_default();
    if tally.is_made_of_tests() {
        return format!("{language}test code of {} files", tally.files_seen);
    }
    let surfaces = surfaces_told(tally);
    match surfaces.is_empty() {
        true => format!("{language}{} of {} files", role_noun(role), project.files),
        false => format!("{language}{} serving {}", role_noun(role), surfaces.join(", ")),
    }
}

fn facts_of(project: &SubProject, tally: &Tally, role: &str, basis: &str, facts: &Facts, products: &[&Product], capabilities: &[&Capability]) -> String {
    let mut told = format!(
        "part: {}\nfound at: {}\npackage name: {}\nstatus: {} ({} files, {} declarations)\narchitectural role read from evidence: {role}, because {basis}\n",
        project.id,
        match project.root.is_empty() {
            true => "the repository root".to_string(),
            false => project.root.clone(),
        },
        project.name,
        project.status,
        project.files,
        project.declarations
    );
    if let Some(language) = tally.leading_language() {
        told.push_str(&format!("main language: {language}\n"));
    }
    for (kind, count) in &tally.entries {
        if matches!(*kind, "test" | "export") {
            continue;
        }
        let samples = tally.samples.get(kind).map(|held| held.join(", ")).unwrap_or_default();
        told.push_str(&format!("entry points of kind {kind}: {count}, such as {samples}\n"));
    }
    let mut exits: Vec<(&&str, &usize)> = tally.exits.iter().collect();
    exits.sort_by(|left, right| right.1.cmp(left.1).then(left.0.cmp(right.0)));
    for (kind, count) in exits.into_iter().take(3) {
        let reached = tally.reaches.get(kind).map(|held| held.join(", ")).unwrap_or_default();
        told.push_str(&format!("outward calls of kind {kind}: {count}, reaching {reached}\n"));
    }
    if !project.consumed_by.is_empty() {
        told.push_str(&format!("used by: {}\n", project.consumed_by.join(", ")));
    }
    if !project.depends_on.is_empty() {
        told.push_str(&format!("depends on: {}\n", project.depends_on.join(", ")));
    }
    if !capabilities.is_empty() {
        let names: Vec<&str> = capabilities.iter().filter_map(|capability| capability.name.as_deref()).take(CAPABILITIES_TOLD).collect();
        told.push_str(&format!("what it delivers: {}\n", names.join("; ")));
    }
    if let Some(product) = products.first() {
        told.push_str(&format!("its description: {}\n", product.description));
    }
    told.push_str(&format!("repository: {}\n", facts.repository));
    told
}

pub fn assign(partition: &mut Partition, facts: &Facts) {
    let roots: Vec<(usize, &str)> = partition
        .sub_projects
        .iter()
        .enumerate()
        .filter(|(_, project)| !project.root.is_empty())
        .map(|(at, project)| (at, project.root.as_str()))
        .collect();
    let residue = partition.sub_projects.iter().position(|project| project.root.is_empty());
    let deepest = |path: &str| -> Option<usize> {
        roots
            .iter()
            .filter(|(_, root)| contains(root, path))
            .max_by_key(|(_, root)| root.len())
            .map(|(at, _)| *at)
            .or(residue)
    };
    let shipped_elsewhere = partition.sub_projects.iter().any(|project| project.ship_backed);
    let mut tallies: Vec<Tally> = partition.sub_projects.iter().map(|_| Tally { shipped_elsewhere, ..Tally::default() }).collect();
    for (path, language) in &facts.files {
        let Some(at) = deepest(path) else { continue };
        tallies[at].files_seen += 1;
        if is_test(path) {
            tallies[at].test_files += 1;
            continue;
        }
        if let Some(language) = language {
            *tallies[at].languages.entry(language).or_default() += 1;
        }
    }
    let path_of = |file: u32| facts.files.get(file as usize).map(|(path, _)| *path);
    for entry in facts.entry_points {
        let Some(path) = path_of(entry.file) else { continue };
        if is_test(path) || entry.kind == "test" {
            continue;
        }
        let Some(at) = deepest(path) else { continue };
        *tallies[at].entries.entry(entry.kind).or_default() += 1;
        if entry.kind == "event" && crate::capabilities::is_a_screen_event(&entry.name) {
            tallies[at].screen_events += 1;
        }
        if crate::unshipped::is_set_aside(entry.unshipped.as_ref()) {
            tallies[at].set_aside += 1;
        }
        let samples = tallies[at].samples.entry(entry.kind).or_default();
        let said = entry.path.as_deref().unwrap_or(entry.name.as_str());
        if samples.len() < SAMPLES_TOLD && !samples.contains(&said) {
            samples.push(said);
        }
    }
    for exit in facts.exit_points {
        let Some(path) = path_of(exit.file).or_else(|| Some(file_of(&exit.source))) else { continue };
        let Some(at) = deepest(path) else { continue };
        *tallies[at].exits.entry(exit.kind).or_default() += 1;
        let reached = exit.service.as_deref().or(exit.addressed.as_deref()).unwrap_or(exit.name.as_str());
        let samples = tallies[at].reaches.entry(exit.kind).or_default();
        if samples.len() < SAMPLES_TOLD && !samples.contains(&reached) {
            samples.push(reached);
        }
    }
    let reads: Vec<Reading> = tallies
        .iter()
        .zip(partition.sub_projects.iter())
        .map(|(tally, project)| {
            let (role, basis) = role_of(project, tally);
            let part_products: Vec<&Product> = facts.products.iter().filter(|product| product.project.as_deref() == Some(project.id.as_str())).collect();
            let part_capabilities: Vec<&Capability> = facts
                .capabilities
                .iter()
                .filter(|capability| capability.project.as_deref() == Some(project.id.as_str()) || capability.also_in.iter().any(|held| *held == project.id))
                .collect();
            let told = facts_of(project, tally, role, &basis, facts, &part_products, &part_capabilities);
            Reading {
                role,
                basis,
                named: plain_name(project, facts.repository),
                summary: plain_summary(role, tally, project),
                key: format!("{}\u{1}{}", facts.scope, project.id),
                digest: crate::jev::named(&told),
                told,
            }
        })
        .collect();
    let written: Vec<Option<crate::author::PartNamed>> = crate::author::asking(|| {
        reads
            .par_iter()
            .map(|read| crate::memory::unless_changed("identity", &read.key, &read.digest, || crate::author::name_a_part(&read.told)))
            .collect()
    });
    for ((project, read), written) in partition.sub_projects.iter_mut().zip(reads).zip(written) {
        project.role = read.role;
        project.role_basis = read.basis;
        match written {
            Some(written) => {
                project.display_name = written.name;
                project.summary = written.summary;
            }
            None => {
                project.display_name = read.named;
                project.summary = read.summary;
            }
        }
    }
}

struct Reading {
    role: &'static str,
    basis: String,
    named: String,
    summary: String,
    key: String,
    digest: String,
    told: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(root: &str, name: &str, status: &'static str) -> SubProject {
        SubProject {
            id: format!("subproject:{root}"),
            name: name.to_string(),
            root: root.to_string(),
            declared_by: "module-manifest",
            at: String::new(),
            files: 10,
            declarations: 20,
            entry_points: 0,
            imports_within: 4,
            imports_crossing: 1,
            ship_backed: status == "deployable",
            runnable: status == "executable" || status == "deployable",
            status,
            ships_in: Vec::new(),
            consumed_by: Vec::new(),
            owner: None,
            system: None,
            depends_on: Vec::new(),
            display_name: String::new(),
            role: "",
            role_basis: String::new(),
            summary: String::new(),
        }
    }

    fn tally(entries: &[(&'static str, usize)]) -> Tally<'static> {
        let mut held = Tally::default();
        held.entries = entries.iter().copied().collect();
        held
    }

    #[test]
    fn a_name_drops_the_repository_prefix_and_reads_plainly() {
        assert_eq!(plain_name(&project("src-tauri", "agent-desktop", "deployable"), "agent-desktop"), "SRC tauri");
        assert_eq!(plain_name(&project("packages/remote-client", "@agent-desktop/remote-client", "library"), "agent-desktop"), "Remote client");
        assert_eq!(plain_name(&project("apps/mcp-server", "mcp-server", "deployable"), "klauro"), "MCP server");
    }

    #[test]
    fn a_part_that_exposes_commands_over_a_bridge_is_the_bridge() {
        let held = tally(&[("ipc", 12), ("event", 3)]);
        assert_eq!(role_of(&project("src-tauri", "backend", "deployable"), &held).0, "ipc-bridge");
    }

    #[test]
    fn a_part_made_of_screens_is_presentation_and_one_serving_routes_is_core() {
        assert_eq!(role_of(&project("apps/app", "app", "executable"), &tally(&[("ui", 20), ("event", 4)])).0, "presentation");
        assert_eq!(role_of(&project("apps/server", "server", "deployable"), &tally(&[("http", 40), ("tool", 10)])).0, "core");
    }

    #[test]
    fn a_part_whose_programs_are_all_set_aside_is_tooling() {
        let mut held = tally(&[("lifecycle", 10)]);
        held.set_aside = 9;
        assert_eq!(role_of(&project("scripts", "scripts", "module"), &held).0, "tooling");
    }

    #[test]
    fn a_part_made_only_of_test_files_is_tooling_with_a_summary_that_says_so() {
        let mut held = tally(&[("export", 3)]);
        held.files_seen = 16;
        held.test_files = 16;
        let mut remote = project("e2e/remote", "remote-e2e", "library");
        remote.files = 16;
        remote.consumed_by = vec!["subproject:app".to_string()];
        let (role, basis) = role_of(&remote, &held);
        assert_eq!(role, "tooling");
        assert!(basis.contains("16 of its 16 files"), "{basis}");
        assert_eq!(plain_summary(role, &held, &remote), "test code of 16 files");
    }

    #[test]
    fn a_part_with_mostly_product_files_is_not_made_of_tests() {
        let mut held = tally(&[("export", 3)]);
        held.files_seen = 16;
        held.test_files = 4;
        let mut library = project("packages/sdk", "sdk", "library");
        library.consumed_by = vec!["subproject:app".to_string()];
        assert_eq!(role_of(&library, &held).0, "library");
    }

    #[test]
    fn a_part_nothing_serves_but_others_import_is_a_library() {
        let mut library = project("packages/sdk", "sdk", "library");
        library.consumed_by = vec!["subproject:apps/app".to_string()];
        assert_eq!(role_of(&library, &tally(&[("export", 8)])).0, "library");
    }

    #[test]
    fn a_part_whose_screens_are_only_half_its_entry_points_is_not_presentation() {
        let held = tally(&[("ui", 2), ("lifecycle", 2)]);
        assert_ne!(role_of(&project("crates/accounts", "accounts", "executable"), &held).0, "presentation");
    }

    #[test]
    fn a_part_whose_entry_points_are_reactions_on_a_screen_is_presentation_though_it_declares_no_screens() {
        let mut held = tally(&[("event", 10)]);
        held.screen_events = 8;
        assert_eq!(role_of(&project("apps/site", "site", "deployable"), &held).0, "presentation");
    }

    #[test]
    fn what_sits_outside_every_declared_part_is_not_a_library() {
        let mut residue = project("", "repository", "library");
        residue.declared_by = "repository-residue";
        assert_eq!(role_of(&residue, &tally(&[])).0, "tooling");
    }

    #[test]
    fn a_part_serving_routes_whose_calls_all_reach_other_services_is_integration() {
        let mut held = tally(&[("http", 5)]);
        held.exits = [("api", 34), ("network", 1)].into_iter().collect();
        assert_eq!(role_of(&project("relay", "relay", "deployable"), &held).0, "integration");
    }

    #[test]
    fn commands_offered_to_a_hosting_part_over_stored_data_are_storage_while_the_shipped_host_is_the_bridge() {
        let mut held = tally(&[("ipc", 17)]);
        held.exits = [("file", 328), ("process", 2)].into_iter().collect();
        let mut module = project("crates/store", "store", "executable");
        module.consumed_by = vec!["subproject:src-tauri".to_string()];
        assert_eq!(role_of(&module, &held).0, "storage");
        let mut host = project("src-tauri", "app", "deployable");
        host.consumed_by = vec!["subproject:app".to_string()];
        assert_eq!(role_of(&host, &held).0, "ipc-bridge");
    }

    #[test]
    fn a_runnable_part_nothing_ships_or_uses_beside_shipped_parts_is_tooling_but_core_when_nothing_ships() {
        let mut held = tally(&[("http", 2)]);
        held.shipped_elsewhere = true;
        assert_eq!(role_of(&project("packages/harness", "harness", "executable"), &held).0, "tooling");
        held.shipped_elsewhere = false;
        assert_eq!(role_of(&project("packages/harness", "harness", "executable"), &held).0, "core");
    }
}
