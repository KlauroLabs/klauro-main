use std::collections::{BTreeMap, BTreeSet};
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use std::path::Path;

use serde::Serialize;

use crate::dependencies::Dependencies;
use crate::entry_exit::ExitPoint;
use crate::model::*;
use crate::service_catalog::{self, Known};

#[derive(Debug, Serialize)]
pub struct Evidence {
    pub how: &'static str,
    pub what: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<u32>,
    #[serde(skip_serializing_if = "is_zero")]
    pub line: u32,
}

fn is_zero(held: &u32) -> bool {
    *held == 0
}

#[derive(Debug, Serialize)]
pub struct Service {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub known: bool,
    pub evidenced: Vec<(String, u32)>,
    pub evidence: Vec<Evidence>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reached_by: Vec<String>,
    #[serde(skip_serializing_if = "is_zero")]
    pub reached: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<String>,
}

pub struct Sources<'a> {
    pub root: &'a Path,
    pub paths: &'a [&'a str],
    pub not_ours: &'a [bool],
    pub dependencies: Option<&'a Dependencies>,
    pub imports: &'a [ImportFact],
    pub calls: &'a [CallFact],
    pub exits: &'a [ExitPoint],
    pub nodes: &'a [IndexNode],
    pub settings: &'a [SettingRead],
    pub set_aside: &'a crate::set_aside::SetAside,
}

const EVIDENCE_KEPT: usize = 12;
static STANDS_A_SERVICE_UP: &[&str] = &["call", "connection", "image", "import", "package"];
const REACHES_KEPT: usize = 24;
const SETTINGS_FILE_AT_MOST: u64 = 256 * 1024;

static ASKS_THE_ENVIRONMENT: &[&str] = &["env", "environ", "environment", "fetch", "get", "getenv", "var"];
static NETWORK_SCHEMES: &[&str] = &["http", "https", "ws", "wss"];
static NEVER_A_SERVICE_TLD: &[&str] = &["example", "internal", "invalid", "local", "localhost", "test"];
static NEVER_A_SERVICE: &[&str] = &[
    "apache.org", "creativecommons.org", "crates.io", "developer.mozilla.org", "docs.rs", "example.com",
    "example.net", "example.org", "github.com", "go.dev", "golang.org", "json-schema.org", "mozilla.org",
    "npmjs.com", "npmjs.org", "ogp.me", "opensource.org", "purl.org", "pypi.org", "readthedocs.io",
    "schema.org", "schemas.microsoft.com", "schemas.openxmlformats.org", "stackoverflow.com", "w3.org",
    "wikipedia.org", "xmlns.com", "yaml.org",
];

#[derive(Default)]
struct Held {
    kind: &'static str,
    known: bool,
    evidence: Vec<Evidence>,
    counted: BTreeMap<&'static str, u32>,
    seen: HashSet<(&'static str, String)>,
    reached_by: BTreeSet<String>,
    projects: BTreeSet<String>,
}

struct Gathering<'a> {
    held: BTreeMap<String, Held>,
    project_of_file: HashMap<u32, &'a str>,
}

impl<'a> Gathering<'a> {
    fn note(&mut self, known: &'static Known, how: &'static str, what: &str, file: Option<u32>, line: u32) {
        let project = file.and_then(|file| self.project_of_file.get(&file).copied());
        let held = self.held.entry(known.name.to_string()).or_insert_with(|| Held {
            kind: known.kind,
            known: true,
            ..Held::default()
        });
        Self::record(held, how, what, file, line, project);
    }

    fn note_unknown(&mut self, host: &str, how: &'static str, what: &str, file: Option<u32>, line: u32) {
        let project = file.and_then(|file| self.project_of_file.get(&file).copied());
        let held = self.held.entry(host.to_string()).or_insert_with(|| Held {
            kind: "unclassified",
            known: false,
            ..Held::default()
        });
        Self::record(held, how, what, file, line, project);
    }

    fn record(held: &mut Held, how: &'static str, what: &str, file: Option<u32>, line: u32, project: Option<&str>) {
        *held.counted.entry(how).or_insert(0) += 1;
        if let Some(project) = project {
            held.projects.insert(project.to_string());
        }
        if held.evidence.len() < EVIDENCE_KEPT && held.seen.insert((how, what.to_string())) {
            held.evidence.push(Evidence { how, what: what.to_string(), file, line });
        }
    }
}

pub struct Address<'t> {
    pub scheme: &'t str,
    pub host: Option<&'t str>,
}

static PAGES_FOR_PEOPLE: &[&str] = &[
    "/about", "/blog", "/community", "/contact", "/docs", "/help", "/legal", "/pricing", "/privacy", "/support",
    "/terms",
];

fn a_page_for_people(text: &str, address: &Address) -> bool {
    let Some(host) = address.host else { return false };
    let Some(at) = text.find(host) else { return false };
    let path = text[at + host.len()..].trim_start_matches(|letter: char| letter == ':' || letter.is_ascii_digit());
    let path = path.split(['?', '#', '"', '\'', ' ', '`']).next().unwrap_or("");
    let lowered = path.to_ascii_lowercase();
    lowered.is_empty()
        || lowered == "/"
        || host.starts_with("docs.")
        || host.starts_with("www.") && lowered.len() <= 1
        || PAGES_FOR_PEOPLE.iter().any(|page| lowered.starts_with(page))
}

pub fn address_in(text: &str) -> Option<Address<'_>> {
    let at = text.find("://")?;
    let scheme_starts = text[..at]
        .rfind(|letter: char| !(letter.is_ascii_alphanumeric() || matches!(letter, '+' | '-' | '.')))
        .map(|found| found + 1)
        .unwrap_or(0);
    let scheme = &text[scheme_starts..at];
    if scheme.is_empty() || !scheme.chars().next().is_some_and(|letter| letter.is_ascii_alphabetic()) {
        return None;
    }
    let rest = &text[at + 3..];
    let authority_ends = rest.find(['/', '?', '#', '"', '\'', ' ', '`', ')', ',']).unwrap_or(rest.len());
    let authority = &rest[..authority_ends];
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = match authority.strip_prefix('[') {
        Some(_) => None,
        None => authority.split(':').next(),
    };
    let host = host.filter(|host| {
        !host.is_empty()
            && host.chars().all(|letter| letter.is_ascii_alphanumeric() || matches!(letter, '.' | '-' | '_'))
    });
    Some(Address { scheme, host })
}

fn installed_package(literal: &str) -> Option<&str> {
    let literal = literal.trim();
    if literal.contains(char::is_whitespace) {
        return None;
    }
    let installed = match literal.split_once("node_modules/") {
        Some((_, rest)) => rest,
        None if literal.starts_with('@') && !literal.contains('.') => literal,
        None => return None,
    };
    let mut segments = installed.split('/');
    let first = segments.next().filter(|first| !first.is_empty())?;
    match (first.starts_with('@'), segments.next().filter(|name| !name.is_empty())) {
        (true, Some(name)) => installed.get(..first.len() + 1 + name.len()),
        _ => Some(first),
    }
}

fn holds_a_connection(value: &str) -> bool {
    value.contains("://") || value.split(';').filter(|pair| pair.split_once('=').is_some_and(|(key, held)| !key.trim().is_empty() && !held.trim().is_empty())).count() >= 2
}

fn shaped_like_a_setting(named: &str) -> bool {
    named.len() > 2
        && named.bytes().all(|letter| letter.is_ascii_uppercase() || letter.is_ascii_digit() || letter == b'_')
}

fn beyond_the_system(host: &str) -> bool {
    let lowered = host.to_ascii_lowercase();
    if !lowered.contains('.') || lowered.parse::<std::net::Ipv4Addr>().is_ok() {
        return false;
    }
    let tld = lowered.rsplit('.').next().unwrap_or("");
    if NEVER_A_SERVICE_TLD.contains(&tld) || tld.chars().any(|letter| letter.is_ascii_digit()) {
        return false;
    }
    !NEVER_A_SERVICE
        .iter()
        .any(|held| lowered == *held || lowered.ends_with(&format!(".{held}")))
}

fn read_at_run_time(path: &str) -> bool {
    let named = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let settings = (named.starts_with("appsettings") && named.ends_with(".json"))
        || (named.starts_with("application") && [".yml", ".yaml", ".properties"].iter().any(|ending| named.ends_with(ending)));
    settings && !crate::paths::is_test(path)
}

fn serves_sites(path: &str) -> bool {
    let named = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    named == "caddyfile" || named.ends_with(".caddyfile") || named == "nginx.conf" || (named.ends_with(".conf") && path.to_ascii_lowercase().contains("nginx"))
}

fn sites_in(text: &str) -> Vec<String> {
    let mut sites = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(named) = trimmed.strip_prefix("server_name") {
            sites.extend(named.trim_end_matches(';').split_whitespace().map(str::to_string));
        } else if !line.starts_with(char::is_whitespace) && trimmed.ends_with('{') {
            sites.extend(trimmed.trim_end_matches('{').split([',', ' ']).filter(|site| !site.is_empty()).map(str::to_string));
        }
    }
    sites
        .into_iter()
        .filter_map(|site| {
            let host = site.split("://").last()?.split(['/', ':']).next()?.trim_start_matches("*.").to_string();
            (host.contains('.') && host.chars().all(|letter| letter.is_ascii_alphanumeric() || letter == '.' || letter == '-')).then_some(host)
        })
        .collect()
}

fn served_here(root: &Path, paths: &[&str]) -> HashSet<String> {
    paths
        .iter()
        .filter(|path| serves_sites(path) && !crate::paths::is_test(path))
        .filter_map(|path| {
            let absolute = crate::paths::kept_inside(root, Path::new(path))?;
            let small = std::fs::metadata(&absolute).is_ok_and(|held| held.len() <= SETTINGS_FILE_AT_MOST);
            small.then(|| std::fs::read_to_string(&absolute).ok()).flatten()
        })
        .flat_map(|text| sites_in(&text))
        .map(|host| registered(&host))
        .collect()
}

fn registered(host: &str) -> String {
    let labels: Vec<&str> = host.trim_end_matches('.').split('.').collect();
    let country = labels.last().is_some_and(|last| last.len() == 2);
    let second_level = labels.len() >= 3 && labels[labels.len() - 2].len() <= 3;
    let kept = if country && second_level { 3 } else { 2 };
    labels[labels.len().saturating_sub(kept)..].join(".").to_ascii_lowercase()
}

fn settings_files<'p>(paths: &[&'p str]) -> Vec<(u32, &'p str)> {
    paths
        .iter()
        .enumerate()
        .filter(|(_, path)| {
            let basename = path.rsplit('/').next().unwrap_or(path);
            basename == ".env" || basename.starts_with(".env.") || basename.ends_with(".env")
        })
        .filter(|(_, path)| !crate::paths::is_test(path))
        .map(|(at, path)| (at as u32, *path))
        .collect()
}

fn settings_written_in(root: &Path, path: &str) -> Vec<(u32, String, String)> {
    let absolute = crate::paths::kept_inside(root, Path::new(path)).unwrap_or_default();
    let small = std::fs::metadata(&absolute).is_ok_and(|held| held.len() <= SETTINGS_FILE_AT_MOST);
    let Some(text) = small.then(|| std::fs::read_to_string(&absolute).ok()).flatten() else {
        return Vec::new();
    };
    text.lines()
        .enumerate()
        .filter_map(|(at, line)| {
            let line = line.trim();
            let line = line.strip_prefix("export ").unwrap_or(line);
            if line.starts_with('#') {
                return None;
            }
            let (named, value) = line.split_once('=')?;
            let named = named.trim();
            let plainly = !named.is_empty()
                && named.chars().all(|letter| letter.is_ascii_alphanumeric() || letter == '_');
            plainly.then(|| (at as u32 + 1, named.to_string(), value.trim().trim_matches(['"', '\'']).to_string()))
        })
        .collect()
}

pub struct Found {
    pub services: Vec<Service>,
    pub serving: HashMap<String, String>,
}

static PIPELINES: &[&str] = &[
    ".gitlab-ci.yml", ".travis.yml", "appveyor.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "ci.yml",
    "cloudbuild.yaml", "cloudbuild.yml", "codemagic.yaml", "jenkinsfile",
];

fn builds_the_repository(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    let named = lowered.rsplit('/').next().unwrap_or(&lowered);
    lowered.starts_with(".github/")
        || lowered.contains("/.github/")
        || lowered.starts_with(".circleci/")
        || lowered.starts_with(".buildkite/")
        || lowered.starts_with("eng/pipelines/")
        || PIPELINES.contains(&named)
        || (named.starts_with("azure-pipelines") && (named.ends_with(".yml") || named.ends_with(".yaml")))
}

pub fn derive(sources: &Sources) -> Found {
    let project_of_file: HashMap<u32, &str> = sources
        .nodes
        .iter()
        .filter(|node| node.kind == NodeKind::Module)
        .filter_map(|node| Some((node.file, node.project.as_deref()?)))
        .collect();
    let mut gathering = Gathering { held: BTreeMap::new(), project_of_file };
    let ours = served_here(sources.root, sources.paths);
    let outside = |host: &str| beyond_the_system(host) && !ours.contains(&registered(host));
    let set_aside: Vec<bool> = sources
        .paths
        .iter()
        .enumerate()
        .map(|(at, path)| sources.not_ours.get(at).copied().unwrap_or(false) || crate::paths::is_test(path) || crate::paths::is_not_shipped(path) || builds_the_repository(path))
        .collect();
    let structured: Vec<bool> = sources
        .paths
        .iter()
        .map(|path| {
            let lowered = path.to_ascii_lowercase();
            [".yml", ".yaml", ".json", ".toml"].iter().any(|ending| lowered.ends_with(ending))
        })
        .collect();
    let tested = |file: u32| set_aside.get(file as usize).copied().unwrap_or(true);
    let tested_at = |file: u32, line: u32| tested(file) || sources.set_aside.holds(file, line);

    if let Some(dependencies) = sources.dependencies {
        for dependency in &dependencies.dependencies {
            if let Some(known) = service_catalog::by_package(&dependency.name) {
                gathering.note(known, "package", &dependency.name, None, 0);
                let held = gathering.held.get_mut(known.name).expect("noted");
                held.projects.extend(dependency.projects.iter().cloned());
            }
        }
    }
    for import in sources.imports.iter().filter(|import| !tested_at(import.file, import.line)) {
        if let Some(known) = service_catalog::by_package(&import.specifier) {
            gathering.note(known, "import", &import.specifier, Some(import.file), import.line);
        }
    }

    let reaches_the_network: HashSet<u32> =
        sources.exits.iter().filter(|exit| matches!(exit.kind, "api" | "network")).map(|exit| exit.file).collect();
    let mut exits_at: HashMap<(u32, u32), Vec<&ExitPoint>> = HashMap::default();
    for exit in sources.exits.iter().filter(|exit| !tested_at(exit.file, exit.line)) {
        exits_at.entry((exit.file, exit.line)).or_default().push(exit);
        if let Some(known) = service_catalog::by_package(&exit.target) {
            gathering.note(known, "call", &exit.name, Some(exit.file), exit.line);
            gathering.held.get_mut(known.name).expect("noted").reached_by.insert(exit.id.clone());
        } else if let Some(named) = exit.service.as_deref().filter(|_| exit.kind == "api") {
            gathering.note_unknown(named, "sdk", &exit.target, Some(exit.file), exit.line);
            gathering.held.get_mut(named).expect("noted").reached_by.insert(exit.id.clone());
        }
    }

    let launching: HashSet<&str> = sources
        .exits
        .iter()
        .filter(|exit| exit.kind == "process" && !tested_at(exit.file, exit.line))
        .filter_map(|exit| gathering.project_of_file.get(&exit.file).copied())
        .collect();
    let into_installed_packages: HashSet<(u32, &str)> = sources
        .calls
        .iter()
        .filter(|call| call.literals.iter().any(|literal| literal.contains("node_modules")))
        .map(|call| (call.file, call.caller.as_deref().unwrap_or("")))
        .collect();
    for call in sources.calls.iter().filter(|call| !tested_at(call.file, call.line)) {
        let launches_programs = gathering.project_of_file.get(&call.file).is_some_and(|project| launching.contains(project));
        for literal in call.literals.iter().filter(|_| launches_programs) {
            let pathed = literal.contains("node_modules/") || into_installed_packages.contains(&(call.file, call.caller.as_deref().unwrap_or("")));
            if let Some(known) = installed_package(literal).filter(|_| pathed).and_then(service_catalog::by_package) {
                gathering.note(known, "program", literal, Some(call.file), call.line);
            }
        }
        let asks_the_environment = ASKS_THE_ENVIRONMENT
            .contains(&crate::names::leaf(&call.callee).to_ascii_lowercase().as_str())
            && call.receiver.as_deref().is_some_and(|within| {
                let lowered = within.to_ascii_lowercase();
                lowered.contains("env") || lowered == "os" || lowered == "std::env"
            })
            || matches!(crate::names::leaf(&call.callee), "getenv" | "Getenv" | "GetEnvironmentVariable");
        for literal in &call.literals {
            if !asks_the_environment && !literal.contains("://") {
                continue;
            }
            if asks_the_environment
                && let Some(known) = service_catalog::by_setting(literal)
            {
                gathering.note(known, "setting", literal, Some(call.file), call.line);
            }
            let Some(address) = address_in(literal) else { continue };
            let exits = exits_at.get(&(call.file, call.line));
            let reached = |gathering: &mut Gathering, named: &str| {
                if let Some(exits) = exits {
                    let held = gathering.held.get_mut(named).expect("noted");
                    held.reached_by.extend(exits.iter().map(|exit| exit.id.clone()));
                }
            };
            if let Some(known) = service_catalog::by_scheme(address.scheme) {
                gathering.note(known, "connection", literal, Some(call.file), call.line);
                reached(&mut gathering, known.name);
                continue;
            }
            if !NETWORK_SCHEMES.contains(&address.scheme.to_ascii_lowercase().as_str()) {
                continue;
            }
            let Some(host) = address.host else { continue };
            if a_page_for_people(literal, &address) {
                continue;
            }
            if let Some(known) = service_catalog::by_host(host).filter(|_| exits.is_some() || reaches_the_network.contains(&call.file)) {
                gathering.note(known, "endpoint", literal, Some(call.file), call.line);
                reached(&mut gathering, known.name);
            } else if exits.is_some_and(|exits| exits.iter().any(|exit| exit.kind == "api"))
                && outside(host)
            {
                let host = host.to_ascii_lowercase();
                gathering.note_unknown(&host, "endpoint", literal, Some(call.file), call.line);
                reached(&mut gathering, &host);
            }
        }
    }

    for read in sources.settings.iter().filter(|read| !tested_at(read.file, read.line)) {
        if let Some(known) = service_catalog::by_setting(&read.name) {
            gathering.note(known, "setting", &read.name, Some(read.file), read.line);
        }
    }

    let children_named: HashSet<(&str, &str)> = sources
        .nodes
        .iter()
        .filter(|node| node.name == "build" && structured.get(node.file as usize).copied().unwrap_or(false))
        .filter_map(|node| Some((node.parent.as_deref()?, node.name.as_str())))
        .collect();
    for node in sources.nodes.iter() {
        if tested_at(node.file, node.span.line) || !structured.get(node.file as usize).copied().unwrap_or(false) {
            continue;
        }
        let value = node.type_annotation.as_deref().unwrap_or("").trim().trim_matches(['"', '\'']);
        if node.name == "image" && !value.is_empty() && !value.contains(char::is_whitespace) {
            let built_here = node
                .parent
                .as_deref()
                .is_some_and(|parent| children_named.contains(&(parent, "build")));
            if !built_here && let Some(known) = service_catalog::by_image(value) {
                gathering.note(known, "image", value, Some(node.file), node.span.line);
            }
            continue;
        }
        let (named, value) = match value.split_once('=') {
            Some((named, rest)) if node.name.chars().all(|letter| letter.is_ascii_digit()) => (named, rest),
            _ => (node.name.as_str(), value),
        };
        let configured = match shaped_like_a_setting(named) {
            true => service_catalog::by_setting(named),
            false => service_catalog::by_setting_exactly(named).filter(|_| holds_a_connection(value)),
        };
        if let Some(known) = configured {
            gathering.note(known, "setting", named, Some(node.file), node.span.line);
        }
        if let Some(address) = value.contains("://").then(|| address_in(value)).flatten() {
            if let Some(known) = service_catalog::by_scheme(address.scheme) {
                gathering.note(known, "connection", value, Some(node.file), node.span.line);
            } else if NETWORK_SCHEMES.contains(&address.scheme.to_ascii_lowercase().as_str())
                && let Some(host) = address.host
            {
                let setting = sources.paths.get(node.file as usize).is_some_and(|path| read_at_run_time(path));
                match service_catalog::by_host(host) {
                    Some(known) if setting || !a_page_for_people(value, &address) => gathering.note(known, "endpoint", value, Some(node.file), node.span.line),
                    None if setting && outside(host) => gathering.note_unknown(&registered(host), "configured endpoint", named, Some(node.file), node.span.line),
                    _ => {}
                }
            }
        }
    }

    for (file, path) in settings_files(sources.paths) {
        for (line, named, value) in settings_written_in(sources.root, path) {
            if let Some(known) = service_catalog::by_setting(&named) {
                gathering.note(known, "setting", &named, Some(file), line);
            }
            let Some(address) = address_in(&value) else { continue };
            if let Some(known) = service_catalog::by_scheme(address.scheme) {
                gathering.note(known, "connection", &named, Some(file), line);
            } else if let Some(host) = address.host {
                match service_catalog::by_host(host) {
                    Some(known) => gathering.note(known, "endpoint", &named, Some(file), line),
                    None if outside(host) => gathering.note_unknown(&registered(host), "configured endpoint", &named, Some(file), line),
                    None => {}
                }
            }
        }
    }

    let reached: HashSet<&str> = gathering
        .held
        .values()
        .flat_map(|held| held.reached_by.iter().map(String::as_str))
        .collect::<HashSet<_>>();
    let reached: HashSet<String> = reached.into_iter().map(str::to_string).collect();
    for (reached_as, kind) in [("database", "database"), ("cache", "cache"), ("message", "messaging")] {
        let standing: Vec<String> = gathering
            .held
            .iter()
            .filter(|(named, held)| {
                held.known
                    && service_catalog::SERVICES
                        .iter()
                        .find(|known| known.name == named.as_str())
                        .is_some_and(|known| known.kind == kind)
                    && STANDS_A_SERVICE_UP.iter().any(|how| held.counted.contains_key(how))
            })
            .map(|(named, _)| named.clone())
            .collect();
        let [only] = standing.as_slice() else { continue };
        let through: Vec<&ExitPoint> = sources
            .exits
            .iter()
            .filter(|exit| exit.kind == reached_as && !tested_at(exit.file, exit.line) && !reached.contains(&exit.id))
            .collect();
        if through.is_empty() {
            continue;
        }
        let held = gathering.held.get_mut(only).expect("standing");
        *held.counted.entry("through the data layer").or_insert(0) += through.len() as u32;
        held.reached_by.extend(through.iter().map(|exit| exit.id.clone()));
    }

    let mut serving: HashMap<String, String> = HashMap::default();
    for (name, held) in &gathering.held {
        for exit in &held.reached_by {
            serving.entry(exit.clone()).or_insert_with(|| name.clone());
        }
    }
    let mut services: Vec<Service> = gathering
        .held
        .into_iter()
        .filter(|(_, held)| held.counted.keys().any(|how| *how != "package"))
        .map(|(name, held)| {
            let reached = held.reached_by.len() as u32;
            Service {
                id: format!("service:{}", name.to_ascii_lowercase().replace(' ', "-")),
                name,
                kind: held.kind,
                known: held.known,
                evidenced: held.counted.into_iter().map(|(how, count)| (how.to_string(), count)).collect(),
                evidence: held.evidence,
                reached_by: held.reached_by.into_iter().take(REACHES_KEPT).collect(),
                reached,
                projects: held.projects.into_iter().collect(),
            }
        })
        .collect();
    services.sort_by(|left, right| {
        right.known.cmp(&left.known).then(left.kind.cmp(right.kind)).then(left.name.cmp(&right.name))
    });
    Found { services, serving }
}

#[cfg(test)]
mod tests {

    #[test]
    fn the_sites_a_web_server_serves_are_the_system_s_own() {
        let caddy = "{\n\temail ops@shop.example.org\n}\n\napp.shop.io {\n\troot * /srv\n}\n\napi.shop.io, www.shop.io {\n\treverse_proxy api:8080\n}\n";
        assert_eq!(super::sites_in(caddy), ["app.shop.io", "api.shop.io", "www.shop.io"]);
        assert_eq!(super::sites_in("server {\n    server_name shop.io *.shop.io;\n}\n"), ["shop.io", "shop.io"]);
    }

    #[test]
    fn an_outside_host_is_named_by_the_domain_it_is_registered_under() {
        assert_eq!(super::registered("api.sandbox.fortressapi.com"), "fortressapi.com");
        assert_eq!(super::registered("bo-api.drivewealth.io"), "drivewealth.io");
        assert_eq!(super::registered("api.example.co.uk"), "example.co.uk");
        assert_eq!(super::registered("plaid.com"), "plaid.com");
    }

    #[test]
    fn settings_a_program_reads_when_it_runs_are_where_its_outside_addresses_live() {
        assert!(super::read_at_run_time("Finance.Presentation.WebApi/appsettings.json"));
        assert!(super::read_at_run_time("src/main/resources/application-prod.yml"));
        assert!(!super::read_at_run_time("package.json"));
        assert!(!super::read_at_run_time("tests/Api.Tests/appsettings.json"));
    }

    #[test]
    fn a_pipeline_that_builds_the_repository_says_nothing_of_what_the_system_uses() {
        assert!(super::builds_the_repository(".github/workflows/test.yml"));
        assert!(super::builds_the_repository("ci.yml"));
        assert!(super::builds_the_repository("azure-pipelines-pr.yaml"));
        assert!(!super::builds_the_repository("deploy/docker-compose.yml"));
        assert!(!super::builds_the_repository("src/config/settings.yml"));
    }

    use super::*;

    #[test]
    fn an_address_names_its_scheme_and_host() {
        let held = address_in("postgres://user:secret@db.internal:5432/app").unwrap();
        assert_eq!((held.scheme, held.host), ("postgres", Some("db.internal")));
        let held = address_in("fetch(\"https://api.stripe.com/v1/charges\")").unwrap();
        assert_eq!((held.scheme, held.host), ("https", Some("api.stripe.com")));
        let held = address_in("redis://${REDIS_HOST}:6379").unwrap();
        assert_eq!((held.scheme, held.host), ("redis", None));
        assert!(address_in("no address here").is_none());
    }

    #[test]
    fn a_path_into_an_installed_package_names_the_package() {
        assert_eq!(installed_package("node_modules/@anthropic-ai/claude-agent-sdk-win32-x64"), Some("@anthropic-ai/claude-agent-sdk-win32-x64"));
        assert_eq!(installed_package("engines/node_modules/stripe/bin/cli.js"), Some("stripe"));
        assert_eq!(installed_package("@openai"), Some("@openai"));
        assert_eq!(installed_package("me@openai.com"), None);
        assert_eq!(installed_package("run the installer"), None);
        assert_eq!(installed_package("node_modules/@a//é"), Some("@a"));
        assert_eq!(installed_package("node_modules/@é/ü/bin"), Some("@é/ü"));
    }

    #[test]
    fn a_plain_key_names_a_service_only_when_it_holds_a_connection() {
        assert!(holds_a_connection("Host=localhost;Database=orders;Username=app"));
        assert!(holds_a_connection("amqp://localhost"));
        assert!(!holds_a_connection("Discord"));
        assert!(!holds_a_connection("AssetCreate"));
    }

    #[test]
    fn a_page_for_people_is_not_an_endpoint() {
        let read = |text: &str| a_page_for_people(text, &address_in(text).unwrap());
        assert!(read("https://discord.com/"));
        assert!(read("https://paypal.com"));
        assert!(read("https://elevenlabs.io/docs/guides/cal-com"));
        assert!(!read("https://api.stripe.com/v1/charges"));
        assert!(!read("https://discord.com/api/webhooks/1"));
    }

    #[test]
    fn a_host_beyond_the_system_is_one_nobody_here_runs() {
        assert!(beyond_the_system("api.acme-payments.io"));
        assert!(!beyond_the_system("localhost"));
        assert!(!beyond_the_system("db"));
        assert!(!beyond_the_system("127.0.0.1"));
        assert!(!beyond_the_system("app.test"));
        assert!(!beyond_the_system("www.w3.org"));
        assert!(!beyond_the_system("github.com"));
    }
}
