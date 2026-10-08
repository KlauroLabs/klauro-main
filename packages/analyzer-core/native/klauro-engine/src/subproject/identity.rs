use std::collections::{BTreeMap, HashSet};

use rayon::prelude::*;

use crate::comprehend::{Capability, Product};
use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::paths::{contains, file_of, is_hand_written_code, is_test};
use crate::subproject::{Partition, SubProject};

const SERVING_KINDS: &[&str] = &["http", "rpc", "graphql", "tool", "cli"];
const BACKGROUND_KINDS: &[&str] = &["schedule", "message", "event", "background", "lifecycle"];
const SAMPLES_TOLD: usize = 5;
const SET_ASIDE_SHARE: f64 = 0.7;
const CAPABILITIES_TOLD: usize = 8;

pub struct Facts<'a> {
    pub files: Vec<(&'a str, Option<&'static str>)>,
    pub entry_points: &'a [EntryPoint],
    pub exit_points: &'a [ExitPoint],
    pub products: &'a [Product],
    pub capabilities: &'a [Capability],
    pub repository: &'a str,
    pub scope: &'a str,
    pub deployables: &'a [crate::scope::Deployable],
    pub spelled: &'a BTreeMap<String, String>,
    pub testing: HashSet<u32>,
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
    served_documents: usize,
}

impl Tally<'_> {
    fn entered(&self) -> usize {
        self.entries.values().sum()
    }

    fn of_kinds(&self, kinds: &[&str]) -> usize {
        kinds.iter().map(|kind| self.entries.get(kind).copied().unwrap_or(0)).sum()
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

fn kind_of(project: &SubProject, tally: &Tally, orchestrates: bool, declares_a_program: bool) -> (&'static str, String) {
    let entered = tally.entered();
    if tally.is_made_of_tests() {
        return ("test suite", format!("{} of its {} files are tests", tally.test_files, tally.files_seen));
    }
    if orchestrates {
        return ("orchestrator", "it starts and wires the other parts together".to_string());
    }
    let screens = tally.of_kinds(&["ui"]) + tally.screen_events;
    let serving = tally.of_kinds(SERVING_KINDS);
    let commands = tally.of_kinds(&["ipc"]);
    let all = entered + tally.set_aside;
    if all > 0 && share(tally.set_aside, all) >= SET_ASIDE_SHARE && screens + serving + commands == 0 {
        return ("tooling", format!("{} of its {all} entry points are programs nothing ships", tally.set_aside));
    }
    let background = tally.of_kinds(BACKGROUND_KINDS);
    if tally.served_documents > 0 && tally.served_documents == tally.of_kinds(&["ui"]) && serving == 0 {
        return ("website", format!("it serves {} pages", tally.served_documents));
    }
    if commands > 0 && commands >= serving {
        return ("app backend", format!("it answers {commands} commands from an app's interface"));
    }
    if screens > 0 && screens >= serving {
        return ("app", format!("{screens} of its entry points are screens or what someone does on one"));
    }
    let starts_on_its_own = declares_a_program || tally.of_kinds(&["lifecycle"]) > 0 || tally.of_kinds(&["cli"]) > 0;
    if !starts_on_its_own && !project.imported_by.is_empty() {
        return ("library", "other code calls into it and it does not start on its own".to_string());
    }
    if serving > 0 && (project.ship_backed || project.runnable) {
        let cli = tally.of_kinds(&["cli"]);
        return match cli * 2 > serving {
            true => ("tool", format!("it is run as a command line with {cli} commands")),
            false => ("service", format!("it serves {serving} requests, tools or commands")),
        };
    }
    if background > 0 && (project.ship_backed || project.runnable || declares_a_program) && serving == 0 {
        return ("worker", format!("it runs {background} scheduled, message or start-up jobs and serves nothing directly"));
    }
    if !project.consumed_by.is_empty() || !project.imported_by.is_empty() || tally.of_kinds(&["export"]) > 0 {
        return ("library", "other code calls into it".to_string());
    }
    ("unused", "nothing ships it, runs it or calls it".to_string())
}

fn kind_noun_of(kind: &str) -> &'static str {
    match kind {
        "test suite" => "tests",
        "orchestrator" => "orchestrator",
        "website" => "website",
        "app backend" => "backend",
        "app" => "app",
        "tool" => "tool",
        "service" => "service",
        "worker" => "worker",
        "library" => "library",
        "unused" => "unused code",
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

fn words_of(declared: &str) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    for piece in declared.split(|letter: char| matches!(letter, '.' | '-' | '_' | '/' | ' ' | '@')).filter(|piece| !piece.is_empty()) {
        let letters: Vec<char> = piece.chars().collect();
        let mut current = String::new();
        for (at, letter) in letters.iter().enumerate() {
            let next_is_lower = letters.get(at + 1).is_some_and(|next| next.is_lowercase());
            let previous_is_lower = at > 0 && letters[at - 1].is_lowercase();
            if letter.is_uppercase() && !current.is_empty() && (previous_is_lower || next_is_lower) {
                words.push(std::mem::take(&mut current));
            }
            current.push(*letter);
        }
        if !current.is_empty() {
            words.push(current);
        }
    }
    words
}

pub fn spellings<'t>(texts: impl Iterator<Item = &'t str>) -> BTreeMap<String, String> {
    let mut seen: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for text in texts {
        for word in text.split(|letter: char| !letter.is_ascii_alphanumeric()).filter(|word| (2..=6).contains(&word.len())) {
            if !word.chars().next().is_some_and(|letter| letter.is_ascii_alphabetic()) {
                continue;
            }
            let held = seen.entry(word.to_ascii_lowercase()).or_default();
            match word.chars().all(|letter| letter.is_ascii_uppercase() || letter.is_ascii_digit()) {
                true => held.0 += 1,
                false => held.1 += 1,
            }
        }
    }
    seen.into_iter().filter(|(_, (capitals, other))| *capitals > *other).map(|(word, _)| (word.clone(), word.to_ascii_uppercase())).collect()
}

fn as_spelled(name: &str, spelled: &BTreeMap<String, String>) -> String {
    name.split(' ').map(|word| spelled.get(&word.to_ascii_lowercase()).cloned().unwrap_or_else(|| word.to_string())).collect::<Vec<_>>().join(" ")
}

fn readable(words: &[String]) -> String {
    words
        .iter()
        .enumerate()
        .map(|(at, word)| {
            let acronym = word.len() > 1 && word.chars().all(|letter| letter.is_uppercase() || letter.is_ascii_digit());
            match (at, acronym) {
                (_, true) => word.clone(),
                (0, false) => capitalised(word),
                (_, false) => word.to_lowercase(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn plain_name(project: &SubProject, repository: &str) -> String {
    let declared = match (project.name.as_str(), project.root.is_empty()) {
        ("" | "repository" | "root", false) => crate::paths::display_name(&project.root),
        ("" | "repository" | "root", true) => repository.to_string(),
        (named, _) => match named.strip_prefix('@').and_then(|scoped| scoped.split_once('/')) {
            Some((scope, name)) if name.eq_ignore_ascii_case(scope) || words_of(name).len() >= 2 => name.to_string(),
            Some((scope, name)) => format!("{scope} {name}"),
            None => named.to_string(),
        },
    };
    let repository_words: Vec<String> = words_of(repository).into_iter().map(|word| word.to_lowercase()).collect();
    let words = words_of(&declared);
    let leading = words.iter().zip(repository_words.iter()).take_while(|(word, held)| word.to_lowercase() == **held).count();
    let trimmed: Vec<String> = match leading == repository_words.len() && leading > 0 && words.len() - leading >= 2 {
        true => words[leading..].to_vec(),
        false => words,
    };
    readable(&trimmed)
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
        true => format!("{language}{} of {} files", kind_noun_of(role), project.files),
        false => format!("{language}{} serving {}", kind_noun_of(role), surfaces.join(", ")),
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

static ORCHESTRATING: &[&str] = &["aspire-apphost"];

fn declares_a_program(project: &SubProject, deployables: &[crate::scope::Deployable]) -> bool {
    deployables.iter().any(|unit| {
        (unit.root == project.root || project.members.contains(&unit.root))
            && unit.declarations.iter().any(|declared| !matches!(declared.declares, crate::scope::Declares::Identity) && declared.kind != "runnable-module")
    })
}

fn orchestrates(project: &SubProject, deployables: &[crate::scope::Deployable]) -> bool {
    deployables.iter().any(|unit| {
        (unit.root == project.root || project.members.contains(&unit.root))
            && unit.declarations.iter().any(|declared| ORCHESTRATING.contains(&declared.kind))
    })
}

fn without_a_shared_prefix(named: Vec<(String, &'static str, bool)>) -> Vec<(String, &'static str)> {
    let words = |name: &str| name.split(' ').map(str::to_lowercase).collect::<Vec<_>>();
    let rooted: Vec<Vec<String>> = named.iter().filter(|(_, _, rooted)| *rooted).map(|(name, _, _)| words(name)).collect();
    let shared = match rooted.as_slice() {
        [first, _, ..] => (0..first.len()).take_while(|at| rooted.iter().all(|held| held.len() > *at + 1 && held[*at] == first[*at])).count(),
        _ => 0,
    };
    named
        .into_iter()
        .map(|(name, kind, rooted)| {
            let held: Vec<&str> = name.split(' ').collect();
            match rooted && shared > 0 && held.len() - shared >= 2 {
                true => (capitalised(&held[shared..].join(" ")), kind),
                false => (name, kind),
            }
        })
        .collect()
}

fn unique_names(named: Vec<(String, &'static str)>) -> Vec<String> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for (name, _) in &named {
        *counts.entry(name.to_lowercase()).or_default() += 1;
    }
    let mut taken: BTreeMap<String, usize> = BTreeMap::new();
    named
        .into_iter()
        .map(|(name, kind)| {
            let candidate = match counts[&name.to_lowercase()] {
                1 => name,
                _ => format!("{name} {}", kind_noun_of(kind)),
            };
            let seen = taken.entry(candidate.to_lowercase()).or_default();
            *seen += 1;
            match *seen {
                1 => candidate,
                count => format!("{candidate} {count}"),
            }
        })
        .collect()
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
    let index_of: std::collections::HashMap<&str, usize> = partition.sub_projects.iter().enumerate().map(|(at, project)| (project.id.as_str(), at)).collect();
    let assigned: std::collections::HashMap<&str, usize> = partition
        .assignment
        .iter()
        .filter_map(|(path, id)| index_of.get(id.as_str()).map(|at| (path.as_str(), *at)))
        .collect();
    let deepest = |path: &str| -> Option<usize> {
        if let Some(at) = assigned.get(path) {
            return Some(*at);
        }
        roots
            .iter()
            .filter(|(_, root)| contains(root, path))
            .max_by_key(|(_, root)| root.len())
            .map(|(at, _)| *at)
            .or(residue)
    };
    let mut tallies: Vec<Tally> = partition.sub_projects.iter().map(|_| Tally::default()).collect();
    for (file, (path, language)) in facts.files.iter().enumerate() {
        let Some(at) = deepest(path) else { continue };
        let testing = is_test(path) || facts.testing.contains(&(file as u32));
        if !testing && !is_hand_written_code(path) {
            continue;
        }
        tallies[at].files_seen += 1;
        if testing {
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
        if crate::unshipped::is_set_aside(entry.unshipped.as_ref()) {
            tallies[at].set_aside += 1;
            continue;
        }
        *tallies[at].entries.entry(entry.kind).or_default() += 1;
        if entry.kind == "event" && crate::capabilities::is_a_screen_event(&entry.name) {
            tallies[at].screen_events += 1;
        }
        if entry.registrar == "served_document" || entry.registrar.starts_with("site_route:") {
            tallies[at].served_documents += 1;
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
    let kinds: Vec<(&'static str, String)> = tallies
        .iter()
        .zip(partition.sub_projects.iter())
        .map(|(tally, project)| kind_of(project, tally, orchestrates(project, facts.deployables), declares_a_program(project, facts.deployables)))
        .collect();
    let names = unique_names(without_a_shared_prefix(
        partition
            .sub_projects
            .iter()
            .zip(kinds.iter())
            .map(|(project, (kind, _))| {
                let alone = partition.sub_projects.len() == 1;
                let name = match (project.root.is_empty(), *kind, alone) {
                    (true, "tooling" | "unused", false) => "Repository tooling".to_string(),
                    _ => as_spelled(&plain_name(project, facts.repository), facts.spelled),
                };
                (name, *kind, !project.root.is_empty())
            })
            .collect(),
    ));
    let reads: Vec<Reading> = tallies
        .iter()
        .zip(partition.sub_projects.iter())
        .zip(kinds.into_iter().zip(names))
        .map(|((tally, project), ((kind, basis), name))| {
            let part_products: Vec<&Product> = facts.products.iter().filter(|product| product.project.as_deref() == Some(project.id.as_str())).collect();
            let part_capabilities: Vec<&Capability> = facts
                .capabilities
                .iter()
                .filter(|capability| capability.project.as_deref() == Some(project.id.as_str()) || capability.also_in.iter().any(|held| *held == project.id))
                .collect();
            let told = facts_of(project, tally, kind, &basis, facts, &part_products, &part_capabilities);
            Reading {
                kind,
                basis,
                summary: plain_summary(kind, tally, project),
                key: format!("{}\u{1}{}", facts.scope, project.id),
                digest: crate::jev::named(&format!("{name}\n{told}")),
                name,
                told,
            }
        })
        .collect();
    let written: Vec<Option<String>> = crate::author::asking(|| {
        reads
            .par_iter()
            .map(|read| crate::memory::unless_changed("identity", &read.key, &read.digest, || crate::author::describe_a_part(&read.told, &read.name)))
            .collect()
    });
    for ((project, read), written) in partition.sub_projects.iter_mut().zip(reads).zip(written) {
        project.role = read.kind;
        project.role_basis = read.basis;
        project.display_name = read.name;
        project.summary = written.unwrap_or(read.summary);
    }
}

struct Reading {
    kind: &'static str,
    basis: String,
    name: String,
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
            members: Vec::new(),
            imported_by: Vec::new(),
            published: false,
            test_files: 0,
            code_files: 0,
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
    fn a_word_keeps_the_capitals_the_repository_writes_it_in() {
        let spelled = spellings(["The MCP server and the CLI talk to the API. Run the CLI.", "MCP tools; cli flags; CLI help"].into_iter());
        assert_eq!(as_spelled("Mcp server", &spelled), "MCP server");
        assert_eq!(as_spelled("Immich cli", &spelled), "Immich CLI");
        assert_eq!(as_spelled("Order processor", &spelled), "Order processor");
    }

    #[test]
    fn a_name_is_the_declared_one_made_readable() {
        assert_eq!(plain_name(&project("src/Ordering.API", "Ordering.API", "deployable"), "eShop"), "Ordering API");
        assert_eq!(plain_name(&project("src/OrderProcessor", "OrderProcessor", "deployable"), "eShop"), "Order processor");
        assert_eq!(plain_name(&project("src/eShop.ServiceDefaults", "eShop.ServiceDefaults", "library"), "eShop"), "Service defaults");
        assert_eq!(plain_name(&project("mobile", "immich_mobile", "executable"), "immich"), "Immich mobile");
        assert_eq!(plain_name(&project("", "@mastodon/mastodon", "deployable"), "mastodon"), "Mastodon");
        assert_eq!(plain_name(&project("streaming", "@mastodon/streaming", "deployable"), "mastodon"), "Mastodon streaming");
        assert_eq!(plain_name(&project("apps/marketing-site", "@klauro/marketing-site", "deployable"), "proof-of-concept"), "Marketing site");
        assert_eq!(plain_name(&project("packages/remote-client", "@agent-desktop/remote-client", "library"), "agent-desktop"), "Remote client");
        assert_eq!(plain_name(&project("src-tauri", "agent-desktop", "deployable"), "agent-desktop"), "Agent desktop");
    }

    #[test]
    fn code_other_parts_call_that_never_starts_on_its_own_is_a_library_though_it_adds_a_route() {
        let mut defaults = project("src/ServiceDefaults", "ServiceDefaults", "deployable");
        defaults.imported_by = vec!["subproject:src/Basket.API".to_string()];
        assert_eq!(kind_of(&defaults, &tally(&[("http", 1)]), false, false).0, "library");
    }

    #[test]
    fn a_prefix_every_part_shares_is_the_product_s_name_and_is_dropped() {
        let named = without_a_shared_prefix(vec![
            ("Finance domain entities".to_string(), "library", true),
            ("Finance presentation web API".to_string(), "service", true),
            ("Finance plaid".to_string(), "library", true),
            ("Repository tooling".to_string(), "tooling", false),
        ]);
        let names: Vec<&str> = named.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, vec!["Domain entities", "Presentation web API", "Finance plaid", "Repository tooling"]);
    }

    #[test]
    fn two_parts_with_one_name_are_told_apart_by_what_they_are() {
        let names = unique_names(vec![("Agent desktop".to_string(), "app"), ("Agent desktop".to_string(), "app backend"), ("Relay".to_string(), "service")]);
        assert_eq!(names, vec!["Agent desktop app", "Agent desktop backend", "Relay"]);
    }

    #[test]
    fn a_part_answering_an_interface_s_commands_is_an_app_backend() {
        assert_eq!(kind_of(&project("src-tauri", "backend", "deployable"), &tally(&[("ipc", 12), ("event", 3)]), false, true).0, "app backend");
    }

    #[test]
    fn screens_make_an_app_and_requests_make_a_service() {
        assert_eq!(kind_of(&project("apps/app", "app", "executable"), &tally(&[("ui", 20), ("event", 4)]), false, true).0, "app");
        assert_eq!(kind_of(&project("apps/server", "server", "deployable"), &tally(&[("http", 40), ("tool", 10)]), false, true).0, "service");
    }

    #[test]
    fn a_run_program_with_only_jobs_is_a_worker() {
        assert_eq!(kind_of(&project("src/OrderProcessor", "OrderProcessor", "deployable"), &tally(&[("message", 3), ("lifecycle", 1)]), false, true).0, "worker");
    }

    #[test]
    fn a_part_that_starts_the_others_is_the_orchestrator() {
        assert_eq!(kind_of(&project("src/AppHost", "AppHost", "deployable"), &tally(&[("lifecycle", 1)]), true, true).0, "orchestrator");
    }

    #[test]
    fn a_part_made_of_test_files_is_a_test_suite() {
        let mut held = tally(&[("export", 3)]);
        held.files_seen = 16;
        held.test_files = 16;
        assert_eq!(kind_of(&project("e2e", "e2e", "library"), &held, false, false).0, "test suite");
    }

    #[test]
    fn a_part_other_code_calls_into_is_a_library() {
        let mut library = project("packages/sdk", "sdk", "library");
        library.consumed_by = vec!["subproject:apps/app".to_string()];
        assert_eq!(kind_of(&library, &tally(&[("export", 8)]), false, false).0, "library");
    }

    #[test]
    fn a_part_serving_only_pages_is_a_website() {
        let mut held = tally(&[("ui", 4)]);
        held.served_documents = 4;
        assert_eq!(kind_of(&project("apps/site", "site", "deployable"), &held, false, true).0, "website");
    }

    #[test]
    fn a_part_whose_programs_are_all_set_aside_is_tooling() {
        let mut held = tally(&[("lifecycle", 1)]);
        held.set_aside = 9;
        assert_eq!(kind_of(&project("scripts", "scripts", "module"), &held, false, true).0, "tooling");
    }

    #[test]
    fn a_part_with_screens_stays_an_app_however_many_scripts_sit_beside_them() {
        let mut held = tally(&[("ui", 20), ("cli", 2)]);
        held.set_aside = 70;
        assert_eq!(kind_of(&project("", "desktop", "module"), &held, false, false).0, "app");
    }
}
